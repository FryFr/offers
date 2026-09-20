import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { adaptExternalAlertEnvelope } from './external-alerts.ts';
import { parseProfile } from './contracts.ts';
import { ingest, parseStore, report, type Store } from './pipeline.ts';
import { atomicMailWrite, runMailAlerts, withMailLock } from './mail-runner.ts';

export const mailHelp = `Ingestión incremental de alertas LinkedIn (Himalaya 2.1.0, sin Seen).
node src/cli.ts mail-alerts --account personal [--mailbox INBOX] [--limit 50]
  [--cursor data/mail-cursor.json] [--himalaya /opt/homebrew/bin/himalaya]
  [--output output/alerts.json]
  [--ingest --state data/offers.json --report output/report.json
    --profile examples/profile.json --now 2026-09-17T12:00:00Z]
Sin --output, stdout contiene solo el envelope {schemaVersion:1,alerts:[...]}.
--ingest guarda estado y reporte locales antes de confirmar el cursor.
Sin --ingest, la confirmación solo garantiza entrega a archivo/stdout, no al consumidor remoto.
Un fallo conserva el lote pendiente para reintento. No hay candidaturas ni sync Notion.
Notion se activa por separado con los flags explícitos del flujo --input.`;
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    return parent === path ? path : join(await canonical(parent), path.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
  }
}
async function distinct(paths: string[]): Promise<void> {
  const canonicalPaths = await Promise.all(paths.map(canonical));
  const inodes: string[] = [];
  for (const path of paths) {
    try { const s = await stat(path); inodes.push(`${s.dev}:${s.ino}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (new Set(canonicalPaths).size !== paths.length || new Set(inodes).size !== inodes.length
    || canonicalPaths.some((path, i) => canonicalPaths.some((other, j) => i !== j && other.startsWith(`${path}/`)))) throw new Error('Correo: entradas, cursor, estado, locks y salidas deben usar rutas distintas');
}
export async function mailMain(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { console.log(mailHelp); return; }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (options.has(key)) throw new Error('Correo: argumento duplicado');
    if (key === '--ingest') { options.set(key, 'true'); continue; }
    const value = args[++i];
    if (!['--account', '--mailbox', '--limit', '--cursor', '--himalaya', '--output', '--state', '--report', '--profile', '--now'].includes(key)
      || !value || value.startsWith('--')) throw new Error(mailHelp);
    options.set(key, value);
  }
  const account = options.get('--account');
  if (!account) throw new Error('--account es obligatorio\n' + mailHelp);
  const local = options.has('--ingest');
  if (!local && ['--state', '--report', '--profile', '--now'].some(key => options.has(key))) throw new Error('--state, --report, --profile y --now requieren --ingest');
  const limitText = options.get('--limit') ?? '50';
  if (!/^\d+$/.test(limitText)) throw new Error('--limit requiere entero 1–1000');
  const at = options.get('--now');
  const now = at ? new Date(at) : new Date();
  if (!Number.isFinite(now.getTime()) || (at && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at) || now.toISOString().replace('.000Z', 'Z') !== at.replace('.000Z', 'Z')))) throw new Error('--now requiere timestamp UTC válido');
  const cursor = resolve(options.get('--cursor') ?? 'data/mail-cursor.json');
  const output = options.has('--output') ? resolve(options.get('--output')!) : undefined;
  const state = local ? resolve(options.get('--state') ?? 'data/offers.json') : undefined;
  const reportPath = local ? resolve(options.get('--report') ?? 'output/report.json') : undefined;
  const profilePath = options.has('--profile') ? resolve(options.get('--profile')!) : undefined;
  await distinct([cursor, `${cursor}.lock`, output, state, state ? `${state}.lock` : undefined, reportPath, profilePath,
    options.has('--himalaya') ? resolve(options.get('--himalaya')!) : undefined].filter((path): path is string => !!path));
  const profile = parseProfile(profilePath ? await readJson(profilePath) : {});
  await runMailAlerts({ account, mailbox: options.get('--mailbox'), limit: Number(limitText), cursorPath: cursor, executable: options.get('--himalaya') }, async envelope => {
    if (local) await withMailLock(state!, async () => {
      let store: Store = { version: 1, records: [] };
      try { store = parseStore(await readJson(state!)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const next = ingest(store, adaptExternalAlertEnvelope(envelope));
      await atomicMailWrite(state!, next);
      await atomicMailWrite(reportPath!, report(next, profile, now));
    });
    if (output) await atomicMailWrite(output, envelope);
    else await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      process.stdout.once('error', onError);
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`, error => {
        if (error) reject(error); else { process.stdout.removeListener('error', onError); resolve(); }
      });
    });
  });
}
