import type { report } from './pipeline.ts';
import { identity } from './pipeline.ts';
import { parseAvailability, parseOpportunity, type AvailabilityEvidence, type Opportunity } from './contracts.ts';
import { verification, PUBLICATION_WINDOW_DAYS, type Verification } from './evaluate.ts';

type Projection = ReturnType<typeof report>['notion']['records'][number];
export type NotionRecord = Pick<Projection, 'externalKey' | 'properties'> & { opportunity?: Opportunity };
const calculationContextFields = ['Origin', 'Calculation assumptions', 'Explanation'] as const;
/**
 * Nombres de propiedad que este módulo sabe enviar. Añadir uno aquí SIN crearlo en la base de
 * Notion hace que cada upsert devuelva 400 y `failed` iguale al total: la verificación de esquema
 * de `--sync` es la que debe impedirlo, no la suerte.
 */
const fields = ['Name', 'Company', 'URL', 'Type', 'Expiration', 'Deadline', 'Verification', 'Verification reasons', 'Published', 'Screening', 'Screening reasons', 'Employment eligibility', 'Location', 'Relocation', 'Recommendation rank', 'Recommendation priority', 'Relevance', 'Relevance tier', 'Fit score', 'Economic score', 'Hourly USD', 'Freelance review', ...calculationContextFields] as const;
export interface NotionConfig {
  enabled: boolean;
  dataSourceId?: string;
  databaseId?: string;
  externalKeyProperty: string;
  includeCalculationContext: boolean;
  propertyMap: Partial<Record<typeof fields[number], string>>;
}
export interface HttpRequest { method: 'GET' | 'POST' | 'PATCH'; url: string; headers: Record<string, string>; body: Record<string, unknown> }
export interface HttpResponse { status: number; body: unknown }
/** Authentication belongs to the caller's transport; this module never reads credentials. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const invalid = () => new Error('Configuración Notion inválida');
export function validateNotionConfig(value: unknown): NotionConfig {
  const v = obj(value);
  if (Object.keys(v).some(k => !['enabled', 'dataSourceId', 'databaseId', 'externalKeyProperty', 'includeCalculationContext', 'propertyMap'].includes(k))) throw invalid();
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') throw invalid();
  if (v.includeCalculationContext !== undefined && typeof v.includeCalculationContext !== 'boolean') throw invalid();
  const validId = (id: unknown) => typeof id === 'string' && /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(id);
  if ((v.dataSourceId === undefined) === (v.databaseId === undefined) || !validId(v.dataSourceId ?? v.databaseId)) throw invalid();
  const name = (n: unknown): n is string => typeof n === 'string' && !!n.trim() && n === n.trim() && n.length <= 100;
  if (!name(v.externalKeyProperty)) throw invalid();
  if (v.propertyMap !== undefined && (v.propertyMap === null || typeof v.propertyMap !== 'object' || Array.isArray(v.propertyMap))) throw invalid();
  const map = obj(v.propertyMap);
  if (Object.entries(map).some(([k, n]) => !fields.includes(k as typeof fields[number]) || !name(n))) throw invalid();
  const activeFields = v.includeCalculationContext === true ? fields : fields.filter(k => !calculationContextFields.includes(k as typeof calculationContextFields[number]));
  const names = activeFields.map(k => map[k] ?? k);
  if (new Set([...names, v.externalKeyProperty]).size !== activeFields.length + 1) throw invalid();
  return { enabled: v.enabled === true, ...(v.dataSourceId ? { dataSourceId: v.dataSourceId as string } : { databaseId: v.databaseId as string }), externalKeyProperty: v.externalKeyProperty, includeCalculationContext: v.includeCalculationContext === true, propertyMap: { ...map } };
}
/**
 * Tipo de propiedad Notion que exige cada campo de la proyección. Añadir un nombre a `fields` sin
 * crearlo en la base hace que CADA upsert devuelva 400 y `failed` iguale al total, así que la
 * comprobación tiene que ser real: `schemaVerified` en un JSON es una afirmación del operador,
 * no una verificación.
 */
const EXPECTED_TYPES: Record<typeof fields[number], string> = {
  Name: 'title', Company: 'rich_text', URL: 'url', Type: 'select', Expiration: 'select',
  Deadline: 'date', Verification: 'select', 'Verification reasons': 'rich_text', Published: 'date',
  Screening: 'select', 'Screening reasons': 'rich_text', 'Employment eligibility': 'select',
  Location: 'rich_text', Relocation: 'select', 'Recommendation rank': 'number',
  'Recommendation priority': 'number', Relevance: 'number', 'Relevance tier': 'select',
  'Fit score': 'number', 'Economic score': 'number', 'Hourly USD': 'number',
  'Freelance review': 'select', Origin: 'rich_text', 'Calculation assumptions': 'rich_text', Explanation: 'rich_text',
};
export interface SchemaIssue { property: string; problem: 'missing' | 'wrong_type'; expected: string; found?: string }
/**
 * Compara el esquema REAL de la base contra lo que este módulo envía. Devuelve la lista de
 * diferencias; una lista vacía es la única evidencia aceptable para escribir.
 */
export async function verifyNotionSchema(value: unknown, transport: HttpTransport): Promise<{ ok: boolean; issues: SchemaIssue[] }> {
  const config = validateNotionConfig(value);
  // GET sobre la data source, no query: el endpoint de query devuelve las FILAS de la base, no
  // sus columnas. Pedirle el esquema a query devuelve siempre vacío.
  const response = await transport(request(config, 'GET', `${config.dataSourceId ? 'data_sources' : 'databases'}/${config.dataSourceId ?? config.databaseId}`, {}));
  if (response.status !== 200) throw new Error('notion_schema_unreadable');
  const schema = obj(obj(response.body).properties ?? {});
  if (!Object.keys(schema).length) throw new Error('notion_schema_unreadable');
  const active = config.includeCalculationContext ? fields : fields.filter(k => !calculationContextFields.includes(k as typeof calculationContextFields[number]));
  const issues: SchemaIssue[] = [];
  for (const field of [...active, config.externalKeyProperty]) {
    const name = active.includes(field as typeof fields[number]) ? config.propertyMap[field as typeof fields[number]] ?? field : field;
    const expected = field === config.externalKeyProperty ? 'rich_text' : EXPECTED_TYPES[field as typeof fields[number]];
    const found = schema[name] ? String(obj(schema[name]).type ?? '') : undefined;
    if (!found) issues.push({ property: name, problem: 'missing', expected });
    else if (found !== expected) issues.push({ property: name, problem: 'wrong_type', expected, found });
  }
  return { ok: !issues.length, issues };
}
/**
 * Crea en la base SOLO las propiedades que faltan.
 *
 * Deliberadamente NO toca las que existen con otro tipo: cambiar el tipo de una columna en Notion
 * puede vaciar lo que ya contiene, y eso es una decisión de una persona mirando sus datos, no de
 * un script. Esos casos se reportan y se quedan como están.
 *
 * Es aditivo e idempotente: correrlo dos veces no hace nada la segunda vez.
 */
export async function applyNotionSchema(value: unknown, transport: HttpTransport): Promise<{ added: string[]; unresolved: SchemaIssue[] }> {
  const config = validateNotionConfig(value);
  const { issues } = await verifyNotionSchema(config, transport);
  const missing = issues.filter(issue => issue.problem === 'missing');
  const unresolved = issues.filter(issue => issue.problem !== 'missing');
  if (!missing.length) return { added: [], unresolved };
  // Notion crea una columna con `{ <tipo>: {} }`; las opciones de un select se pueblan solas.
  const properties = Object.fromEntries(missing.map(issue => [issue.property, { [issue.expected]: {} }]));
  const response = await transport(request(config, 'PATCH', `${config.dataSourceId ? 'data_sources' : 'databases'}/${config.dataSourceId ?? config.databaseId}`, { properties }));
  if (response.status !== 200) throw new Error('notion_schema_update_failed');
  return { added: missing.map(issue => issue.property), unresolved };
}
function request(config: NotionConfig, method: HttpRequest['method'], path: string, body: Record<string, unknown>): HttpRequest {
  return { method, url: `https://api.notion.com/v1/${path}`, headers: { 'Content-Type': 'application/json', 'Notion-Version': config.dataSourceId ? '2025-09-03' : '2022-06-28' }, body };
}
function query(config: NotionConfig, key: string): HttpRequest {
  return request(config, 'POST', `${config.dataSourceId ? 'data_sources' : 'databases'}/${config.dataSourceId ?? config.databaseId}/query`, { filter: { property: config.externalKeyProperty, rich_text: { equals: key } }, page_size: 2 });
}
function properties(record: NotionRecord, config: NotionConfig): Record<string, unknown> {
  if (typeof record.externalKey !== 'string' || !/^[a-f\d]{64}$/.test(record.externalKey)) throw new Error('Registro inválido');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    if (!config.includeCalculationContext && calculationContextFields.includes(key as typeof calculationContextFields[number])) continue;
    if (Object.hasOwn(record.properties, key)) result[config.propertyMap[key] ?? key] = record.properties[key];
  }
  result[config.externalKeyProperty] = { rich_text: [{ text: { content: record.externalKey } }] };
  return result;
}
function gate(record: NotionRecord, now: Date): Verification {
  if (!record.opportunity) return { status: 'unknown', reasons: ['verification_context_missing'], ageDays: null, sameDay: false, validUntil: null, windowDays: PUBLICATION_WINDOW_DAYS };
  const opportunity = parseOpportunity(record.opportunity);
  if (identity(opportunity) !== record.externalKey) throw new Error('invalid_record');
  const result = verification(opportunity, now);
  if (record.properties.Screening?.select.name === 'discarded' || record.properties['Employment eligibility']?.select.name === 'ineligible') {
    return { ...result, status: 'unknown', reasons: [...result.reasons, 'screening_excluded'] };
  }
  return result;
}
export function planNotionSync(records: readonly NotionRecord[], value: unknown, now = new Date()) {
  const config = validateNotionConfig(value);
  const checked = records.map(record => ({ record, verification: gate(record, now) }));
  // `confirmed` se fija como literal, no como boolean: este plan NUNCA está confirmado, y dejar
  // que el tipo se ensanche permitía pasarlo donde se exige un plan de dry-run.
  return { mode: 'dry-run' as const, confirmed: false as const,
    blocked: checked.filter(r => r.verification.status !== 'verified').map(r => ({ externalKey: r.record.externalKey, verification: r.verification })),
    records: checked.filter(r => r.verification.status === 'verified').map(({ record }) => ({ externalKey: record.externalKey, action: 'query-then-upsert' as const, query: query(config, record.externalKey), create: createRequest(record, config), update: { properties: properties(record, config) } })) };
}
/**
 * La forma del plan que se PERSISTE: claves y motivos, nunca peticiones HTTP.
 *
 * Las peticiones completas del plan no las lee nadie. `upsertNotionRecords` reconstruye la suya
 * desde el registro vigente —tiene que hacerlo, porque vuelve a pasar el gate y a revalidar antes
 * de escribir—, y el único consumidor del plan en disco mira cuántos hay y por qué se bloquearon
 * los demás. Medido el 2026-09-30: de los 427 MB del checkpoint, 57,4 MB eran esas peticiones
 * —URL, cabeceras y cuerpo repetidos registro a registro— sin un solo lector.
 */
export interface CompactNotionPlan {
  mode: 'dry-run';
  confirmed: false;
  /** Solo las claves externas. `length` es lo único que se consultaba de esta lista. */
  records: string[];
  blocked: ({ externalKey: string; reasons: readonly string[] } | { externalKey: string; reason: string })[];
}
export function compactNotionPlan(plan: {
  mode: 'dry-run'; confirmed: false;
  records: readonly { externalKey: string }[];
  // Dos formas a propósito: `planNotionSync` bloquea con la verificación completa, y el plan de
  // reserva de `runSourceCycle` (sin esquema verificado) bloquea con un motivo único.
  blocked: readonly ({ externalKey: string; verification: Verification } | { externalKey: string; reason: string })[];
}): CompactNotionPlan {
  return { mode: plan.mode, confirmed: plan.confirmed,
    records: plan.records.map(r => r.externalKey),
    blocked: plan.blocked.map(b => 'reason' in b
      ? { externalKey: b.externalKey, reason: b.reason }
      : { externalKey: b.externalKey, reasons: b.verification.reasons }) };
}
function createRequest(record: NotionRecord, config: NotionConfig) {
  return request(config, 'POST', 'pages', { parent: config.dataSourceId ? { type: 'data_source_id', data_source_id: config.dataSourceId } : { database_id: config.databaseId }, properties: properties(record, config) });
}
async function confirmed(transport: HttpTransport, req: HttpRequest): Promise<Record<string, unknown>> {
  let response: HttpResponse;
  try { response = await transport(req); } catch { throw new Error('transport_error'); }
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) throw new Error('http_error');
  return obj(response.body);
}
export async function queryExistingPages(key: string, value: unknown, transport: HttpTransport) {
  const config = validateNotionConfig(value);
  if (!config.enabled) throw new Error('sync_disabled');
  if (!/^[a-f\d]{64}$/.test(key)) throw new Error('invalid_record');
  const body = await confirmed(transport, query(config, key));
  if (body.object !== 'list' || !Array.isArray(body.results) || typeof body.has_more !== 'boolean') throw new Error('invalid_response');
  // More than one match is ambiguous. Never choose a page or create another one.
  if (body.has_more || body.results.length > 1) throw new Error('duplicate_external_key');
  return body.results.map(value => {
    const page = obj(value);
    if (page.object !== 'page' || typeof page.id !== 'string' || !page.id || !page.properties || page.archived === true || page.in_trash === true) throw new Error('invalid_response');
    return { id: page.id, properties: obj(page.properties) };
  });
}
// Compare only the writable values we own, ignoring Notion IDs, colors and annotations.
function comparable(value: unknown): unknown {
  const p = obj(value);
  for (const type of ['title', 'rich_text']) if (Array.isArray(p[type])) return { [type]: p[type].map((v: unknown) => obj(obj(v).text).content ?? obj(v).plain_text ?? '').join('') };
  if ('select' in p) return { select: p.select === null ? null : obj(p.select).name };
  if ('date' in p) return { date: p.date === null ? null : { start: obj(p.date).start, end: obj(p.date).end ?? null, time_zone: obj(p.date).time_zone ?? null } };
  if ('number' in p) return { number: p.number };
  if ('url' in p) return { url: p.url };
  return null;
}
export interface SyncResult { created: number; updated: number; skipped: number; failed: number; records: { index: number; status: 'created' | 'updated' | 'skipped' | 'failed'; reason?: string; verification?: Verification; opportunity?: Opportunity }[] }
export interface SyncOptions {
  now?: () => Date;
  revalidate?: (opportunity: Opportunity, signal: AbortSignal) => Promise<AvailabilityEvidence>;
  timeoutMs?: number;
  /** Tope de registros a procesar. Los que sobran se reportan `skipped`/`batch_limit`, no se pierden. */
  limit?: number;
  /** Pausa entre registros. Notion limita ~3 peticiones/segundo y cada registro hace dos. */
  pacingMs?: number;
  /** Seam de pruebas: evita esperas reales en la suite. */
  sleep?: (ms: number) => Promise<void>;
}
/**
 * Ritmo por defecto. Cada registro dispara una consulta y, si cambia, una escritura: a ~3
 * peticiones por segundo del lado de Notion, 700 ms entre registros deja margen. Sin esto, un
 * lote de cientos se convierte en una tanda de 429 y escrituras a medias.
 */
export const DEFAULT_PACING_MS = 700;
async function revalidate(o: Opportunity, options: SyncOptions, now: () => Date): Promise<Opportunity> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = (outcome: 'timeout' | 'error'): AvailabilityEvidence => ({ url: o.url!, checkedAt: now().toISOString(), outcome });
  try {
    const observation = await Promise.race([
      Promise.resolve().then(() => options.revalidate!(structuredClone(o), controller.signal)),
      new Promise<AvailabilityEvidence>(resolve => { timer = setTimeout(() => { resolve(fallback('timeout')); controller.abort(); }, options.timeoutMs ?? 5000); }),
    ]);
    return { ...o, availability: parseAvailability(observation) };
  } catch { return { ...o, availability: fallback('error') }; }
  finally { if (timer) clearTimeout(timer); }
}
const activeSyncs = new Map<string, Promise<void>>();
async function exclusively<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = activeSyncs.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  activeSyncs.set(key, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (activeSyncs.get(key) === current) activeSyncs.delete(key); }
}
export async function upsertNotionRecords(records: readonly NotionRecord[], value: unknown, transport: HttpTransport, options: SyncOptions = {}): Promise<SyncResult> {
  const config = validateNotionConfig(value);
  const now = options.now ?? (() => new Date());
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 60_000)) throw new Error('timeoutMs inválido');
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) throw new Error('limit inválido');
  const pacingMs = options.pacingMs ?? DEFAULT_PACING_MS;
  // SIN `unref()`: un temporizador desreferenciado no mantiene vivo el event loop, así que el
  // proceso se cierra en mitad de la pausa y el lote queda a medio escribir. Aquí la espera ES
  // el trabajo, no una tarea de fondo.
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, failed: 0, records: [] };
  const seen = new Set<string>();
  let attempted = 0;
  // Registros que de verdad llamaron a Notion; solo entre ellos hace falta el ritmo.
  let paced = 0;
  for (const [index, record] of records.entries()) {
    let status: SyncResult['records'][number]['status'] = 'skipped';
    let reason: string | undefined;
    let checked: Verification | undefined;
    let opportunity: Opportunity | undefined;
    if (!config.enabled) reason = 'sync_disabled';
    // Pasado el tope, los registros restantes se reportan, no se descartan en silencio: hay que
    // poder ver cuántos quedaron fuera y por qué.
    else if (options.limit !== undefined && attempted >= options.limit) reason = 'batch_limit';
    else if (seen.has(record.externalKey)) reason = 'duplicate_in_batch';
    else try {
      seen.add(record.externalKey);
      attempted++;
      await exclusively(`${config.dataSourceId ?? config.databaseId}:${record.externalKey}`, async () => {
        let candidate = structuredClone(record);
        checked = gate(candidate, now());
        if (checked.status !== 'verified') { reason = 'verification_blocked'; return; }
        if (options.revalidate) {
          opportunity = await revalidate(candidate.opportunity!, options, now);
          candidate = { ...candidate, opportunity };
          checked = gate(candidate, now());
          if (checked.status !== 'verified') { reason = 'verification_blocked'; return; }
        }
        candidate.properties.Verification = { select: { name: checked.status } };
        candidate.properties['Verification reasons'] = { rich_text: [] };
        candidate.properties.Published = { date: { start: candidate.opportunity!.publishedAt! } };
        const props = properties(candidate, config);
        // El ritmo va JUSTO antes de la primera petición, no al entrar al registro: la mayoría
        // no llega hasta aquí porque el gate de verificación la bloquea sin tocar la red.
        // Medido: 5.070 registros para ~780 llamadas — pausar en todos costaba 59 minutos de
        // sueño para respetar un límite que solo aplica a los que sí llaman.
        if (paced++ && pacingMs > 0) await sleep(pacingMs);
        const [page] = await queryExistingPages(record.externalKey, config, transport);
        checked = gate(candidate, now());
        if (checked.status !== 'verified') { reason = 'verification_blocked'; return; }
        if (page && Object.entries(props).every(([key, v]) => JSON.stringify(comparable(v)) === JSON.stringify(comparable(page.properties[key])))) reason = 'unchanged';
        else {
          const req = page ? request(config, 'PATCH', `pages/${encodeURIComponent(page.id)}`, { properties: props }) : createRequest(candidate, config);
          const response = await confirmed(transport, req);
          if (response.object !== 'page' || typeof response.id !== 'string' || !response.id || (page && response.id !== page.id)) throw new Error('invalid_response');
          status = page ? 'updated' : 'created';
        }
      });
    } catch (error) {
      status = 'failed';
      const code = error instanceof Error ? error.message : '';
      reason = ['transport_error', 'http_error', 'invalid_response', 'duplicate_external_key'].includes(code) ? code : 'invalid_record';
    }
    result[status]++;
    result.records.push({ index, status, ...(reason ? { reason } : {}), ...(checked ? { verification: checked } : {}), ...(opportunity ? { opportunity } : {}) });
  }
  return result;
}
