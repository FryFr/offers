import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseProfile } from './contracts.ts';
import { parseLedger, deliveredIds, recordDelivery } from './delivery-ledger.ts';
import { renderDigest } from './digest.ts';
import { compactHistory, parseStore, pruneStore, report } from './pipeline.ts';
import { atomicMailWrite, atomicWriteText, withMailLock } from './mail-runner.ts';
import { parseRegistry, AGGREGATOR_ADAPTERS } from './source-registry.ts';
import { runSourceCycle, probeSource, type CycleOptions, type SourceState } from './multi-source.ts';
import { createClaudeEnricher } from './claude-enrichment.ts';
import { upsertNotionRecords, validateNotionConfig, verifyNotionSchema, applyNotionSchema, compactNotionPlan, type HttpTransport, type SchemaIssue } from './notion-sync.ts';
import { createNotionTransport } from './notion-transport.ts';
import { pageBody } from './notion-body.ts';
import { boardEvents, readBoard } from './notion-board.ts';
import { renderUpskill, upskillReport } from './upskill.ts';
import { importTracking, loadTrackingStore, saveTrackingStore, trackingReport } from './tracking.ts';
import type { Provenance } from './source-adapters.ts';
import { fetchRegister, registerIndex, type SponsorRegister } from './uk-sponsors.ts';
import type { SafeReadOptions } from './safe-http.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
async function optionalJson(path: string): Promise<unknown | undefined> {
  try { return await json(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function parseSourceState(value: unknown): SourceState {
  const s = value as SourceState | null;
  if (!s || s.version !== 1 || !s.lastAttempt || typeof s.lastAttempt !== 'object' || Array.isArray(s.lastAttempt)) throw new Error('checkpoint_invalid');
  for (const [key, date] of Object.entries(s.lastAttempt)) if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || typeof date !== 'string'
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) throw new Error('checkpoint_invalid');
  if (s.lastResult !== undefined && (!s.lastResult || typeof s.lastResult !== 'object' || Array.isArray(s.lastResult) || Object.values(s.lastResult).some(v => !['ok', 'partial', 'failed'].includes(v)))) throw new Error('checkpoint_invalid');
  return { version: 1, lastAttempt: { ...s.lastAttempt }, lastResult: { ...s.lastResult } };
}
/** One atomic checkpoint includes store, provenance, cadence and dry-run plan; no production transport. */
export async function runSources(options: { root?: string; enrichModel?: string; now?: Date; dependencies?: Pick<CycleOptions, 'transport' | 'resolveHost' | 'htmlFetch' | 'env' | 'enrich'> } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  return withMailLock(join(data, 'automation'), () => withMailLock(join(data, 'source-cycle.json'), async () => {
    const sources = parseRegistry(await json(join(root, 'examples/sources.json')));
    const profile = parseProfile(await json(join(root, 'examples/profile.json')));
    const prior = await optionalJson(join(data, 'source-cycle.json')) as Record<string, unknown> | undefined;
    if (prior && (prior.version !== 1 || prior.mode !== 'dry-run' || prior.confirmed !== false)) throw new Error('checkpoint_invalid');
    const store = parseStore(prior?.store ?? await optionalJson(join(data, 'offers.json')) ?? { version: 1, records: [] });
    const state = prior ? parseSourceState(prior.state) : undefined;
    const local = await optionalJson(join(data, 'notion-local.json')) as { schemaVerified?: unknown; config?: unknown } | undefined;
    const enrich = options.dependencies?.enrich ?? (options.enrichModel ? createClaudeEnricher({ model: options.enrichModel }) : undefined);
    // Dry-run only plans; force enabled:false so an enabled data/notion-local.json config cannot trip runSourceCycle's write guard.
    const dryRunNotionConfig = local?.schemaVerified === true && local.config && typeof local.config === 'object'
      ? { ...local.config as Record<string, unknown>, enabled: false } : undefined;
    // El registro es opcional: si nunca se corrió `--refresh-sponsors`, el ciclo funciona igual
    // y simplemente no aporta la señal `employer_registered`.
    const sponsors = await optionalJson(join(data, 'uk-sponsors.json')) as SponsorRegister | undefined;
    const result = await runSourceCycle({ ...options.dependencies, sources, profile, store, state, now: options.now,
      notionConfig: dryRunNotionConfig, enrich, mode: 'dry-run',
      ...(sponsors?.organisations?.length ? { sponsorRegister: registerIndex(sponsors) } : {}) });
    const provenance = { ...(prior?.provenance as Record<string, Provenance[]> | undefined) };
    for (const job of result.jobs) {
      const key = job.opportunity.url!;
      const old = provenance[key] ?? [];
      // Preserve first/last observations for each exact source payload without unbounded repeat entries.
      const merged = [...old, ...job.provenance];
      const groups = new Map<string, Provenance[]>();
      for (const p of merged) {
        const id = JSON.stringify([p.sourceId, p.externalId, p.payloadHash]);
        const entries = groups.get(id) ?? []; entries.push(p); groups.set(id, entries);
      }
      provenance[key] = [...groups.values()].flatMap(entries => entries.length > 1 ? [entries[0]!, entries.at(-1)!] : entries);
    }
    // `jobs` es la captura cruda del ciclo y nadie la vuelve a leer: runSources solo recupera
    // store, state y provenance del checkpoint previo. Persistirla duplicaba el archivo sin uso.
    //
    // Y el plan de Notion se guarda compacto por la misma razón: sus peticiones HTTP no las lee
    // nadie, porque `upsertNotionRecords` reconstruye la suya desde el registro vigente. Lo que
    // SÍ se devuelve en memoria sigue siendo el plan completo, que es lo que el CLI inspecciona
    // para decidir el código de salida.
    const { jobs: _discarded, ...persisted } = result;
    await atomicMailWrite(join(data, 'source-cycle.json'), { ...persisted, provenance, notionPlan: compactNotionPlan(result.notionPlan) });
    // El resumen de salud va DESPUÉS del checkpoint, nunca antes: así no puede afirmar un ciclo
    // que no quedó persistido. Si esta escritura falla, `--health` lee el resumen anterior, lo ve
    // viejo y avisa — que es exactamente lo que debe pasar.
    await atomicMailWrite(join(data, 'source-health.json'), { version: 1, generatedAt: result.generatedAt,
      mode: result.mode, confirmed: result.confirmed, health: result.health, counts: result.counts });
    // Estado del proceso, no del checkpoint. Distingue tres casos que antes se colapsaban en
    // exit 5: sin archivo (no hay Notion que verificar), con archivo sin verificar (sí alerta),
    // y con archivo verificado (el planificador decide).
    return { ...result, notionLocalPresent: local !== undefined };
  }));
}
/**
 * Pico de heap del ciclo, en MB. Aproximado: el muestreo no corre durante bloques síncronos
 * como `report()`, así que subestima. Sirve para detectar crecimiento anómalo al escalar
 * fuentes comparando contra la línea base, no como medida exacta.
 */
function trackHeapPeak(intervalMs = 250) {
  let peak = process.memoryUsage().heapUsed;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().heapUsed); };
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); sample(); return Math.round(peak / 1_048_576); };
}
/**
 * Refresca el registro británico de patrocinadores. Va aparte del ciclo y con cadencia semanal:
 * es una descarga de ~11 MB que cambia unas pocas veces por semana, no un feed horario.
 */
export async function refreshSponsors(options: { root?: string; now?: Date; dependencies?: SafeReadOptions } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const register = await fetchRegister(options.now ?? new Date(), options.dependencies ?? {});
  await atomicMailWrite(join(data, 'uk-sponsors.json'), register);
  return { organisations: register.organisations.length, sourceUrl: register.sourceUrl, fetchedAt: register.fetchedAt };
}
/**
 * Corte diario: lee el checkpoint existente, entrega `dailyTarget` oportunidades que no se hayan
 * entregado antes y anota la entrega. No recolecta fuentes ni toca la red — es una lectura.
 *
 * Cada corrida escribe también una línea en `data/metrics.jsonl`. Ese archivo es el instrumento
 * de la decisión "arrancar con fuentes gratuitas y medir": si la mediana de `deliveredNew` se
 * queda por debajo del objetivo durante dos semanas, hay evidencia para pagar cobertura; si no,
 * no hace falta.
 */
/**
 * El corte del día, CALCULADO y sin escribir nada.
 *
 * Existe aparte de `runDigest` porque comparar dos perfiles sobre el mismo checkpoint era
 * imposible mientras calcular y entregar fueran la misma función: cada medición anotaba la
 * entrega en el ledger, así que la segunda corrida ya no veía lo mismo que la primera y el
 * "antes contra después" medía el instrumento en vez del cambio.
 *
 * `profilePath` permite apuntar a otro perfil sin tocar el del repositorio, que es lo que hace
 * medible un cambio de perfil antes de adoptarlo.
 */
/**
 * Informa qué purgaría la retención, y opcionalmente la aplica.
 *
 * Con `apply: false` NO escribe nada: es el comando que se mira antes de encender el que borra.
 * Lo que se pierde al aplicar es irrecuperable y hay que nombrarlo: revisiones históricas de
 * ofertas que ninguna fuente lista ya, y el `observedAt` de la primera observación en `provenance`.
 */
export async function vacuumCheckpoint(options: { root?: string; now?: Date; apply?: boolean; graceDays?: number } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  const now = options.now ?? new Date();
  const path = join(data, 'source-cycle.json');
  const raw = await readFile(path, 'utf8');
  const checkpoint = JSON.parse(raw) as Record<string, unknown> & { store?: unknown; provenance?: Record<string, unknown> };
  const profile = parseProfile(await json(join(root, 'examples/profile.json')));
  const pruned = pruneStore(parseStore(checkpoint.store), profile, now, options.graceDays);
  // Y se compacta el historial ya escrito: `ingest` solo puede evitar la repetición en las
  // revisiones nuevas, así que lo acumulado antes conserva su copia de la descripción.
  const history = compactHistory(pruned.store);
  // La procedencia se poda a las URLs de los registros VIVOS. `runSources` copia todas las claves
  // previas y nunca borra una, así que acumula la de cada oferta que alguna vez se vio.
  const live = new Set(history.store.records.map(r => r.opportunity.url).filter(Boolean));
  const provenanceBefore = Object.keys(checkpoint.provenance ?? {}).length;
  const provenance = Object.fromEntries(Object.entries(checkpoint.provenance ?? {}).filter(([url]) => live.has(url)));
  const next = { ...checkpoint, store: history.store, provenance };
  const bytesAfter = JSON.stringify(next, null, 2).length + 1;
  const report = { ...pruned.report, revisions: history.revisions, historyCompacted: history.compacted, provenanceKeys: provenanceBefore, provenanceKept: Object.keys(provenance).length,
    bytesBefore: raw.length, bytesAfter, applied: options.apply === true };
  if (options.apply === true) await atomicMailWrite(path, next);
  return report;
}
/**
 * Lee los `Estado` del tablero y los convierte en eventos de seguimiento.
 *
 * Solo LEE de Notion; escribe únicamente `data/tracking.json`. Los eventos son idempotentes por
 * construcción —el `eventId` lleva el `occurredAt` dentro—, así que correrlo dos veces importa cero
 * la segunda. Una edición posterior en Notion produce una observación nueva, no un conflicto.
 */
export async function pullBoardStatus(options: { root?: string; now?: Date; dryRun?: boolean; dependencies?: { transport?: HttpTransport; env?: NodeJS.ProcessEnv } } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const local = await optionalJson(join(data, 'notion-local.json')) as { schemaVerified?: unknown; config?: unknown } | undefined;
  if (!local || local.schemaVerified !== true) throw new Error('notion_sync_disabled');
  const config = validateNotionConfig(local.config);
  const now = options.now ?? new Date();
  const transport = options.dependencies?.transport ?? createNotionTransport(fetch, options.dependencies?.env ?? process.env);
  const { rows, skipped: unreadable } = await readBoard(config, transport);
  const { events, skipped, unknownStates } = boardEvents(rows, now);
  // Un `Estado` que el código no conoce NO se traduce en silencio: adivinar a qué escalón del embudo
  // corresponde inventaría el dato con el que se va a decidir si esta máquina sirve.
  if (unknownStates.length) throw new BoardStateUnknown(unknownStates);
  const summary = { rows: rows.length, events: events.length, skipped: [...unreadable, ...skipped], imported: 0, revision: 0 };
  if (options.dryRun === true) return summary;
  // SIN un lock propio: `saveTrackingStore` ya toma `tracking.json.lock` y además comprueba la
  // revisión esperada releyendo el archivo. Envolverlo en otro `withMailLock` sobre el mismo archivo
  // se auto-bloqueaba con "Almacén de seguimiento ocupado por otro escritor" —comprobado— porque los
  // dos compiten por el mismo `.lock`.
  const path = join(data, 'tracking.json');
  const store = await loadTrackingStore(path);
  const next = importTracking(store, { schemaVersion: 1, events });
  // `importTracking` devuelve la MISMA referencia si nada cambió, y eso es lo que permite no
  // reescribir el archivo ni gastar una revisión cuando el tablero no se movió.
  if (next !== store) await saveTrackingStore(path, next, store.revision);
  return { ...summary, imported: next.events.length - store.events.length, revision: next.revision };
}
/** Lleva los valores desconocidos para que el CLI pueda nombrarlos en vez de decir "algo falló". */
export class BoardStateUnknown extends Error {
  states: string[];
  constructor(states: string[]) { super('board_state_unknown'); this.states = states; }
}
/** El embudo al corte. Solo lee `data/tracking.json`; no toca la red. */
export async function applicationFunnel(options: { root?: string; cutoff?: Date } = {}) {
  const root = options.root ?? repositoryRoot;
  const store = await loadTrackingStore(join(root, 'data/tracking.json'));
  return trackingReport(store, options.cutoff ?? new Date());
}
export async function computeDigest(options: { root?: string; now?: Date; profilePath?: string } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  const now = options.now ?? new Date();
  const checkpoint = await json(join(data, 'source-cycle.json')) as { store?: unknown; counts?: Record<string, number>; generatedAt?: string };
  const profile = parseProfile(await json(options.profilePath ?? join(root, 'examples/profile.json')));
  const ledger = parseLedger(await optionalJson(join(data, 'delivered.json')));
  const store = parseStore(checkpoint.store);
  const snapshot = report(store, profile, now, { delivered: deliveredIds(ledger) });
  const date = now.toISOString().slice(0, 10);
  const verified = snapshot.records.filter(r => r.evaluation.verification.status === 'verified');
  const metric = {
    date, generatedAt: now.toISOString(),
    captured: checkpoint.counts?.captured ?? null,
    verified: verified.length,
    relevanceStrong: verified.filter(r => r.evaluation.relevance.tier === 'strong').length,
    relevancePossible: verified.filter(r => r.evaluation.relevance.tier === 'possible').length,
    delivered: snapshot.recommendations.length,
    deliveredNew: snapshot.recommendations.filter(r => !r.repeated).length,
    freelanceCount: snapshot.recommendations.filter(r => r.kind === 'freelance').length,
    sponsorshipCount: snapshot.recommendations.filter(r => r.sponsors).length,
    storeRecords: store.records.length,
  };
  return { markdown: renderDigest(snapshot, { date, profile }), metric, snapshot, ledger, profile, date, now };
}
/**
 * Entrega el corte del día y lo anota.
 *
 * El lock es el del LEDGER, no el del ciclo. Sostenía `data/automation`, que es el mismo que toma
 * `runSources`, así que el corte de las 06:00 moría con `source_lock_busy` cada vez que el ciclo
 * horario estuviera corriendo —medido el 2026-10-01: no hubo digest ese día por esto—. Y perder el
 * corte diario por un ciclo que ya terminará solo es perder justo lo que el proyecto entrega.
 *
 * El digest no escribe el checkpoint: lo LEE, y las escrituras del proyecto son atómicas (temporal y
 * rename), así que no hay estado a medio escribir que leer. Lo que sí tiene que serializar es su
 * propia anotación, porque dos digests a la vez duplicarían la entrega en el ledger. Ese es
 * `delivered.json`, y ese es el lock que toma.
 */
export async function runDigest(options: { root?: string; now?: Date } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  await mkdir(join(data, 'digest'), { recursive: true, mode: 0o700 });
  return withMailLock(join(data, 'delivered.json'), async () => {
    const { markdown, metric, snapshot, ledger, date, now } = await computeDigest({ root, now: options.now });
    await atomicWriteText(join(data, 'digest', `${date}.md`), markdown);
    await atomicMailWrite(join(data, 'delivered.json'), recordDelivery(ledger, snapshot.recommendations.map(r => r.id), now.toISOString()));
    await appendFile(join(data, 'metrics.jsonl'), `${JSON.stringify(metric)}\n`, { mode: 0o600 });
    return metric;
  });
}
/**
 * El mismo corte, impreso y sin consecuencias: ni ledger, ni métricas, ni archivo de digest.
 *
 * NO toma el lock del ciclo a propósito. Es solo lectura, y las escrituras del proyecto son
 * atómicas (archivo temporal y rename), así que no hay estado a medio escribir que leer. Tomarlo
 * haría que previsualizar fallara con `source_lock_busy` justo mientras el ciclo corre, que es
 * cuando uno quiere mirar.
 */
export async function previewDigest(options: { root?: string; now?: Date; profilePath?: string } = {}) {
  const { snapshot, metric } = await computeDigest(options);
  const byId = new Map(snapshot.records.map(r => [r.id, r]));
  const lines = snapshot.recommendations.map(r => {
    const record = byId.get(r.id);
    const relevance = record?.evaluation.relevance;
    return [String(r.rank).padStart(2), r.id.slice(0, 12), r.tier, String(relevance?.score ?? '?').padStart(3),
      r.roleFamily || '-', `rol=${relevance?.roleMatched.join('|') || '-'}`,
      `skills=${relevance?.skillsMatched.join('|') || '-'}`,
      record?.opportunity.title ?? '?', record?.opportunity.company ?? '?'].join(' · ');
  });
  return { lines, metric };
}
export type HealthReason = 'no_checkpoint' | 'checkpoint_degraded';
/** Proporción de fuentes habilitadas que deben estar sanas para considerar utilizable el ciclo. */
export const HEALTH_QUORUM = 0.8;
/**
 * ¿Esta fuente aportó al ciclo?
 *
 * `ok` y `not_due` sí, obviamente. Y un `partial` CON filas también: `freehire` entrega 1.899 de sus
 * ~1.943 ofertas y entonces el proveedor deja colgada la última página. Eso es una fuente que
 * funcionó, no una avería, y contarla como degradada la deja en la lista de problemas todos los días.
 *
 * Un `partial` SIN filas sí cuenta como degradado: ahí la parada elegante no salvó nada.
 *
 * Vive aquí, a nivel de módulo, porque `--health` y el código de salida del ciclo lo necesitan los
 * dos y durante un día tuvieron reglas distintas: `--health` decía quórum 31/33 mientras el ciclo
 * contaba a `freehire` como roto. Dos verdades sobre la misma corrida es una de más.
 */
export const sourceContributed = (s: { status?: string; fetched?: number }): boolean =>
  ['ok', 'not_due'].includes(s.status ?? '') || (s.status === 'partial' && (s.fetched ?? 0) > 0);
/** Lo único que `sourceHealth` necesita del ciclo, y nada más. Unos pocos KB. */
interface HealthSnapshot { generatedAt?: string; health?: { status?: string; sourceId?: string; fetched?: number }[]; mode?: string; confirmed?: boolean; counts?: unknown }
/**
 * Juzga el último ciclo leyendo un archivo de unos KB, no el checkpoint.
 *
 * `--health` y `--sync` solo miran fecha, modo y el estado por fuente, pero los sacaban del
 * checkpoint entero: `readFile` + `JSON.parse` de 427 MB (medido el 2026-09-30) para leer 32
 * entradas. `--sync` lo hacía DOS veces, una aquí y otra para el store. `runSources` escribe
 * ahora `data/source-health.json` junto al checkpoint, y este solo se lee si ese archivo no existe
 * —una instalación cuyo primer ciclo con esta versión aún no ha corrido.
 */
export async function sourceHealth(root = repositoryRoot, now = new Date()) {
  const checkpoint = (await optionalJson(join(root, 'data/source-health.json'))
    ?? await optionalJson(join(root, 'data/source-cycle.json'))) as HealthSnapshot | undefined;
  // Un checkpoint ausente no es una degradación: es un ciclo que todavía no ha corrido. Confundirlos
  // convertía cada instalación limpia en una alerta y entrenaba a ignorar el monitor.
  if (checkpoint === undefined) return { healthy: false, reason: 'no_checkpoint' as HealthReason, mode: 'dry-run', confirmed: false, generatedAt: undefined, counts: undefined, quorum: undefined };
  const age = now.getTime() - Date.parse(checkpoint.generatedAt ?? '');
  const fresh = Number.isFinite(age) && age >= 0 && age < 24 * 60 * 60_000 && checkpoint.mode === 'dry-run' && checkpoint.confirmed === false && Array.isArray(checkpoint.health);
  /**
   * Quórum en vez de unanimidad. Exigir que TODAS las fuentes estén sanas funcionaba con 15;
   * con 20 o 100 significa que cualquier proveedor con un mal día bloquea el sync entero y deja
   * a la persona sin ofertas por un 429 ajeno. Una mayoría sana es señal suficiente de que el
   * ciclo sirve; las rotas se reportan igual, nombre por nombre.
   */
  const entries = fresh ? checkpoint.health! : [];
  const enabled = entries.filter(s => s.status !== 'disabled');
  /**
   * Una fuente CONTRIBUYÓ si entregó filas, aunque su estado sea `partial`.
   *
   * El quórum juzga si el CICLO sirve, no si cada proveedor se portó perfecto. La regla de qué cuenta
   * como aportar vive en `sourceContributed`, compartida con el código de salida del ciclo.
   */
  const working = enabled.filter(sourceContributed);
  const ratio = enabled.length ? working.length / enabled.length : 0;
  const healthy = fresh && enabled.length > 0 && ratio >= HEALTH_QUORUM;
  const quorum = { working: working.length, enabled: enabled.length, required: HEALTH_QUORUM,
    degraded: enabled.filter(s => !sourceContributed(s)).map(s => s.sourceId ?? '?'),
    // Lo que entregó pese a no terminar se nombra aparte: sigue visible sin disfrazarse de avería.
    partial: enabled.filter(s => s.status === 'partial' && (s.fetched ?? 0) > 0).map(s => `${s.sourceId ?? '?'}:${s.fetched}`) };
  return { healthy, ...(healthy ? {} : { reason: 'checkpoint_degraded' as HealthReason }), mode: 'dry-run', confirmed: false, generatedAt: checkpoint.generatedAt, counts: checkpoint.counts, quorum };
}
/** Reads the existing checkpoint store/profile and the existing writer only; never recollects sources or revalidates cadence. */
/** Lleva la lista de diferencias para que el CLI pueda decir QUÉ falta, no solo que algo falla. */
export class SchemaMismatch extends Error {
  issues: SchemaIssue[];
  constructor(issues: SchemaIssue[]) { super('notion_schema_mismatch'); this.issues = issues; }
}
/**
 * Escribe en Notion lo que de verdad es un tablero.
 *
 * Dos cambios estructurales sobre la versión anterior, y los dos vienen de operarlo:
 *
 * **El lock del checkpoint cubre la LECTURA, no los cincuenta minutos de red.** Antes se sostenía
 * `data/source-cycle.json.lock` durante `verifyNotionSchema` y todo el upsert, así que el ciclo
 * horario chocaba con `source_lock_busy` y se perdía una corrida completa cada vez que el sync
 * duraba más de una hora. El sync no escribe el checkpoint: solo escribe `data/notion-sync.json`,
 * y ese es el archivo cuyo lock debe sostener mientras habla con la red.
 *
 * **Se sincroniza lo RELEVANTE, y todo con `--all`.** Esto revoca a conciencia la decisión escrita en
 * `pipeline.ts`: "se envía todo lo verificado para poder inspeccionar el ranker con un filtro de
 * vista". El argumento era bueno cuando el store tenía cientos de registros; con 16.861 son 16.861
 * filas, y eso no es un tablero, es un volcado. El objetivo son 10-15 ofertas al día donde el perfil
 * cuadre, y para inspeccionar el ranker está `--digest-preview`, que no cuesta una petición.
 */
export async function runNotionSync(options: { root?: string; now?: Date; limit?: number; all?: boolean; dependencies?: { transport?: HttpTransport; env?: NodeJS.ProcessEnv } } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const local = await optionalJson(join(data, 'notion-local.json')) as { schemaVerified?: unknown; config?: unknown } | undefined;
  if (!local || local.schemaVerified !== true) throw new Error('notion_sync_disabled');
  const config = validateNotionConfig(local.config);
  if (!config.enabled) throw new Error('notion_sync_disabled');
  const now = options.now ?? new Date();
  const health = await sourceHealth(root, now);
  if (!health.healthy) throw new Error('checkpoint_unhealthy');
  // Lectura del checkpoint BAJO SU LOCK, y solo eso: son segundos, no los minutos de la red.
  const { records, bodies } = await withMailLock(join(data, 'source-cycle.json'), async () => {
    const checkpoint = await json(join(data, 'source-cycle.json')) as { store?: unknown };
    const store = parseStore(checkpoint.store);
    const profile = parseProfile(await json(join(root, 'examples/profile.json')));
    const ledger = parseLedger(await optionalJson(join(data, 'delivered.json')));
    const snapshot = report(store, profile, now);
    // Lo relevante, o lo que ya salió en un digest. Lo segundo importa: una oferta que Juan ya vio
    // y cuyo tier bajó no puede desaparecer del tablero, porque quizá ya se postuló a ella.
    const delivered = deliveredIds(ledger);
    const relevant = new Set(snapshot.records
      .filter(r => ['strong', 'possible'].includes(r.evaluation.relevance.tier) || delivered.has(r.id))
      .map(r => r.id));
    // El cuerpo se arma AQUÍ, dentro del lock de lectura, porque necesita la evaluación completa del
    // registro. Después el sync solo lo consulta por clave: la fase de red no vuelve al checkpoint.
    const bodies = new Map(snapshot.records.map(r => [r.id, pageBody({ opportunity: r.opportunity, evaluation: r.evaluation, profile,
      ...(snapshot.recommendations.find(x => x.id === r.id)?.selectionReason ? { selectionReason: snapshot.recommendations.find(x => x.id === r.id)!.selectionReason } : {}) })]));
    return { bodies, records: options.all === true ? snapshot.notion.records : snapshot.notion.records.filter(r => relevant.has(r.externalKey)) };
  });
  return withMailLock(join(data, 'notion-sync.json'), async () => {
    const transport = options.dependencies?.transport ?? createNotionTransport(fetch, options.dependencies?.env ?? process.env);
    // El esquema se COMPRUEBA contra la base, no se asume. Enviar una propiedad que no existe
    // hace que cada upsert devuelva 400 y `failed` iguale al total: fallar aquí cuesta una
    // petición, fallar después cuesta cientos y deja la base a medio escribir.
    const schema = await verifyNotionSchema(config, transport);
    if (!schema.ok) throw new SchemaMismatch(schema.issues);
    const result = await upsertNotionRecords(records, config, transport, { now: () => now, body: key => bodies.get(key), ...(options.limit !== undefined ? { limit: options.limit } : {}) });
    // Los fallos se guardan con su motivo y su clave. Un conteo suelto ("failed: 2") deja sin
    // forma de saber QUÉ falló ni de volver a esos registros: hay que recorrer 5.000 otra vez
    // para averiguarlo. Se acotan para que un fallo masivo no infle el archivo.
    const failures = result.records.filter(record => record.status === 'failed').slice(0, 50)
      .map(record => ({ index: record.index, reason: record.reason ?? 'unknown', externalKey: records[record.index]?.externalKey }));
    const summary = { version: 1 as const, generatedAt: now.toISOString(),
      counts: { created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed, total: result.records.length },
      bodies: result.bodies,
      ...(failures.length ? { failures } : {}) };
    await atomicMailWrite(join(data, 'notion-sync.json'), summary);
    return summary;
  });
}
/**
 * Traduce un fallo de Notion a un motivo accionable. Un `notion_sync_failed` genérico obliga a
 * adivinar entre "falta la llave", "la base no responde" y "la petición se rechazó": esconder la
 * causa cuesta más tiempo que cualquier fallo.
 */
function notionFailure(error: unknown): { code: string; hint?: string } {
  const message = error instanceof Error ? error.message : '';
  if (message === 'notion_credentials_missing_or_invalid') {
    return { code: message, hint: 'NOTION_API_KEY no está en el entorno. Ponla en ~/.config/offers/env (chmod 600) y ejecuta a través de bin/offers, no de node directamente.' };
  }
  if (message === 'notion_schema_unreadable') return { code: message, hint: 'La base respondió sin esquema o con error: revisa que la integración tenga acceso a esa data source.' };
  if (message === 'notion_transport_error') return { code: message, hint: 'No se pudo hablar con api.notion.com (red o timeout de 15 s).' };
  if (message === 'notion_request_rejected') return { code: message, hint: 'La URL o el método no pasaron la validación del transporte; revisa dataSourceId en data/notion-local.json.' };
  if (message === 'Configuración Notion inválida') return { code: 'notion_config_invalid', hint: 'data/notion-local.json no cumple el contrato de NotionConfig.' };
  return { code: 'notion_sync_failed' };
}
export async function sourcesMain(args: string[], root = repositoryRoot): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('bin/offers --dry-run [--enrich-model MODEL]   recolecta y persiste el checkpoint\n'
      + 'bin/offers --digest                          entrega el corte del dia (solo lectura)\n'
      + 'bin/offers --vacuum [--dry-run|--apply]      informa (o aplica) la purga del checkpoint\n'
      + 'bin/offers --pull-status [--dry-run]         lee los Estado del tablero -> eventos de seguimiento\n'
      + 'bin/offers --funnel [--cutoff TS]            embudo de postulaciones al corte\n'
      + 'bin/offers --upskill [--json]                que piden las ofertas que te sirven y no declaras\n'
      + 'bin/offers --probe-source ADAPTADOR TOKEN     sondea un board antes de anadirlo (solo lectura)\n'
      + 'bin/offers --digest-preview [--now TS] [--profile RUTA]\n'
      + '                                             imprime el corte SIN anotarlo: ni ledger, ni metricas\n'
      + 'bin/offers --health                          quorum de fuentes del ultimo ciclo\n'
      + 'bin/offers --refresh-sponsors                registro britanico de patrocinadores\n'
      + 'bin/offers --verify-schema                   compara la base Notion con lo que se enviaria\n'
      + 'bin/offers --apply-schema                    crea SOLO las columnas que faltan (nunca cambia tipos)\n'
      + 'bin/offers --sync [--all] [--limit N]         escribe en Notion lo relevante (--all: todo lo verificado)\n\n'
      + 'El secreto NOTION_API_KEY se carga desde ~/.config/offers/env (chmod 600) via bin/offers.\n'
      + '--sync comprueba el esquema REAL contra la base antes de escribir y pausa entre registros\n'
      + 'para respetar el limite de Notion. Usa --limit en la primera corrida.\n'
      + '--sync exits: 0 sincronizado, 2 argumentos invalidos, 3 lock ocupado, 4 fallo de sync,\n'
      + '5 sync deshabilitado, 6 checkpoint vencido, 7 sincronizado con registros fallidos,\n'
      + '8 el esquema de Notion no coincide.');
    return 0;
  }
  if (args.length === 1 && args[0] === '--health') {
    try {
      const health = await sourceHealth(root);
      console.log(JSON.stringify(health));
      // Sin checkpoint todavía no hay nada que juzgar: sale 0 para no disparar alertas
      // en cada instalación limpia hasta que el primer --dry-run complete.
      return health.healthy || health.reason === 'no_checkpoint' ? 0 : 4;
    } catch { console.error('source_health_unavailable'); return 4; }
  }
  if (args.length === 1 && args[0] === '--digest') {
    try { console.log(JSON.stringify(await runDigest({ root }))); return 0; }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('existe .lock')) { console.error('source_lock_busy'); return 3; }
      console.error(message === 'ledger_invalid' ? 'ledger_invalid' : 'digest_failed'); return 4;
    }
  }
  if (args[0] === '--pull-status') {
    const dryRun = args.length === 2 && args[1] === '--dry-run';
    if (!(args.length === 1 || dryRun)) { console.error('pull_status_arguments'); return 2; }
    try {
      console.log(JSON.stringify(await pullBoardStatus({ root, dryRun })));
      return 0;
    } catch (error) {
      // Un `Estado` desconocido sale con su propio código y NOMBRA los valores: "algo falló" obligaría
      // a abrir Notion a buscar qué select se añadió.
      if (error instanceof BoardStateUnknown) { console.error(`board_state_unknown: ${error.states.join(', ')}`); return 9; }
      const message = error instanceof Error ? error.message : '';
      if (message.includes('existe .lock')) { console.error('source_lock_busy'); return 3; }
      if (message === 'notion_sync_disabled') { console.error(message); return 5; }
      console.error(notionFailure(error).code); return 4;
    }
  }
  if (args[0] === '--upskill') {
    const asJson = args.length === 2 && args[1] === '--json';
    if (!(args.length === 1 || asJson)) { console.error('upskill_arguments'); return 2; }
    try {
      const { snapshot } = await computeDigest({ root });
      const profile = parseProfile(await json(join(root, 'examples/profile.json')));
      const report = upskillReport(snapshot.records, profile);
      console.log(asJson ? JSON.stringify(report) : renderUpskill(report));
      return 0;
    } catch (error) { console.error(error instanceof Error ? error.message : 'upskill_failed'); return 4; }
  }
  if (args[0] === '--funnel') {
    const cutoffAt = args.length === 3 && args[1] === '--cutoff' ? args[2] : undefined;
    if (!(args.length === 1 || cutoffAt !== undefined)) { console.error('funnel_arguments'); return 2; }
    const cutoff = cutoffAt ? new Date(cutoffAt) : undefined;
    if (cutoff && Number.isNaN(cutoff.getTime())) { console.error('funnel_cutoff_invalid'); return 2; }
    try {
      console.log(JSON.stringify(await applicationFunnel({ root, ...(cutoff ? { cutoff } : {}) })));
      return 0;
    } catch (error) { console.error(error instanceof Error ? error.message : 'funnel_failed'); return 4; }
  }
  if (args[0] === '--vacuum') {
    // `--dry-run` es la forma SEGURA y hay que pedir `--apply` para borrar. Al revés —borrar por
    // omisión— habría convertido un comando de inspección en una pérdida de datos por tipear mal.
    const apply = args.length === 2 && args[1] === '--apply';
    if (!(args.length === 1 || apply || (args.length === 2 && args[1] === '--dry-run'))) { console.error('vacuum_arguments'); return 2; }
    try {
      const report = await withMailLock(join(root, 'data/source-cycle.json'), () => vacuumCheckpoint({ root, apply }));
      console.log(JSON.stringify(report));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('existe .lock')) { console.error('source_lock_busy'); return 3; }
      console.error(message || 'vacuum_failed'); return 4;
    }
  }
  if (args[0] === '--probe-source') {
    const [, adapter, token] = args;
    // Un AGREGADOR no lleva token: el registro le fija el endpoint y rechaza `board`. Exigirlo
    // hacía que `--probe-source freehire x` fallara con `source_endpoint_invalid`, que parece un
    // fallo del proveedor cuando en realidad era la herramienta pidiendo un dato que no existe.
    const needsToken = adapter !== undefined && !AGGREGATOR_ADAPTERS.includes(adapter as typeof AGGREGATOR_ADAPTERS[number]);
    if (!adapter || (needsToken ? args.length !== 3 || !token : args.length !== 2)) { console.error('probe_source_arguments'); return 2; }
    try {
      // La fuente se construye POR EL REGISTRO, no a mano: así el sondeo valida exactamente lo
      // mismo que validará el ciclo, y el endpoint se arma una sola vez en todo el proyecto. Si
      // el registro rechaza esta configuración, el ciclo también la habría rechazado.
      const [source] = parseRegistry({ version: 1, sources: [{ id: 'probe', adapter, enabled: true, captureHtml: false,
        ...(!needsToken ? {} : adapter === 'rss' ? { endpoint: token } : { board: token, company: 'Probe' }) }] });
      const profile = parseProfile(await json(join(root, 'examples/profile.json')));
      console.log(JSON.stringify(await probeSource(source!, profile, new Date())));
      return 0;
    } catch (error) {
      console.log(JSON.stringify({ ok: false, adapter, board: token, reason: error instanceof Error ? error.message : 'probe_failed' }));
      return 4;
    }
  }
  if (args[0] === '--digest-preview') {
    // Se parsea a mano y se RECHAZA lo desconocido: un `--now` mal escrito que se ignorara en
    // silencio compararía dos cortes de fechas distintas y el diff mentiría sin avisar.
    const options: { root: string; now?: Date; profilePath?: string } = { root };
    for (let i = 1; i < args.length; i += 2) {
      const value = args[i + 1];
      if (value === undefined) { console.error('digest_preview_arguments'); return 2; }
      if (args[i] === '--now') {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) { console.error('digest_preview_now_invalid'); return 2; }
        options.now = parsed;
      } else if (args[i] === '--profile') options.profilePath = resolve(value);
      else { console.error('digest_preview_arguments'); return 2; }
    }
    try {
      const { lines, metric } = await previewDigest(options);
      for (const line of lines) console.log(line);
      console.log(JSON.stringify(metric));
      return 0;
    } catch (error) { console.error(error instanceof Error ? error.message : 'digest_preview_failed'); return 4; }
  }
  if (args.length === 1 && args[0] === '--refresh-sponsors') {
    try { console.log(JSON.stringify(await refreshSponsors({ root }))); return 0; }
    catch (error) { console.error(error instanceof Error && ['register_page_unavailable', 'register_link_not_found', 'register_download_failed', 'register_header_unexpected', 'register_empty'].includes(error.message) ? error.message : 'sponsors_refresh_failed'); return 4; }
  }
  if (args.length === 1 && args[0] === '--verify-schema') {
    try {
      const local = await optionalJson(join(root, 'data/notion-local.json')) as { config?: unknown } | undefined;
      if (!local?.config) { console.error('notion_sync_disabled'); return 5; }
      const transport = createNotionTransport();
      const schema = await verifyNotionSchema(local.config, transport);
      // Se imprime QUÉ falta y de qué tipo: "el esquema no coincide" no le sirve a nadie.
      console.log(JSON.stringify(schema, null, 2));
      return schema.ok ? 0 : 8;
    } catch (error) {
      const { code, hint } = notionFailure(error);
      console.error(hint ? `${code}\n${hint}` : code);
      return 4;
    }
  }
  if (args.length === 1 && args[0] === '--apply-schema') {
    try {
      const local = await optionalJson(join(root, 'data/notion-local.json')) as { config?: unknown } | undefined;
      if (!local?.config) { console.error('notion_sync_disabled'); return 5; }
      const result = await applyNotionSchema(local.config, createNotionTransport());
      console.log(JSON.stringify(result, null, 2));
      // Un tipo equivocado NO se corrige solo: cambiarlo puede vaciar la columna en Notion.
      return result.unresolved.length ? 8 : 0;
    } catch (error) {
      const { code, hint } = notionFailure(error);
      console.error(hint ? `${code}\n${hint}` : code);
      return 4;
    }
  }
  if (args[0] === '--sync') {
    // `--all` y `--limit N` son independientes y pueden combinarse. Se parsea a mano y se rechaza lo
    // desconocido: un `--all` mal escrito que se ignorara en silencio sincronizaría solo lo relevante
    // creyendo haber repoblado el tablero entero.
    const rest = args.slice(1);
    const all = rest.includes('--all');
    const limitAt = rest.indexOf('--limit');
    const limit = limitAt === -1 ? undefined : rest[limitAt + 1];
    const consumed = (all ? 1 : 0) + (limitAt === -1 ? 0 : 2);
    if (consumed !== rest.length || (limitAt !== -1 && !/^\d+$/.test(limit ?? ''))) { console.error('sync_arguments'); return 2; }
    try {
      const result = await runNotionSync({ root, ...(all ? { all } : {}), ...(limit !== undefined ? { limit: Number(limit) } : {}) });
      console.log(JSON.stringify({ counts: result.counts }));
      return result.counts.failed > 0 ? 7 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (error instanceof SchemaMismatch) {
        // Observado el 2026-09-21: minutos después de crear columnas con --apply-schema, una
        // lectura devolvió el esquema anterior mientras cinco lecturas posteriores lo daban por
        // completo. Abortar sigue siendo lo correcto —escribir contra un esquema equivocado
        // devuelve 400 en cada registro—, pero conviene decir que puede ser una lectura vieja.
        console.error(`notion_schema_mismatch\n${JSON.stringify(error.issues, null, 2)}\n`
          + 'Si acabas de crear estas propiedades, puede ser una lectura desactualizada de Notion:\n'
          + 'comprueba con `bin/offers --verify-schema` y reintenta. Si persiste, faltan de verdad.');
        return 8;
      }
      if (message.includes('existe .lock')) { console.error('source_lock_busy'); return 3; }
      if (message === 'notion_sync_disabled') { console.error('notion_sync_disabled'); return 5; }
      if (message === 'checkpoint_unhealthy') { console.error('checkpoint_unhealthy'); return 6; }
      const { code, hint } = notionFailure(error);
      console.error(hint ? `${code}\n${hint}` : code);
      return 4;
    }
  }
  if (args[0] !== '--dry-run' || ![1, 3].includes(args.length) || (args.length === 3 && (args[1] !== '--enrich-model' || !args[2]))) return 2;
  try {
    const stopHeapTracking = trackHeapPeak();
    const result = await runSources({ root, enrichModel: args[2] });
    console.log(JSON.stringify({ mode: result.mode, confirmed: false, counts: result.counts, heapPeakMb: stopHeapTracking(), health: result.health }));
    /**
     * El código de salida responde UNA pregunta: ¿se puede confiar en el resultado de esta corrida?
     * No responde "¿se portó bien cada proveedor?" — eso lo contesta `--health`, que además mira el
     * historial y sabe distinguir una caída puntual de una avería, cosa que una sola corrida no puede.
     *
     * Hasta hoy devolvía 6 si CUALQUIER fuente quedaba `partial` o `failed`. Con 33 fuentes siempre
     * hay alguna que da timeout, y `freehire` es `partial` permanente por diseño, así que el ciclo
     * salía 6 todas las horas de todos los días. Un semáforo en ámbar permanente no es un semáforo:
     * es la misma enfermedad que el quórum ya había curado en `--health`, viva a cuatro líneas de
     * distancia. Nadie consumía ese 6 salvo la columna de `launchctl list`, y ahí es donde más daño
     * hacía.
     *
     * El 6 no queda huérfano: sigue significando `checkpoint_unhealthy` en `--sync`. Ahora significa
     * una sola cosa en todo el archivo — "no confíes en este dato" — en vez de dos.
     */
    const enabledSources = result.health.filter(s => s.status !== 'disabled');
    const workingSources = enabledSources.filter(sourceContributed);
    // Un registro con todo deshabilitado no es un fallo del ciclo sino una configuración: el ciclo
    // hizo lo que se le pidió. Es `--health` quien debe marcar que ese checkpoint no sirve.
    if (enabledSources.length && workingSources.length / enabledSources.length < HEALTH_QUORUM) return 4;
    // Sin data/notion-local.json no hay esquema que verificar y el ciclo fue un éxito completo.
    // El 5 queda para el caso real: el operador declaró un destino Notion y no lo verificó.
    if (!result.notionLocalPresent) return 0;
    return result.notionPlan.blocked.some(b => 'reason' in b && b.reason === 'schema_unverified') ? 5 : 0;
  } catch (error) {
    const busy = error instanceof Error && error.message.includes('existe .lock');
    console.error(busy ? 'source_lock_busy' : 'source_cycle_failed'); return busy ? 3 : 4;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await sourcesMain(process.argv.slice(2));
