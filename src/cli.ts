import { mailMain, mailHelp } from './mail-cli.ts';
import { adaptExternalAlertEnvelope } from './external-alerts.ts';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planNotionSync, upsertNotionRecords, validateNotionConfig, type HttpTransport, type SyncOptions } from './notion-sync.ts';
import { randomUUID } from 'node:crypto';
import { parseProfile, parseOpportunity } from './contracts.ts';
import { captureEvidence, createNodeCaptureFetch } from './evidence-capture.ts';
import { ingest, parseStore, report, type Store } from './pipeline.ts';
import { buildCandidacyBrief, parseCandidateFacts, writeCandidacyBriefs, CANDIDACY_TIERS } from './candidacy.ts';
import { importTracking, loadTrackingStore, saveTrackingStore, trackingReport } from './tracking.ts';

const help = `Offers: entrada manual local; Notion opcional y desactivado por defecto.
Uso: npm start -- --input examples/opportunities.json [--profile examples/profile.json]
       [--state data/offers.json] [--output output/report.json] [--now 2026-09-16T12:00:00Z]
       [--candidate examples/candidate-facts.json] [--candidacy-dir output/candidacy]
Seguimiento local (modo separado):
  npm start -- --tracking-state data/tracking.json --tracking-import eventos.json --tracking-cutoff 2026-09-16T12:00:00Z
  npm start -- --tracking-state data/tracking.json --tracking-record evento.json
  npm start -- --tracking-state data/tracking.json --tracking-report --tracking-cutoff 2026-09-16T12:00:00Z
[--notion-dry-run | --notion-sync] --notion-config archivo.json
--notion-sync exige enabled:true y --notion-transport modulo-local.mjs (export transport).
El módulo puede exportar revalidate(opportunity, signal) para comprobar disponibilidad.
--notion-dry-run genera el plan local sin cargar transporte ni usar red.
--input-format external-alerts adapta el envelope {schemaVersion:1,alerts:[...]}.
--input - lee JSON desde stdin. Sin --output, imprime el reporte en stdout.
--capture-evidence activa una captura HTTP real y opt-in de publishedAt/availability
por oportunidad con url, antes de ingerir. Nunca inventa fecha: solo acepta JSON-LD
JobPosting datePosted cuyo url coincide con el de la oportunidad. Protegido contra
SSRF (bloquea loopback/privadas/link-local/reservadas, revalida cada redirección),
con timeout, límite de tamaño de respuesta y content-type restringido a HTML.
Un fallo de captura por registro no aborta el lote; el registro queda sin cambios.
Solo verified se recomienda/sincroniza: publicación verificable de hoy o hace 1-3 días UTC.
Hoy tiene prioridad. >3 días: stale; cerrada/404/410/desaparecida: unavailable.
Sin fecha/evidencia, respuesta ambigua, timeout o verificación vencida: unknown.
--candidate activa el material de postulación local; --candidacy-dir solo puede usarse con ese flag.
Solo se genera para ofertas strong o possible, las mismas que llegan al tablero; --candidacy-tier weak baja el listón.
Solo genera para verified, no discarded y no ineligible. Nunca envía candidaturas.
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
  if (args[0] === 'mail-alerts') { await mailMain(args.slice(1)); return; }
  if (args.includes('--help')) { console.log(help + '\n\n' + mailHelp); return; }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (['--notion-dry-run', '--notion-sync', '--tracking-report', '--capture-evidence'].includes(key)) {
      if (options.has(key)) throw new Error('Modo Notion duplicado');
      options.set(key, 'true'); continue;
    }
    const value = args[++i];
    if (!['--input-format', '--input', '--profile', '--state', '--output', '--now', '--candidate', '--candidacy-dir', '--candidacy-tier', '--notion-config', '--notion-transport', '--tracking-state', '--tracking-import', '--tracking-record', '--tracking-cutoff'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error(`Argumento inválido\n${help}`);
    options.set(key, value);
  }
  const inputFormat = options.get('--input-format') ?? 'opportunities';
  if (!['opportunities', 'external-alerts'].includes(inputFormat)) throw new Error('--input-format inválido');
  const trackingState = options.get('--tracking-state');
  const trackingImport = options.get('--tracking-import');
  const trackingRecord = options.get('--tracking-record');
  const trackingMode = !!trackingState || !!trackingImport || !!trackingRecord || options.has('--tracking-report') || options.has('--tracking-cutoff');
  if (trackingMode) {
    if (!trackingState || (trackingImport && trackingRecord) || ['--input-format', '--input', '--state', '--profile', '--candidate', '--candidacy-dir', '--candidacy-tier', '--notion-config', '--notion-transport', '--notion-sync', '--notion-dry-run', '--now', '--capture-evidence'].some(key => options.has(key))) throw new Error(`Modo de seguimiento inválido o mezclado con el flujo de ofertas\n${help}`);
    if (!trackingImport && !trackingRecord && !options.has('--tracking-report')) throw new Error('--tracking-state requiere importar, registrar o reportar');
    const cutoffText = options.get('--tracking-cutoff') ?? new Date().toISOString();
    const cutoff = new Date(cutoffText);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(cutoffText) || !Number.isFinite(cutoff.getTime()) || cutoff.toISOString().replace('.000Z', 'Z') !== cutoffText.replace('.000Z', 'Z')) throw new Error('--tracking-cutoff requiere timestamp UTC ISO 8601');
    const path = resolve(trackingState);
    const original = await loadTrackingStore(path);
    let next = original;
    if (trackingImport) next = importTracking(original, await readJson(trackingImport));
    if (trackingRecord) next = importTracking(original, { schemaVersion: 1, events: [await readJson(trackingRecord)] });
    if (next !== original) await saveTrackingStore(path, next, original.revision);
    const output = trackingReport(next, cutoff);
    if (options.get('--output')) await atomicWrite(resolve(options.get('--output')!), output);
    else console.log(JSON.stringify(output, null, 2));
    return;
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
  const candidatePath = options.get('--candidate');
  if (options.has('--candidacy-dir') && !candidatePath) throw new Error('--candidacy-dir requiere --candidate');
  // Escape para bajar el listón a mano. Solo admite `weak`: `off_target` lleva un bloqueo —rol
  // excluido, seniority por debajo del piso o geografía incompatible— y generar material para eso
  // sería redactar una candidatura que el propio ranker ya declaró inaplicable.
  const candidacyTier = options.get('--candidacy-tier');
  if (candidacyTier !== undefined && candidacyTier !== 'weak') throw new Error('--candidacy-tier solo admite weak');
  const candidacyDirectory = candidatePath ? resolve(options.get('--candidacy-dir') ?? 'output/candidacy') : undefined;
  if (candidacyDirectory) {
    const fromDrafts = relative(resolve('drafts'), candidacyDirectory);
    if (!fromDrafts || (!fromDrafts.startsWith('..') && !isAbsolute(fromDrafts))) throw new Error('--candidacy-dir no puede estar dentro de drafts');
  }
  const protectedPaths = [inputPath === '-' ? undefined : resolve(inputPath), profilePath ? resolve(profilePath) : undefined, candidatePath ? resolve(candidatePath) : undefined, configPath ? resolve(configPath) : undefined, transportPath ? resolve(transportPath) : undefined].filter((path): path is string => !!path);
  if (protectedPaths.includes(statePath) || (outputPath && (outputPath === statePath || protectedPaths.includes(outputPath)))) throw new Error('Los archivos de entrada, perfil, estado y salida deben usar rutas distintas');
  if (candidacyDirectory && protectedPaths.includes(candidacyDirectory)) throw new Error('El directorio de candidaturas debe usar una ruta distinta');
  const dateArg = options.get('--now');
  if (dateArg && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(dateArg)) throw new Error('--now requiere timestamp UTC ISO 8601');
  const now = dateArg ? new Date(dateArg) : new Date();
  if (!Number.isFinite(now.getTime()) || (dateArg && now.toISOString().replace('.000Z', 'Z') !== dateArg.replace('.000Z', 'Z'))) throw new Error('--now inválido');
  const profile = parseProfile(profilePath ? await readJson(profilePath) : {});
  const candidate = candidatePath ? parseCandidateFacts(await readJson(candidatePath)) : undefined;
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
  let normalizedInput: unknown = inputFormat === 'external-alerts' ? adaptExternalAlertEnvelope(input) : input;
  if (options.has('--capture-evidence')) {
    const opportunities = (Array.isArray(normalizedInput) ? normalizedInput : [normalizedInput]).map(parseOpportunity);
    const fetch = createNodeCaptureFetch();
    normalizedInput = await Promise.all(opportunities.map(async opportunity => {
      if (!opportunity.url) return opportunity;
      try {
        const captured = await captureEvidence(opportunity, { fetch });
        return { ...opportunity, ...(captured.publishedAt ? { publishedAt: captured.publishedAt } : {}), ...(captured.publicationEvidence ? { publicationEvidence: captured.publicationEvidence } : {}), availability: captured.availability };
      } catch { return opportunity; }
    }));
  }
  let next = ingest(store, normalizedInput);
  let result = report(next, profile, now);
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
    result = report(next, profile, new Date());
    output = { ...result, notionSync };
    if (notionSync.failed) process.exitCode = 1;
  }
  // Each file is atomic. They are not a shared transaction; rerunning repairs output.
  if (candidate && candidacyDirectory) {
    // El tier entra al gate: sin él esto escribe una carpeta por CADA registro verificado del
    // histórico —hoy serían cientos—, y `writeCandidacyBriefs` nunca borra huérfanos, así que el
    // directorio solo crecería. El escape `--candidacy-tier weak` existe para bajar el listón a mano.
    const tiers = candidacyTier ? [...CANDIDACY_TIERS, candidacyTier] : undefined;
    const briefs = result.records.flatMap(record => {
      const brief = buildCandidacyBrief(record, candidate, ...(tiers ? [{ tiers }] : []));
      return brief ? [brief] : [];
    });
    await writeCandidacyBriefs(candidacyDirectory, briefs);
  }
  if (outputPath) await atomicWrite(outputPath, output);
  await atomicWrite(statePath, next);
  if (!outputPath) console.log(JSON.stringify(output, null, 2));
}
main().catch(error => { console.error(`Offers: ${(error as Error).message}`); process.exitCode = 1; });
