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
export async function runDigest(options: { root?: string; now?: Date } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  await mkdir(join(data, 'digest'), { recursive: true, mode: 0o700 });
  return withMailLock(join(data, 'automation'), async () => {
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
/** Lo único que `sourceHealth` necesita del ciclo, y nada más. Unos pocos KB. */
interface HealthSnapshot { generatedAt?: string; health?: { status?: string; sourceId?: string }[]; mode?: string; confirmed?: boolean; counts?: unknown }
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
  const working = enabled.filter(s => ['ok', 'not_due'].includes(s.status ?? ''));
  const ratio = enabled.length ? working.length / enabled.length : 0;
  const healthy = fresh && enabled.length > 0 && ratio >= HEALTH_QUORUM;
  const quorum = { working: working.length, enabled: enabled.length, required: HEALTH_QUORUM,
    degraded: enabled.filter(s => !['ok', 'not_due'].includes(s.status ?? '')).map(s => s.sourceId ?? '?') };
  return { healthy, ...(healthy ? {} : { reason: 'checkpoint_degraded' as HealthReason }), mode: 'dry-run', confirmed: false, generatedAt: checkpoint.generatedAt, counts: checkpoint.counts, quorum };
}
/** Reads the existing checkpoint store/profile and the existing writer only; never recollects sources or revalidates cadence. */
/** Lleva la lista de diferencias para que el CLI pueda decir QUÉ falta, no solo que algo falla. */
export class SchemaMismatch extends Error {
  issues: SchemaIssue[];
  constructor(issues: SchemaIssue[]) { super('notion_schema_mismatch'); this.issues = issues; }
}
export async function runNotionSync(options: { root?: string; now?: Date; limit?: number; dependencies?: { transport?: HttpTransport; env?: NodeJS.ProcessEnv } } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  return withMailLock(join(data, 'automation'), () => withMailLock(join(data, 'source-cycle.json'), async () => {
    const local = await optionalJson(join(data, 'notion-local.json')) as { schemaVerified?: unknown; config?: unknown } | undefined;
    if (!local || local.schemaVerified !== true) throw new Error('notion_sync_disabled');
    const config = validateNotionConfig(local.config);
    if (!config.enabled) throw new Error('notion_sync_disabled');
    const now = options.now ?? new Date();
    const health = await sourceHealth(root, now);
    if (!health.healthy) throw new Error('checkpoint_unhealthy');
    const checkpoint = await json(join(data, 'source-cycle.json')) as { store?: unknown };
    const store = parseStore(checkpoint.store);
    const profile = parseProfile(await json(join(root, 'examples/profile.json')));
    const records = report(store, profile, now).notion.records;
    const transport = options.dependencies?.transport ?? createNotionTransport(fetch, options.dependencies?.env ?? process.env);
    // El esquema se COMPRUEBA contra la base, no se asume. Enviar una propiedad que no existe
    // hace que cada upsert devuelva 400 y `failed` iguale al total: fallar aquí cuesta una
    // petición, fallar después cuesta cientos y deja la base a medio escribir.
    const schema = await verifyNotionSchema(config, transport);
    if (!schema.ok) throw new SchemaMismatch(schema.issues);
    const result = await upsertNotionRecords(records, config, transport, { now: () => now, ...(options.limit !== undefined ? { limit: options.limit } : {}) });
    // Los fallos se guardan con su motivo y su clave. Un conteo suelto ("failed: 2") deja sin
    // forma de saber QUÉ falló ni de volver a esos registros: hay que recorrer 5.000 otra vez
    // para averiguarlo. Se acotan para que un fallo masivo no infle el archivo.
    const failures = result.records.filter(record => record.status === 'failed').slice(0, 50)
      .map(record => ({ index: record.index, reason: record.reason ?? 'unknown', externalKey: records[record.index]?.externalKey }));
    const summary = { version: 1 as const, generatedAt: now.toISOString(),
      counts: { created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed, total: result.records.length },
      ...(failures.length ? { failures } : {}) };
    await atomicMailWrite(join(data, 'notion-sync.json'), summary);
    return summary;
  }));
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
      + 'bin/offers --probe-source ADAPTADOR TOKEN     sondea un board antes de anadirlo (solo lectura)\n'
      + 'bin/offers --digest-preview [--now TS] [--profile RUTA]\n'
      + '                                             imprime el corte SIN anotarlo: ni ledger, ni metricas\n'
      + 'bin/offers --health                          quorum de fuentes del ultimo ciclo\n'
      + 'bin/offers --refresh-sponsors                registro britanico de patrocinadores\n'
      + 'bin/offers --verify-schema                   compara la base Notion con lo que se enviaria\n'
      + 'bin/offers --apply-schema                    crea SOLO las columnas que faltan (nunca cambia tipos)\n'
      + 'bin/offers --sync [--limit N]                escribe en Notion (exige esquema verificado)\n\n'
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
  if (args[0] === '--sync' && [1, 3].includes(args.length) && (args.length === 1 || (args[1] === '--limit' && /^\d+$/.test(args[2] ?? '')))) {
    try {
      const result = await runNotionSync({ root, ...(args.length === 3 ? { limit: Number(args[2]) } : {}) });
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
    // El quórum manda también aquí: una fuente rota de veinte no convierte un ciclo útil en un
    // fallo. El 4 queda para cuando la mayoría no respondió y el resultado no es fiable.
    const enabledSources = result.health.filter(s => s.status !== 'disabled');
    const workingSources = enabledSources.filter(s => ['ok', 'not_due'].includes(s.status));
    // Un registro con todo deshabilitado no es un fallo del ciclo sino una configuración: el ciclo
    // hizo lo que se le pidió. Es `--health` quien debe marcar que ese checkpoint no sirve.
    if (enabledSources.length && workingSources.length / enabledSources.length < HEALTH_QUORUM) return 4;
    if (result.health.some(s => s.status === 'partial' || s.status === 'failed')) return 6;
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
