import { createHash } from 'node:crypto';
import { parseOpportunity, type Opportunity } from './contracts.ts';
import type { Source } from './source-registry.ts';
import { validatePublicUrl } from './safe-http.ts';
import { parseRss } from './rss.ts';

export interface Provenance { sourceId: string; adapter: Source['adapter']; externalId: string; endpoint: string; originalUrl: string; observedAt: string; payloadHash: string; publicationField?: string }
export interface CapturedJob { opportunity: Opportunity; provenance: Provenance[]; warnings: string[] }
export const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('malformed_record');
  return v as Record<string, unknown>;
};
function text(v: unknown, max = 100_000): string { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('malformed_text'); return v.trim(); }
const optional = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim().slice(0, 100_000) : undefined;
export function canonicalUrl(raw: string): string {
  const url = validatePublicUrl(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort(); url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}
function publication(raw: unknown, now: Date, rss = false): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  if (!rss && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(raw)) return undefined;
  if (rss) {
    const parts = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+\d{2}:\d{2}(?::\d{2})?\s+(?:GMT|UT|[+-]\d{4})$/i.exec(raw);
    if (!parts) return undefined;
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(parts[2]!.toLowerCase()) + 1;
    const day = `${parts[3]}-${String(month).padStart(2, '0')}-${parts[1]!.padStart(2, '0')}`;
    if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) return undefined;
  }
  const parsed = Date.parse(!rss && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw}Z` : raw);
  if (!Number.isFinite(parsed) || parsed > now.getTime()) return undefined;
  if (!rss) {
    const date = raw.slice(0, 10);
    if (new Date(Date.parse(date)).toISOString().slice(0, 10) !== date) return undefined;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}
export function adaptSource(source: Source, body: string, now: Date, endpoint = source.endpoint): { jobs: CapturedJob[]; rejected: number } {
  const payload: unknown = source.adapter === 'rss' ? parseRss(body) : JSON.parse(body);
  const rows = ['lever', 'rss'].includes(source.adapter) ? payload : object(payload).jobs;
  if (!Array.isArray(rows) || rows.length > 10_000) throw new Error('malformed_feed');
  let rejected = 0; const jobs: CapturedJob[] = [];
  for (const raw of rows) {
    try {
      const r = object(raw);
      if (source.adapter === 'ashby' && r.isListed !== true) { rejected++; continue; }
      if (source.adapter === 'greenhouse' && r.internal_job_id === null) { rejected++; continue; }
      let title: unknown = r.title, company: unknown = source.company, url: unknown, id: unknown = r.id;
      let date: unknown, dateField: string | undefined, description: unknown, location: unknown, remote: boolean | undefined;
      switch (source.adapter) {
        case 'remotive':
          company = r.company_name; url = r.url; date = r.publication_date; dateField = 'publication_date'; description = r.description; location = r.candidate_required_location; remote = true; break;
        case 'greenhouse':
          // first_published, NOT updated_at: the board rewrites updated_at continuously, so it
          // reports every posting as fresh. Measured 2026-09-19 on boards/vercel/jobs (84 jobs):
          // updated_at <=3d for 84/84 (median 2d) while first_published <=3d for 4/84 (median 71d).
          // Using updated_at would let a 71-day-old posting clear the three-day freshness gate.
          url = r.absolute_url; date = r.first_published; dateField = 'first_published';
          description = r.content; location = r.location && object(r.location).name; break;
        case 'lever':
          // No date: Lever's createdAt is epoch milliseconds (a number) and publication() only
          // accepts ISO-8601 strings, so wiring it here would silently yield undefined. Needs a
          // converter plus a real-board measurement before it can be trusted — not done yet.
          title = r.text; url = r.hostedUrl; description = r.descriptionPlain; location = r.categories && object(r.categories).location;
          remote = r.workplaceType === 'remote' ? true : r.workplaceType === 'on-site' ? false : undefined; break;
        case 'ashby':
          url = r.jobUrl; id = r.id ?? r.jobUrl; date = r.publishedAt; dateField = 'publishedAt'; description = r.descriptionPlain; location = r.location;
          remote = typeof r.isRemote === 'boolean' ? r.isRemote : undefined; break;
        case 'rss': {
          url = r.link; id = r.guid ?? r.link; date = r.pubDate; dateField = 'pubDate'; description = r.description;
          company = r.company ?? source.company;
          if (!company && typeof title === 'string') {
            const hostname = new URL(source.endpoint).hostname;
            // WWR's public RSS titles explicitly encode "Company: Role". Other feeds require company.
            if (hostname === 'weworkremotely.com') {
              const delimiter = title.indexOf(': ');
              if (delimiter > 0) { company = title.slice(0, delimiter); title = title.slice(delimiter + 2); }
            } else if (hostname === 'jobscollider.com' || hostname === 'remotefirstjobs.com') {
              const match = / at (.+)$/.exec(title);
              if (match) { company = match[1]; title = title.slice(0, match.index); }
            }
          }
          break;
        }
      }
      const originalUrl = text(url, 2000), normalizedUrl = canonicalUrl(originalUrl);
      const externalId = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? String(id) : text(id, 1024);
      const observedAt = now.toISOString();
      const publishedAt = publication(date, now, source.adapter === 'rss');
      const trustedAvailability = ['greenhouse', 'lever', 'ashby'].includes(source.adapter);
      const opportunity = parseOpportunity({ title: text(title, 500), company: text(company, 200), url: normalizedUrl, source: source.id, skills: [],
        ...(optional(description) ? { description: optional(description) } : {}), ...(optional(location) ? { location: optional(location) } : {}),
        ...(remote !== undefined ? { remote } : {}),
        ...(publishedAt ? { publishedAt, publicationEvidence: { url: normalizedUrl, observedAt, excerpt: JSON.stringify({ endpoint, field: dateField, value: date }).slice(0, 1000) } } : {}),
        availability: { url: normalizedUrl, checkedAt: observedAt, outcome: trustedAvailability ? 'open' : 'ambiguous', httpStatus: 200,
          evidence: trustedAvailability ? `public_ats_listing:${endpoint}#${externalId}` : 'feed_presence_does_not_confirm_availability' },
      });
      jobs.push({ opportunity, provenance: [{ sourceId: source.id, adapter: source.adapter, externalId, endpoint, originalUrl, observedAt,
        payloadHash: createHash('sha256').update(JSON.stringify(raw)).digest('hex'), ...(publishedAt ? { publicationField: dateField } : {}) }],
        warnings: [...(!publishedAt ? ['publication_missing_or_invalid'] : []), ...(!trustedAvailability ? ['availability_requires_capture'] : [])] });
    } catch { rejected++; }
  }
  return { jobs, rejected };
}
