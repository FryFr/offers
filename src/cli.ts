import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planNotionSync, upsertNotionRecords, validateNotionConfig, type HttpTransport, type SyncOptions } from './notion-sync.ts';
import { randomUUID } from 'node:crypto';
import { parseProfile } from './contracts.ts';
import { ingest, parseStore, report, type Store } from './pipeline.ts';

const help = `Offers: entrada manual local; Notion opcional y desactivado por defecto.
Uso: npm start -- --input examples/opportunities.json [--profile examples/profile.json]
       [--state data/offers.json] [--output output/report.json] [--now 2026-09-16T12:00:00Z]
[--notion-dry-run | --notion-sync] --notion-config archivo.json
--notion-sync exige enabled:true y --notion-transport modulo-local.mjs (export transport).
El módulo puede exportar revalidate(opportunity, signal) para comprobar disponibilidad.
--notion-dry-run genera el plan local sin cargar transporte ni usar red.
--input - lee JSON desde stdin. Sin --output, imprime el reporte en stdout.
Solo verified se recomienda/sincroniza: publicación verificable de hoy o hace 1-3 días UTC.
Hoy tiene prioridad. >3 días: stale; cerrada/404/410/desaparecida: unavailable.
Sin fecha/evidencia, respuesta ambigua, timeout o verificación vencida: unknown.
La disponibilidad exige evidencia explícita de ficha abierta y HTTP 200; vigencia <24h.
Migración: añadir publishedAt, publicationEvidence y availability tras verificarlos.
Ejemplos/estados históricos se conservan sin verificación automática; history retiene cambios.
Sync usa reloj real (no --now), revalida si hay adaptador y bloquea antes de llamar a Notion.
No ejecutar dos escritores simultáneamente sobre el mismo estado.`;

async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')); }
async function atomicWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(help); return; }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (['--notion-dry-run', '--notion-sync'].includes(key)) {
      if (options.has(key)) throw new Error('Modo Notion duplicado');
      options.set(key, 'true'); continue;
    }
    const value = args[++i];
    if (!['--input', '--profile', '--state', '--output', '--now', '--notion-config', '--notion-transport'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error(`Argumento inválido\n${help}`);
    options.set(key, value);
  }
  const dryRun = options.has('--notion-dry-run');
  const sync = options.has('--notion-sync');
  if (dryRun && sync) throw new Error('Modos Notion excluyentes');
  const configPath = options.get('--notion-config');
  const transportPath = options.get('--notion-transport');
  if ((dryRun || sync) !== !!configPath || (transportPath && !sync)) throw new Error('Configuración Notion explícita requerida');
  let config;
  if (configPath) {
    try { config = validateNotionConfig(await readJson(configPath)); }
    catch { throw new Error('Configuración Notion inválida'); }
  }
  if (sync && (!config?.enabled || !transportPath)) throw new Error('Sync requiere enabled:true y transporte explícito');
  const inputPath = options.get('--input');
  if (!inputPath) throw new Error(help);
  const statePath = resolve(options.get('--state') ?? 'data/offers.json');
  const outputPath = options.get('--output') ? resolve(options.get('--output')!) : undefined;
  const profilePath = options.get('--profile');
  const protectedPaths = [inputPath === '-' ? undefined : resolve(inputPath), profilePath ? resolve(profilePath) : undefined, configPath ? resolve(configPath) : undefined, transportPath ? resolve(transportPath) : undefined].filter(Boolean);
  if (protectedPaths.includes(statePath) || (outputPath && (outputPath === statePath || protectedPaths.includes(outputPath)))) throw new Error('Los archivos de entrada, perfil, estado y salida deben usar rutas distintas');
  const dateArg = options.get('--now');
  if (dateArg && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(dateArg)) throw new Error('--now requiere timestamp UTC ISO 8601');
  const now = dateArg ? new Date(dateArg) : new Date();
  if (!Number.isFinite(now.getTime()) || (dateArg && now.toISOString().replace('.000Z', 'Z') !== dateArg.replace('.000Z', 'Z'))) throw new Error('--now inválido');
  const profile = parseProfile(profilePath ? await readJson(profilePath) : {});
  let input: unknown;
  if (inputPath === '-') {
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
    input = JSON.parse(text);
  } else input = await readJson(inputPath);
  let store: Store = { version: 1, records: [] };
  try { store = parseStore(await readJson(statePath)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let next = ingest(store, input);
  const result = report(next, profile, now);
  let output: unknown = result;
  if (dryRun) output = { ...result, notionPlan: planNotionSync(result.notion.records, config, now) };
  if (sync) {
    let transport: HttpTransport;
    let revalidate: SyncOptions['revalidate'];
    try {
      const module = await import(pathToFileURL(resolve(transportPath!)).href);
      if (typeof module.transport !== 'function') throw new Error();
      transport = module.transport;
      if (module.revalidate !== undefined && typeof module.revalidate !== 'function') throw new Error();
      revalidate = module.revalidate;
    } catch { throw new Error('Transporte Notion no disponible'); }
    const notionSync = await upsertNotionRecords(result.notion.records, config, transport, { revalidate });
    next = ingest(next, notionSync.records.flatMap(r => r.opportunity ? [r.opportunity] : []));
    output = { ...report(next, profile, new Date()), notionSync };
    if (notionSync.failed) process.exitCode = 1;
  }
  // Each file is atomic. They are not a shared transaction; rerunning repairs output.
  if (outputPath) await atomicWrite(outputPath, output);
  await atomicWrite(statePath, next);
  if (!outputPath) console.log(JSON.stringify(output, null, 2));
}
main().catch(error => { console.error(`Offers: ${(error as Error).message}`); process.exitCode = 1; });
