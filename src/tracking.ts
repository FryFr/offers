import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export type TrackingEvent = ApplicationEvent | ResponseEvent | InterviewEvent | OfferEvent;
interface EventBase { schemaVersion: 1; eventId: string; occurredAt: string; recordedAt: string; correctsEventId?: string }
export interface ApplicationEvent extends EventBase { type: 'application'; applicationId: string; opportunityId: string; attemptId: string }
export interface ResponseEvent extends EventBase { type: 'response'; applicationId: string; outcome: 'positive' | 'negative' }
export interface InterviewEvent extends EventBase { type: 'interview'; applicationId: string; status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled' }
export interface OfferEvent extends EventBase { type: 'offer'; applicationId: string; status: 'received' | 'accepted' | 'declined' }
export interface TrackingStore { schemaVersion: 1; revision: number; events: TrackingEvent[]; checksum: string }
export interface TrackingImport { schemaVersion: 1; events: unknown[] }

const keys = (value: Record<string, unknown>, allowed: readonly string[], name: string) => {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${name}: campos desconocidos: ${unknown.sort().join(', ')}`);
};
const object = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: objeto requerido`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error(`${name}: texto no vacío y sin espacios exteriores requerido`);
  return value;
};
const instant = (value: unknown, name: string) => {
  const result = text(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) || new Date(result).toISOString().replace('.000Z', 'Z') !== result.replace('.000Z', 'Z')) throw new Error(`${name}: timestamp UTC inválido`);
  return result;
};
const enumeration = <T extends string>(value: unknown, values: readonly T[], name: string): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${name}: valor inválido`);
  return value as T;
};
export const applicationIdentity = (opportunityId: string, attemptId: string) => createHash('sha256').update(JSON.stringify(['application', opportunityId, attemptId])).digest('hex');

export function parseTrackingEvent(value: unknown, index = 0): TrackingEvent {
  const v = object(value, `events[${index}]`);
  const baseKeys = ['schemaVersion', 'eventId', 'type', 'occurredAt', 'recordedAt', 'correctsEventId'];
  if (v.schemaVersion !== 1) throw new Error(`events[${index}].schemaVersion: versión no soportada`);
  const type = enumeration(v.type, ['application', 'response', 'interview', 'offer'] as const, `events[${index}].type`);
  const base = { schemaVersion: 1 as const, eventId: text(v.eventId, `events[${index}].eventId`), type, occurredAt: instant(v.occurredAt, `events[${index}].occurredAt`), recordedAt: instant(v.recordedAt, `events[${index}].recordedAt`), ...(v.correctsEventId === undefined ? {} : { correctsEventId: text(v.correctsEventId, `events[${index}].correctsEventId`) }) };
  if (type === 'application') {
    keys(v, [...baseKeys, 'applicationId', 'opportunityId', 'attemptId'], `events[${index}]`);
    const opportunityId = text(v.opportunityId, `events[${index}].opportunityId`);
    const attemptId = text(v.attemptId, `events[${index}].attemptId`);
    const applicationId = applicationIdentity(opportunityId, attemptId);
    if (v.applicationId !== applicationId) throw new Error(`events[${index}].applicationId: identidad derivada inválida`);
    return { ...base, type, applicationId, opportunityId, attemptId };
  }
  const applicationId = text(v.applicationId, `events[${index}].applicationId`);
  if (type === 'response') {
    keys(v, [...baseKeys, 'applicationId', 'outcome'], `events[${index}]`);
    return { ...base, type, applicationId, outcome: enumeration(v.outcome, ['positive', 'negative'] as const, `events[${index}].outcome`) };
  }
  if (type === 'interview') {
    keys(v, [...baseKeys, 'applicationId', 'status'], `events[${index}]`);
    return { ...base, type, applicationId, status: enumeration(v.status, ['scheduled', 'completed', 'cancelled', 'rescheduled'] as const, `events[${index}].status`) };
  }
  keys(v, [...baseKeys, 'applicationId', 'status'], `events[${index}]`);
  return { ...base, type, applicationId, status: enumeration(v.status, ['received', 'accepted', 'declined'] as const, `events[${index}].status`) };
}

export function parseTrackingImport(value: unknown): TrackingEvent[] {
  const v = object(value, 'trackingImport');
  keys(v, ['schemaVersion', 'events'], 'trackingImport');
  if (v.schemaVersion !== 1 || !Array.isArray(v.events)) throw new Error('trackingImport: contrato o versión inválida');
  return Array.from(v.events, (event, index) => parseTrackingEvent(event, index));
}
const payload = (store: Pick<TrackingStore, 'schemaVersion' | 'revision' | 'events'>) => JSON.stringify({ schemaVersion: store.schemaVersion, revision: store.revision, events: store.events });
const checksum = (store: Pick<TrackingStore, 'schemaVersion' | 'revision' | 'events'>) => createHash('sha256').update(payload(store)).digest('hex');
export const emptyTrackingStore = (): TrackingStore => { const value = { schemaVersion: 1 as const, revision: 0, events: [] as TrackingEvent[] }; return { ...value, checksum: checksum(value) }; };

function validateGraph(events: TrackingEvent[]) {
  const ids = new Map<string, TrackingEvent>();
  const applications = new Set<string>();
  for (const event of events) {
    if (ids.has(event.eventId)) throw new Error(`eventId duplicado: ${event.eventId}`);
    ids.set(event.eventId, event);
    if (event.type === 'application') applications.add(event.applicationId);
  }
  for (const event of events) {
    if (event.type !== 'application' && !applications.has(event.applicationId)) throw new Error(`referencia de postulación inválida: ${event.eventId}`);
    if (event.correctsEventId) {
      const original = ids.get(event.correctsEventId);
      if (!original || original.type !== event.type || original.eventId === event.eventId || original.applicationId !== event.applicationId) throw new Error(`corrección inválida: ${event.eventId}`);
      if (event.recordedAt < original.recordedAt) throw new Error(`corrección anterior al original: ${event.eventId}`);
    }
  }
  const corrected = new Set(events.flatMap(event => event.correctsEventId ? [event.correctsEventId] : []));
  if (corrected.size !== events.filter(event => event.correctsEventId).length) throw new Error('un evento solo puede corregirse una vez');
  for (const event of events) {
    const seen = new Set<string>(); let current: TrackingEvent | undefined = event;
    while (current?.correctsEventId) { if (seen.has(current.eventId)) throw new Error('ciclo de correcciones'); seen.add(current.eventId); current = ids.get(current.correctsEventId); }
  }
}
export function parseTrackingStore(value: unknown): TrackingStore {
  const v = object(value, 'trackingStore');
  keys(v, ['schemaVersion', 'revision', 'events', 'checksum'], 'trackingStore');
  if (v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || !Array.isArray(v.events)) throw new Error('trackingStore: contrato o versión inválida');
  const rawCore = { schemaVersion: 1 as const, revision: Number(v.revision), events: v.events as TrackingEvent[] };
  if (typeof v.checksum !== 'string' || v.checksum !== checksum(rawCore)) throw new Error('trackingStore: checksum inválido; posible corrupción');
  const core = { schemaVersion: 1 as const, revision: Number(v.revision), events: Array.from(v.events, (event, index) => parseTrackingEvent(event, index)) };
  validateGraph(core.events);
  return { ...core, checksum: v.checksum };
}
export function importTracking(store: TrackingStore, input: unknown): TrackingStore {
  const incoming = parseTrackingImport(input);
  const byId = new Map(store.events.map(event => [event.eventId, event]));
  let changed = false;
  for (const event of incoming) {
    const existing = byId.get(event.eventId);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error(`eventId reutilizado con contenido distinto: ${event.eventId}`); continue; }
    byId.set(event.eventId, event); changed = true;
  }
  if (!changed) return store;
  const events = [...byId.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.eventId.localeCompare(b.eventId));
  validateGraph(events);
  const core = { schemaVersion: 1 as const, revision: store.revision + 1, events };
  return { ...core, checksum: checksum(core) };
}

const rate = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
export function trackingReport(store: TrackingStore, cutoff: Date) {
  if (!Number.isFinite(cutoff.getTime())) throw new Error('Corte inválido');
  const at = cutoff.toISOString();
  const known = store.events.filter(event => event.recordedAt <= at && event.occurredAt <= at);
  const corrected = new Set(known.flatMap(event => event.correctsEventId ? [event.correctsEventId] : []));
  const active = known.filter(event => !corrected.has(event.eventId));
  const applicationIds = new Set(active.filter((event): event is ApplicationEvent => event.type === 'application').map(event => event.applicationId));
  const forApplications = active.filter(event => applicationIds.has(event.applicationId));
  const responded = new Set(forApplications.filter(event => event.type === 'response').map(event => event.applicationId));
  const interviewed = new Set(forApplications.filter(event => event.type === 'interview' && event.status === 'completed').map(event => event.applicationId));
  const offered = new Set(forApplications.filter(event => event.type === 'offer').map(event => event.applicationId));
  const accepted = new Set(forApplications.filter(event => event.type === 'offer' && event.status === 'accepted').map(event => event.applicationId));
  const applications = applicationIds.size;
  return { schemaVersion: 1, cutoff: at, counts: { applications, responses: responded.size, interviews: interviewed.size, offers: offered.size, acceptedOffers: accepted.size }, rates: { response: rate(responded.size, applications), interview: rate(interviewed.size, applications), offer: rate(offered.size, applications), offerAcceptance: rate(accepted.size, offered.size) } };
}

export async function loadTrackingStore(path: string): Promise<TrackingStore> {
  try { return parseTrackingStore(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyTrackingStore(); throw error; }
}
export async function saveTrackingStore(path: string, store: TrackingStore, expectedRevision: number) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Almacén de seguimiento ocupado por otro escritor'); throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const current = await loadTrackingStore(path);
    if (current.revision !== expectedRevision) throw new Error('Conflicto de concurrencia: revisión cambió');
    const file = await open(temporary, 'wx');
    try { await file.writeFile(`${JSON.stringify(store, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); await lock.close(); await rm(lockPath, { force: true }); }
}
