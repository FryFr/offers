import { captureEvidence, createNodeCaptureFetch, type CaptureFetch } from './evidence-capture.ts';
import { parseOpportunity, type Opportunity, type Profile } from './contracts.ts';
import { identity, ingest, report, type Store } from './pipeline.ts';
import { planNotionSync, validateNotionConfig } from './notion-sync.ts';
import { adaptSource, canonicalUrl, type CapturedJob } from './source-adapters.ts';
import { type Source, sourceHeaders } from './source-registry.ts';
import { safeRead, type SafeReadOptions } from './safe-http.ts';
import { validateEnrichment, type Enricher, type Enrichment } from './claude-enrichment.ts';
import { PUBLICATION_WINDOW_DAYS, classify } from './evaluate.ts';
import { relevance } from './relevance.ts';
import { matchesRegister } from './uk-sponsors.ts';

export interface SourceHealth { sourceId: string; status: 'ok' | 'partial' | 'failed' | 'disabled' | 'not_due'; fetched: number; rejected: number; reason?: string; checkedAt: string }
export interface SourceState { version: 1; lastAttempt: Record<string, string>; lastResult?: Record<string, 'ok' | 'partial' | 'failed'> }
const normalizeText = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
/** Only canonical URLs merge across providers; fuzzy title/company matches never establish identity. */
export function deduplicate(jobs: readonly CapturedJob[]): CapturedJob[] {
  const groups = new Map<string, CapturedJob>();
  for (const input of jobs) {
    const job = structuredClone(input), key = canonicalUrl(job.opportunity.url!);
    const previous = groups.get(key);
    if (!previous) { groups.set(key, job); continue; }
    const a = previous.opportunity, b = job.opportunity;
    const conflict = normalizeText(a.title) !== normalizeText(b.title) || normalizeText(a.company) !== normalizeText(b.company)
      || (!!a.publishedAt && !!b.publishedAt && a.publishedAt !== b.publishedAt)
      || (a.availability?.outcome === 'closed' && b.availability?.outcome === 'open')
      || (a.availability?.outcome === 'open' && b.availability?.outcome === 'closed');
    previous.provenance.push(...job.provenance.filter(p => !previous.provenance.some(old => JSON.stringify(old) === JSON.stringify(p))));
    previous.warnings = [...new Set([...previous.warnings, ...job.warnings])];
    if (conflict || previous.warnings.includes('duplicate_conflict')) {
      delete a.publishedAt; delete a.publicationEvidence;
      a.availability = { url: key, checkedAt: b.availability!.checkedAt, outcome: 'ambiguous', evidence: 'duplicate_conflict' };
      previous.warnings = [...new Set([...previous.warnings, 'duplicate_conflict'])];
    } else {
      if (!a.publishedAt && b.publishedAt) { a.publishedAt = b.publishedAt; a.publicationEvidence = b.publicationEvidence; }
      if (b.availability?.outcome === 'open' && a.availability?.outcome === 'ambiguous') a.availability = b.availability;
    }
  }
  return [...groups.values()].sort((a, b) => a.opportunity.url!.localeCompare(b.opportunity.url!));
}
export async function collectSource(source: Source, now: Date, options: SafeReadOptions & { env?: NodeJS.ProcessEnv; htmlFetch?: CaptureFetch } = {}) {
  let endpoint = source.endpoint; const jobs: CapturedJob[] = []; let rejected = 0;
  const seenIds = new Set<string>();
  for (let page = 0; page < 50; page++) {
    // Un listado de Greenhouse con `content=true` incluye el HTML de cada oferta y llega a ~10 MB
    // (medido 2026-09-20: databricks 9,6 MB, anthropic 8,9 MB). El cap global de 2 MB existe para
    // no tragar respuestas enormes, no para prohibir un listado legítimo: se eleva solo donde hace
    // falta, con techo duro, en vez de renunciar a la descripción del 70% del pool.
    // Arbeitnow entrega 250 ofertas con descripción en una sola respuesta: 2,21 MB medidos, justo
    // por encima del cap. Un listado legítimo no debería quedar fuera por 200 KB.
    const heavyListing = (source.adapter === 'greenhouse' && source.fetchContent) || source.adapter === 'arbeitnow';
    const response = await safeRead(endpoint, { ...options, headers: { 'user-agent': USER_AGENT, ...sourceHeaders(source, options.env ?? process.env) },
      ...(heavyListing ? { maxBytes: 16_000_000, timeoutMs: 30_000 } : {}),
      contentTypes: source.adapter === 'rss' ? ['application/rss+xml', 'application/xml', 'text/xml'] : ['application/json'] });
    if (response.status !== 200) throw new Error(response.status === 429 ? 'source_rate_limited' : 'source_http_error');
    const adapted = adaptSource(source, response.body, now, response.finalUrl);
    rejected += adapted.rejected;
    const paging = PAGINATION[source.adapter];
    for (const job of adapted.jobs) {
      const id = job.provenance[0]!.externalId;
      // Un cursor o un offset que no avanza haría girar el bucle hasta el techo de páginas.
      if (seenIds.has(id) && paging && page > 0) throw new Error('source_pagination_repeated');
      seenIds.add(id); jobs.push(job);
    }
    if (!paging || jobs.length >= MAX_ROWS_PER_SOURCE) break;
    // La ventana de publicación acota el coste: cuando ninguna oferta FECHADA de la página cae
    // dentro, seguir paginando solo trae material que el gate de frescura va a bloquear igual.
    // Las ofertas sin fecha no cuentan como "dentro": si lo hicieran, un feed con fechas ausentes
    // paginaría hasta el techo sin traer nada elegible.
    const cutoff = now.getTime() - (PUBLICATION_WINDOW_DAYS + 1) * 86_400_000;
    if (!adapted.jobs.some(job => job.opportunity.publishedAt && Date.parse(job.opportunity.publishedAt) >= cutoff)) break;
    const next = new URL(source.endpoint);
    if (paging.style === 'offset') {
      if (adapted.jobs.length + adapted.rejected < paging.pageSize) break;
      next.searchParams.set(paging.param, String((page + 1) * paging.pageSize));
    } else {
      if (!adapted.nextCursor) break;
      next.searchParams.set(paging.param, adapted.nextCursor);
    }
    // Agotar el presupuesto de páginas es una parada normal, no un fallo: se tomaron las más
    // frescas y se deja de pedir. Solo las páginas repetidas indican un cursor roto.
    if (page + 1 >= MAX_PAGES) break;
    endpoint = next.toString();
  }
  if (source.captureHtml) for (const [index, job] of jobs.entries()) {
    if (index >= 100) {
      job.opportunity.availability = { url: job.opportunity.url!, checkedAt: now.toISOString(), outcome: 'ambiguous', evidence: 'html_capture_budget' };
      job.warnings.push('html_capture_budget'); rejected++; continue;
    }
    const capture = await captureEvidence(job.opportunity, { fetch: options.htmlFetch ?? createNodeCaptureFetch(), resolveHost: options.resolveHost, now: () => now });
    // Replace availability even on failure; preserve an explicit API/feed publication date only if HTML does not contradict it.
    if (capture.publishedAt && job.opportunity.publishedAt && capture.publishedAt !== job.opportunity.publishedAt) {
      delete job.opportunity.publishedAt; delete job.opportunity.publicationEvidence;
      job.opportunity.availability = { ...capture.availability, outcome: 'ambiguous', evidence: 'publication_conflict' };
      job.warnings.push('publication_conflict');
    } else {
      job.opportunity.availability = capture.availability;
      if (capture.publishedAt) { job.opportunity.publishedAt = capture.publishedAt; job.opportunity.publicationEvidence = capture.publicationEvidence; }
    }
  }
  return { jobs, rejected };
}
/**
 * Cómo pagina cada proveedor. Antes esto estaba incrustado en tres condicionales con el nombre
 * "lever" dentro, así que un proveedor con cursor no tenía dónde encajar.
 */
type Pagination = { style: 'offset'; param: string; pageSize: number } | { style: 'cursor'; param: string };
const PAGINATION: Partial<Record<Source['adapter'], Pagination>> = {
  lever: { style: 'offset', param: 'skip', pageSize: 100 },
  himalayas: { style: 'cursor', param: 'cursor' },
};
/** Techo por fuente y ciclo. Himalayas publica 105.000 ofertas: paginar hasta el fondo no es opción. */
const MAX_ROWS_PER_SOURCE = 2_000;
/** Peticiones por fuente y ciclo. Medido: Himalayas devuelve 20 filas por página, ignora `limit`. */
const MAX_PAGES = 25;
/**
 * Capturas de evidencia HTML por ciclo sobre ofertas de fuentes no autoritativas. Cada una es una
 * petición: el presupuesto acotado es lo que hace viable comprobar disponibilidad sin martillar
 * a los proveedores ni alargar el ciclo.
 */
const RELEVANT_CAPTURE_BUDGET = 40;
/**
 * Identificación honesta del cliente. Arbeitnow responde 403 a peticiones sin user-agent
 * (medido 2026-09-20); decir quién llama es cortesía con el proveedor, no disfraz.
 */
const USER_AGENT = 'offers-job-pipeline/1.0 (personal job search; contact via source repository)';
export interface CycleOptions extends SafeReadOptions {
  sources: Source[]; profile: Profile; store?: Store; state?: SourceState; now?: Date;
  notionConfig?: unknown; env?: NodeJS.ProcessEnv; htmlFetch?: CaptureFetch; enrich?: Enricher;
  /** Índice del registro británico de patrocinadores; ausente, el cruce simplemente no ocurre. */
  sponsorRegister?: ReadonlySet<string>;
  mode?: 'dry-run';
}
export async function runSourceCycle(options: CycleOptions) {
  if (options.mode !== undefined && options.mode !== 'dry-run') throw new Error('external_writes_disabled');
  const now = options.now ?? new Date(), checkedAt = now.toISOString();
  const state: SourceState = structuredClone(options.state ?? { version: 1, lastAttempt: {} });
  state.lastResult ??= {};
  const health: SourceHealth[] = [], captures: CapturedJob[] = [];
  // Validate Notion config before network activity; enabled configs cannot cross this entrypoint.
  const config = options.notionConfig === undefined ? undefined : validateNotionConfig(options.notionConfig);
  if (config?.enabled) throw new Error('external_writes_disabled');
  for (const source of options.sources) {
    const base = { sourceId: source.id, fetched: 0, rejected: 0, checkedAt };
    if (!source.enabled) { health.push({ ...base, status: 'disabled' }); continue; }
    const last = state.lastAttempt[source.id];
    if (last && (!Number.isFinite(Date.parse(last)) || Date.parse(last) > now.getTime())) {
      state.lastResult[source.id] = 'failed'; health.push({ ...base, status: 'failed', reason: 'source_clock_invalid' }); continue;
    }
    if (last && now.getTime() - Date.parse(last) < source.minIntervalMinutes * 60_000) { health.push({ ...base, status: state.lastResult[source.id] === 'failed' ? 'failed' : state.lastResult[source.id] === 'partial' ? 'partial' : 'not_due', reason: 'cadence_not_due' }); continue; }
    state.lastAttempt[source.id] = checkedAt;
    try {
      const result = await collectSource(source, now, options);
      captures.push(...result.jobs);
      state.lastResult[source.id] = result.rejected ? 'partial' : 'ok';
      health.push({ ...base, status: result.rejected ? 'partial' : 'ok', fetched: result.jobs.length, rejected: result.rejected });
    } catch (error) {
      state.lastResult[source.id] = 'failed';
      const code = error instanceof Error ? error.message : '';
      const safeCodes = ['source_secret_missing', 'source_http_error', 'source_rate_limited', 'source_pagination_repeated', 'source_page_limit', 'ssrf_blocked', 'request_timeout', 'response_too_large', 'unsupported_content_type', 'credential_redirect_blocked', 'too_many_redirects'];
      health.push({ ...base, status: 'failed', reason: safeCodes.includes(code) ? code : 'source_invalid_or_unavailable' });
    }
  }
  const jobs = deduplicate(captures);
  // Cruce con el registro oficial británico. Solo llena el hueco: una oferta que YA declara por
  // escrito que patrocina no se degrada a un dato administrativo del empleador.
  if (options.sponsorRegister?.size) {
    for (const job of jobs) {
      const o = job.opportunity;
      if (o.sponsorship || !matchesRegister(o.company, o.location, options.sponsorRegister)) continue;
      job.opportunity = parseOpportunity({ ...o, sponsorship: { status: 'employer_registered', scope: 'uk_skilled_worker',
        evidence: { kind: 'registry_match', source: 'uk_register_of_licensed_sponsors', quote: o.company, observedAt: checkedAt } } });
    }
  }
  /**
   * La trampa de la disponibilidad. Un agregador es un espejo con retraso: su presencia no
   * confirma que la vacante siga abierta, así que entra como `ambiguous` y el gate la bloquea
   * para siempre. Sin resolver esto, añadir agregadores rinde CERO ofertas elegibles — es
   * exactamente lo que le pasaba a Remotive, con 17 capturas y 17 bloqueos.
   *
   * La salida no es confiar en el feed, es comprobar. Y comprobar cuesta una petición por oferta,
   * así que se comprueban solo las que ya pasaron el filtro determinista de relevancia: de miles
   * de capturas a unas decenas por ciclo, ordenadas por lo que más le sirve a esta persona.
   */
  const pending = jobs.filter(job => job.opportunity.availability?.outcome === 'ambiguous'
    && !job.warnings.includes('duplicate_conflict') && !job.warnings.includes('html_capture_budget'));
  const worthChecking = pending
    .map(job => ({ job, score: relevance(job.opportunity, options.profile, classify(job.opportunity).kind) }))
    .filter(entry => entry.score.tier !== 'off_target')
    .sort((a, b) => b.score.score - a.score.score || a.job.opportunity.url!.localeCompare(b.job.opportunity.url!))
    .slice(0, RELEVANT_CAPTURE_BUDGET);
  for (const { job } of worthChecking) {
    try {
      const capture = await captureEvidence(job.opportunity, { fetch: options.htmlFetch ?? createNodeCaptureFetch(), resolveHost: options.resolveHost, now: () => now });
      if (capture.publishedAt && job.opportunity.publishedAt && capture.publishedAt !== job.opportunity.publishedAt) {
        delete job.opportunity.publishedAt; delete job.opportunity.publicationEvidence;
        job.opportunity.availability = { ...capture.availability, outcome: 'ambiguous', evidence: 'publication_conflict' };
        job.warnings.push('publication_conflict');
      } else {
        job.opportunity.availability = capture.availability;
        if (capture.publishedAt) { job.opportunity.publishedAt = capture.publishedAt; job.opportunity.publicationEvidence = capture.publicationEvidence; }
      }
    } catch { job.warnings.push('relevant_capture_failed'); }
  }
  const enrichments: Record<string, Enrichment> = {};
  let enrichedCount = 0;
  for (const job of jobs) if (options.enrich && job.opportunity.description && !job.warnings.includes('duplicate_conflict')) {
    if (enrichedCount++ >= 100) { job.warnings.push('enrichment_budget'); continue; }
    try { enrichments[identity(job.opportunity)] = validateEnrichment(await options.enrich(structuredClone(job)), job.opportunity.description); }
    catch { job.warnings.push('enrichment_failed'); }
  }
  const previous = options.store ?? { version: 1, records: [] };
  // Existing source-ID keyed records retain their keys. Ambiguous legacy URL aliases are quarantined.
  //
  // Indexed once instead of re-canonicalising every stored record per job, and tolerant of records
  // whose URL canonicalUrl() rejects: a record that cannot be canonicalised simply cannot alias an
  // incoming job, so it is skipped rather than allowed to abort the cycle. Measured 2026-09-19: with
  // 46 LinkedIn alert records in data/offers.json the whole run died with `source_disallowed` thrown
  // out of this filter, because safe-http disallows linkedin.com by design — one unreachable host in
  // the existing store took down every source.
  const legacyByUrl = new Map<string, Opportunity[]>();
  for (const r of previous.records) {
    if (!r.opportunity.url) continue;
    let key: string;
    try { key = canonicalUrl(r.opportunity.url); } catch { continue; }
    const bucket = legacyByUrl.get(key);
    if (bucket) bucket.push(r.opportunity); else legacyByUrl.set(key, [r.opportunity]);
  }
  const incoming = jobs.flatMap(job => {
    const matches = legacyByUrl.get(job.opportunity.url!) ?? [];
    if (matches.length > 1) { job.warnings.push('legacy_duplicate_conflict'); return []; }
    const legacy = matches[0];
    return [{ ...job.opportunity, ...(legacy?.externalId ? { source: legacy.source, externalId: legacy.externalId } : {}) }];
  });
  let store = ingest(previous, incoming);
  // Old aliases with unresolved duplicates cannot remain eligible in this plan.
  const ambiguousUrls = new Set(jobs.filter(j => j.warnings.includes('legacy_duplicate_conflict')).map(j => j.opportunity.url));
  store = ingest(store, store.records.filter(r => ambiguousUrls.has(r.opportunity.url)).map(r => ({ ...r.opportunity,
    availability: { url: r.opportunity.url!, checkedAt, outcome: 'ambiguous', evidence: 'legacy_duplicate_conflict' } })));
  const snapshot = report(store, options.profile, now);
  const notionPlan = config ? planNotionSync(snapshot.notion.records, config, now) : { mode: 'dry-run' as const, confirmed: false as const,
    records: [] as { externalKey: string }[], blocked: snapshot.records.map(r => ({ externalKey: r.id, reason: 'schema_unverified' })) };
  return { version: 1 as const, mode: 'dry-run' as const, confirmed: false as const, generatedAt: checkedAt, state, health, jobs, enrichments, store, notionPlan,
    counts: { captured: captures.length, unique: jobs.length, duplicates: captures.length - jobs.length, eligible: notionPlan.records.length, blocked: notionPlan.blocked.length } };
}

/**
 * Sondea un board ANTES de añadirlo a `examples/sources.json`. Solo lee: no escribe checkpoint,
 * ni estado de fuente, ni evidencia.
 *
 * Existe porque adivinar el identificador de un board acierta poco —cinco intentos a mano en el
 * plan dieron dos— y porque un board que existe no es lo mismo que un board que sirve. Reporta
 * las tres cosas que deciden:
 *
 * - `withPublishedAt`: sin fecha, el gate de frescura tumba el 100% de sus ofertas. Ese fue
 *   exactamente el fallo del adaptador de Greenhouse, y costó seis sesiones encontrarlo.
 * - `geoViable`: cuántas sobreviven la compuerta de geografía del perfil. Medido el 2026-09-22,
 *   `remote_region_excluded` bloquea el 98% del pool actual —son "Remote, US only"—, así que el
 *   volumen bruto de un board no dice nada sobre lo que aportará al corte.
 * - `sample`: para leer con los ojos si el board publica el puesto que uno busca.
 */
export async function probeSource(source: Source, profile: Profile, now: Date, options: SafeReadOptions = {}) {
  const { jobs, rejected } = await collectSource(source, now, options);
  const windowStart = now.getTime() - PUBLICATION_WINDOW_DAYS * 86_400_000;
  const scored = jobs.map(job => ({ job, relevance: relevance(job.opportunity, profile, classify(job.opportunity).kind) }));
  return {
    ok: true, adapter: source.adapter, board: source.board ?? source.endpoint,
    jobs: jobs.length, rejected,
    withPublishedAt: jobs.filter(j => j.opportunity.publishedAt).length,
    withinWindow: jobs.filter(j => j.opportunity.publishedAt && Date.parse(j.opportunity.publishedAt) >= windowStart).length,
    remote: jobs.filter(j => j.opportunity.remote === true || j.opportunity.remoteness === 'fully_remote').length,
    geoViable: scored.filter(s => !s.relevance.blockers.some(b => b.startsWith('remote_') || b.startsWith('onsite_'))).length,
    roleRelevant: scored.filter(s => ['strong', 'possible'].includes(s.relevance.tier)).length,
    sample: scored.filter(s => ['strong', 'possible'].includes(s.relevance.tier)).slice(0, 5).map(s => s.job.opportunity.title),
  };
}
