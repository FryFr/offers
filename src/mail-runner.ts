import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { adaptExternalAlertEnvelope, type ExternalAlertEnvelope } from './external-alerts.ts';
import { parseLinkedInEmail } from './linkedin-email.ts';

export type Command = (executable: string, args: string[]) => string;
type HimalayaResult = { error?: NodeJS.ErrnoException | null; signal?: NodeJS.Signals | null; status?: number | null; stdout: string };
/** Pure result→error mapping, split out so timeout/maxBuffer branches are testable without a real 30s wait or an 8MB write. */
export function interpretHimalayaResult(result: HimalayaResult): string {
  // Backend stderr can contain credentials or private message data: never echo it.
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') throw new Error('Himalaya: tiempo de espera agotado (30s); sin cambios al cursor');
    if (result.error.code === 'ENOBUFS') throw new Error('Himalaya: salida excede el límite de buffer (8MB); sin cambios al cursor');
    throw new Error('Himalaya: no se pudo ejecutar el binario (comprueba instalación y PATH; sin cambios al cursor)');
  }
  if (result.signal) throw new Error(`Himalaya: proceso interrumpido por señal ${result.signal} (posible timeout; sin cambios al cursor)`);
  if (result.status !== 0) throw new Error(`Himalaya: salió con código ${result.status} (comprueba cuenta y acceso al llavero; sin cambios al cursor)`);
  return result.stdout;
}
export const himalayaCommand: Command = (executable, args) => {
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return interpretHimalayaResult(result);
};
export interface MailRunnerOptions {
  account: string;
  mailbox?: string;
  limit?: number;
  cursorPath: string;
  executable?: string;
}
interface Pending { ids: string[]; envelope: ExternalAlertEnvelope }
export interface MailCursor { schemaVersion: 1; scope: string; processed: string[]; pending?: Pending }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f]/.test(v);
function ids(value: unknown): value is string[] { return Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length; }
export async function loadMailCursor(path: string, scope: string): Promise<MailCursor> {
  let stored;
  try { stored = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, scope, processed: [] }; throw new Error('Cursor ilegible; no se reinicia automáticamente'); }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Cursor inválido');
  const { checksum, ...core } = stored;
  if (checksum !== hash(core) || core.schemaVersion !== 1 || core.scope !== scope || !ids(core.processed)
    || Object.keys(core).some(key => !['schemaVersion', 'scope', 'processed', 'pending'].includes(key))) throw new Error('Cursor inválido: checksum, versión o cuenta/buzón distintos');
  if (core.pending !== undefined) {
    const pending = core.pending;
    if (!pending || !ids(pending.ids) || !pending.ids.length || pending.ids.some((id: string) => core.processed.includes(id))
      || Object.keys(pending).sort().join(',') !== 'envelope,ids') throw new Error('Cursor: lote pendiente inválido');
    adaptExternalAlertEnvelope(pending.envelope);
  }
  return core as MailCursor;
}

/** Same-directory replace, fsync both file and directory; injectable rename for failure tests. */
export async function atomicMailWrite(path: string, value: unknown, replace: typeof rename = rename): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await replace(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
const saveCursor = (path: string, cursor: MailCursor) => atomicMailWrite(path, { ...cursor, checksum: hash(cursor) });

/** Exclusive lock is never stolen automatically; a crash requires operator recovery. */
export async function withMailLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  let lock;
  try { lock = await open(`${path}.lock`, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Correo/estado ocupado: existe .lock; revisa si hay otra ejecución'); throw error; }
  try { await lock.writeFile(`${process.pid}\n`); return await run(); }
  finally { await lock.close(); await rm(`${path}.lock`, { force: true }); }
}

/** Delivery is at least once. Resolve only after durable consumption; replay must be idempotent. */
export async function runMailAlerts(options: MailRunnerOptions, deliver: (envelope: ExternalAlertEnvelope) => Promise<void>, command: Command = himalayaCommand): Promise<void> {
  const { account, cursorPath } = options;
  const mailbox = options.mailbox ?? 'INBOX';
  const limit = options.limit ?? 50;
  if (!identifier(account) || !identifier(mailbox) || account.startsWith('-') || mailbox.startsWith('-')
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Correo: cuenta, buzón o límite inválidos (1–1000)');
  const executable = options.executable ?? 'himalaya';
  if (!identifier(executable) || executable.startsWith('-')) throw new Error('Ejecutable Himalaya inválido');
  const path = resolve(cursorPath);
  const scope = hash([account, mailbox]);
  await withMailLock(path, async () => {
    let cursor = await loadMailCursor(path, scope);
    if (!cursor.pending) {
      // Version gate matters: v1 read marks Seen unless --preview; v2 read does not.
      if (!/^himalaya v?2\.1\.0\b/m.test(command(executable, ['--version']))) throw new Error('Himalaya 2.1.0 requerido para garantizar lectura sin Seen');
      const common = ['--account', account, '--mailbox', mailbox];
      const processed = new Set(cursor.processed);
      const selected: string[] = [];
      const listed = new Set<string>();
      const envelope: ExternalAlertEnvelope = { schemaVersion: 1, alerts: [] };
      // Scan beyond already-processed pages so a first-run backlog is never stranded.
      for (let page = 1; selected.length < limit; page++) {
        if (page > 10000) throw new Error('Buzón excede límite de paginación; usa un buzón dedicado');
        const raw = command(executable, ['envelope', 'list', ...common, '--page', String(page), '--page-size', '100', '--json']);
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch (error) { if (error instanceof SyntaxError) throw new Error('Himalaya: no se pudo listar el buzón como JSON'); throw error; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Himalaya: lista de envelopes inválida');
        const items: unknown = (parsed as { envelopes: unknown }).envelopes;
        if (!Array.isArray(items)) throw new Error('Himalaya: lista de envelopes inválida');
        if (!items.length) break;
        let newIds = 0;
        for (const item of items) {
          const id: unknown = item?.id;
          if (!identifier(id) || id.startsWith('-')) throw new Error('Himalaya: ID de mensaje inválido');
          if (listed.has(id)) continue;
          listed.add(id); newIds++;
          if (processed.has(id)) continue;
          const raw = command(executable, ['message', 'read', ...common, '--raw', '--', id]);
          const parsed = parseLinkedInEmail(raw);
          if (parsed.status === 'unrecognized') throw new Error('Alerta LinkedIn no reconocida; cursor sin avanzar. Añade un fixture sanitizado para ampliar el parser');
          selected.push(id);
          envelope.alerts.push(...parsed.envelope.alerts);
          if (selected.length === limit) break;
        }
        if (!newIds) throw new Error('Himalaya: paginación repetida; cursor sin avanzar');
        if (items.length < 100) break;
      }
      adaptExternalAlertEnvelope(envelope);
      if (!selected.length) { await deliver(envelope); return; }
      cursor = { ...cursor, pending: { ids: selected, envelope } };
      await saveCursor(path, cursor);
    }
    // Do not expose the cursor's pending object to a mutating consumer.
    await deliver(structuredClone(cursor.pending!.envelope));
    const committed: MailCursor = { schemaVersion: 1, scope, processed: [...cursor.processed, ...cursor.pending!.ids] };
    await saveCursor(path, committed);
  });
}
