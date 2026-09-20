import { assertSafeUrl as safeUrl, resolvePublicHost, createPinnedTransport } from './safe-http.ts';
import type { AvailabilityEvidence, Opportunity, PublicationEvidence } from './contracts.ts';

export interface CaptureFetchRequest { url: string; signal: AbortSignal; addresses?: string[] }
export interface CaptureFetchResponse { status: number; headers: Record<string, string>; body: string }
/** Never called before the target host clears the SSRF check; the caller only supplies transport, not policy. */
export type CaptureFetch = (request: CaptureFetchRequest) => Promise<CaptureFetchResponse>;
export type ResolveHost = (hostname: string) => Promise<string[]>;
export interface CaptureOptions {
  fetch: CaptureFetch;
  resolveHost?: ResolveHost;
  now?: () => Date;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
}
export interface CaptureResult {
  publishedAt?: string;
  publicationEvidence?: PublicationEvidence;
  availability: AvailabilityEvidence;
}

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES = 2_000_000;
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

const defaultResolveHost = resolvePublicHost;
async function assertSafeUrl(raw: string, resolver: ResolveHost): Promise<URL> {
  return (await safeUrl(raw, resolver)).url;
}
function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const lower = html.toLowerCase();
  let cursor = 0, templateDepth = 0;
  // Small non-executing tokenizer: skip comments, quoted attributes and inert/raw-text elements.
  // A regex over the whole document would mistake examples inside comments/textarea for evidence.
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      cursor = end < 0 ? html.length : end + 3; continue;
    }
    let end = start + 1, quote = '';
    for (; end < html.length && end - start <= 4096; end++) {
      const char = html[end]!;
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= html.length || end - start > 4096) break;
    const tag = html.slice(start + 1, end);
    cursor = end + 1;
    const match = /^(\/?)([a-z][a-z0-9:-]*)(?:\s|$)/i.exec(tag);
    if (!match) continue;
    const name = match[2]!.toLowerCase();
    if (name === 'template') { templateDepth = Math.max(0, templateDepth + (match[1] ? -1 : 1)); continue; }
    if (match[1]) continue;
    if (name === 'plaintext') break;
    if (!['script', 'textarea', 'style', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].includes(name)) continue;
    const closing = new RegExp(`</${name}\\s*>`, 'g'); closing.lastIndex = cursor;
    const close = closing.exec(lower);
    if (!close) break;
    const body = html.slice(cursor, close.index); cursor = close.index + close[0].length;
    if (name !== 'script' || templateDepth) continue;
    const attrs = tag.slice(name.length);
    const attributes: { name: string; value: string }[] = [];
    const attribute = /\s*([^\s="'<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
    let consumed = 0, item: RegExpExecArray | null;
    while ((item = attribute.exec(attrs))) {
      consumed = attribute.lastIndex;
      attributes.push({ name: item[1]!.toLowerCase(), value: item[2] ?? item[3] ?? item[4] ?? '' });
    }
    if (attrs.slice(consumed).trim()) continue;
    const types = attributes.filter(a => a.name === 'type');
    if (types.length !== 1 || types[0]!.value.toLowerCase() !== 'application/ld+json') continue;
    try { blocks.push(JSON.parse(body.trim())); } catch { /* Never guess malformed JSON. */ }
  }
  return blocks;
}
function jobPostings(blocks: unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { for (const v of value) visit(v); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
    if (types.some(t => typeof t === 'string' && t.toLowerCase() === 'jobposting')) result.push(record);
    if (Array.isArray(record['@graph'])) visit(record['@graph']);
  };
  for (const block of blocks) visit(block);
  return result;
}
function matchesUrl(declared: unknown, targetUrl: string): boolean {
  if (declared === undefined) return false;
  if (typeof declared !== 'string') return false;
  const normalize = (u: string) => u.trim().replace(/\/$/, '');
  return normalize(declared) === normalize(targetUrl);
}
function toDateOnly(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return undefined;
  const datePart = text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return undefined;
  const parsed = Date.parse(text.length > 10 ? text : `${datePart}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== datePart) return undefined;
  return datePart;
}
function evaluateResponse(response: CaptureFetchResponse, targetUrl: string, checkedAt: string, maxBytes: number): CaptureResult {
  const status = response.status;
  const base = (outcome: AvailabilityEvidence['outcome'], evidence?: string): AvailabilityEvidence => ({ url: targetUrl, checkedAt, outcome, httpStatus: status, ...(evidence ? { evidence } : {}) });
  if (status === 404 || status === 410) return { availability: base('missing', `http_${status}`) };
  if (status !== 200) return { availability: base('ambiguous', `unexpected_http_status_${status}`) };
  const contentType = (response.headers['content-type'] ?? response.headers['Content-Type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) return { availability: base('error', 'unsupported_content_type') };
  const declaredLength = Number(response.headers['content-length'] ?? response.headers['Content-Length']);
  const actualLength = Buffer.byteLength(response.body, 'utf8');
  if ((Number.isFinite(declaredLength) && declaredLength > maxBytes) || actualLength > maxBytes) return { availability: base('error', 'response_too_large') };
  const postings = jobPostings(extractJsonLd(response.body)).filter(p => matchesUrl(p.url, targetUrl));
  // 200 alone is never "open": an explicit structured JobPosting signal is required.
  if (!postings.length) return { availability: base('ambiguous', 'no_structured_job_posting_found') };
  if (postings.length !== 1) return { availability: base('ambiguous', 'multiple_job_postings') };
  if (postings.some(p => p.validThrough !== undefined && !toDateOnly(p.validThrough))) return { availability: base('ambiguous', 'invalid_valid_through') };
  const validThroughDates = postings.map(p => typeof p.validThrough === 'string' ? p.validThrough : undefined).filter((d): d is string => !!d);
  const expired = validThroughDates.some(d => Number.isFinite(Date.parse(d)) && Date.parse(d) < Date.parse(checkedAt));
  if (postings.some(p => p.datePosted !== undefined && (!toDateOnly(p.datePosted) || Date.parse(String(p.datePosted)) > Date.parse(checkedAt)))) return { availability: base('ambiguous', 'invalid_publication_date') };
  const dated = postings.map(p => ({ raw: p.datePosted, date: toDateOnly(p.datePosted) })).find(d => d.date);
  const availability = base(expired ? 'closed' : 'open', expired ? `validThrough_expired:${validThroughDates[0]}` : dated ? 'jobposting_json_ld_present' : 'jobposting_json_ld_present_no_date');
  if (expired || !dated) return { availability };
  const excerpt = JSON.stringify({ '@type': 'JobPosting', datePosted: dated.raw }).slice(0, 500);
  return { publishedAt: dated.date!, publicationEvidence: { url: targetUrl, excerpt, observedAt: checkedAt }, availability };
}
export async function captureEvidence(opportunity: Opportunity, options: CaptureOptions): Promise<CaptureResult> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  if (![timeoutMs, maxBytes].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw new Error('invalid_limits');
  if (!opportunity.url) throw new Error('opportunity_url_missing');
  const targetUrl = opportunity.url;
  const checkedAt = () => now().toISOString();
  const failed = (outcome: AvailabilityEvidence['outcome'], evidence?: string): CaptureResult => ({ availability: { url: targetUrl, checkedAt: checkedAt(), outcome, ...(evidence ? { evidence } : {}) } });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<CaptureResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(failed('timeout', 'request_timeout')); }, timeoutMs); });
  const run = async (): Promise<CaptureResult> => {
    let currentUrl: URL;
    try { currentUrl = await assertSafeUrl(targetUrl, resolveHost); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      return failed('error', ['ssrf_blocked', 'invalid_url', 'invalid_protocol', 'source_disallowed'].includes(code) ? code : 'dns_resolution_failed');
    }
    for (let hop = 0; ; hop++) {
      if (hop > maxRedirects) return failed('error', 'too_many_redirects');
      let response: CaptureFetchResponse;
      try {
        const { addresses } = await safeUrl(currentUrl.toString(), resolveHost);
        controller.signal.throwIfAborted();
        response = await options.fetch({ url: currentUrl.toString(), signal: controller.signal, addresses });
        controller.signal.throwIfAborted();
      }
      catch { return failed('error', 'fetch_failed'); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers['location'] ?? response.headers['Location'];
        if (!location) return failed('error', 'redirect_missing_location');
        let nextUrl: URL;
        try { nextUrl = new URL(location, currentUrl); }
        catch { return failed('error', 'redirect_invalid_location'); }
        if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') return failed('error', 'redirect_downgrade');
        try { currentUrl = await assertSafeUrl(nextUrl.toString(), resolveHost); }
        catch (error) {
      const code = error instanceof Error ? error.message : '';
      return failed('error', ['ssrf_blocked', 'invalid_url', 'invalid_protocol', 'source_disallowed'].includes(code) ? code : 'dns_resolution_failed');
    }
        continue;
      }
      return evaluateResponse(response, targetUrl, checkedAt(), maxBytes);
    }
  };
  try { return await Promise.race([run(), timedOut]); }
  finally { if (timer) clearTimeout(timer); }
}
/** Real network transport. Only wired in behind the opt-in CLI flag; never called from captureEvidence's own logic. */
export function createNodeCaptureFetch(maxBytes: number = DEFAULT_MAX_BYTES): CaptureFetch {
  const transport = createPinnedTransport(maxBytes, ALLOWED_CONTENT_TYPES);
  return async ({ url, signal, addresses }) => transport({ url, signal, addresses: addresses ?? (await safeUrl(url)).addresses });
}
