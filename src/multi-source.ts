import { captureEvidence, createNodeCaptureFetch, type CaptureFetch } from './evidence-capture.ts';
import { type Opportunity, type Profile } from './contracts.ts';
import { identity, ingest, report, type Store } from './pipeline.ts';
import { planNotionSync, validateNotionConfig } from './notion-sync.ts';
import { adaptSource, canonicalUrl, type CapturedJob } from './source-adapters.ts';
import { type Source, sourceHeaders } from './source-registry.ts';
import { safeRead, type SafeReadOptions } from './safe-http.ts';
import { validateEnrichment, type Enricher, type Enrichment } from './claude-enrichment.ts';

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
    const response = await safeRead(endpoint, { ...options, headers: sourceHeaders(source, options.env ?? process.env),
      contentTypes: source.adapter === 'rss' ? ['application/rss+xml', 'application/xml', 'text/xml'] : ['application/json'] });
    if (response.status !== 200) throw new Error(response.status === 429 ? 'source_rate_limited' : 'source_http_error');
    const adapted = adaptSource(source, response.body, now, response.finalUrl);
    rejected += adapted.rejected;
    for (const job of adapted.jobs) {
      const id = job.provenance[0]!.externalId;
      if (seenIds.has(id) && source.adapter === 'lever' && page > 0) throw new Error('source_pagination_repeated');
      seenIds.add(id); jobs.push(job);
    }
    if (source.adapter !== 'lever' || adapted.jobs.length + adapted.rejected < 100) break;
    if (page === 49) throw new Error('source_page_limit');
    const next = new URL(source.endpoint); next.searchParams.set('skip', String((page + 1) * 100)); endpoint = next.toString();
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
export interface CycleOptions extends SafeReadOptions {
  sources: Source[]; profile: Profile; store?: Store; state?: SourceState; now?: Date;
  notionConfig?: unknown; env?: NodeJS.ProcessEnv; htmlFetch?: CaptureFetch; enrich?: Enricher;
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
  const notionPlan = config ? planNotionSync(snapshot.notion.records, config, now) : { mode: 'dry-run' as const, confirmed: false,
    records: [], blocked: snapshot.records.map(r => ({ externalKey: r.id, reason: 'schema_unverified' })) };
  return { version: 1 as const, mode: 'dry-run' as const, confirmed: false as const, generatedAt: checkedAt, state, health, jobs, enrichments, store, notionPlan,
    counts: { captured: captures.length, unique: jobs.length, duplicates: captures.length - jobs.length, eligible: notionPlan.records.length, blocked: notionPlan.blocked.length } };
}
