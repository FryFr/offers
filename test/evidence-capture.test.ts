import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEvidence, type CaptureFetch, type ResolveHost } from '../src/evidence-capture.ts';
import type { Opportunity } from '../src/contracts.ts';

const PUBLIC_IP = '93.184.216.34';
const url = 'https://jobs.example.com/openings/backend-engineer';
const opportunity: Opportunity = { title: 'Backend engineer', company: 'Acme', skills: [], url };
const publicResolver: ResolveHost = async () => [PUBLIC_IP];
function htmlWithJsonLd(jsonLd: unknown, extra = ''): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body>${extra}</body></html>`;
}
function response(status: number, body = '', headers: Record<string, string> = {}) {
  return { status, headers: { 'content-type': 'text/html', ...headers }, body };
}

test('happy path: JSON-LD JobPosting with matching url and future validThrough yields verified evidence', async () => {
  const body = htmlWithJsonLd({ '@type': 'JobPosting', url, datePosted: '2026-09-15T08:00:00Z', validThrough: '2099-01-01' });
  const fetch: CaptureFetch = async () => response(200, body);
  const now = () => new Date('2026-09-18T12:00:00Z');
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver, now });
  assert.equal(result.publishedAt, '2026-09-15');
  assert.equal(result.publicationEvidence?.url, url);
  assert.equal(result.publicationEvidence?.observedAt, now().toISOString());
  assert.ok(result.publicationEvidence?.excerpt.includes('2026-09-15T08:00:00Z'));
  assert.deepEqual(result.availability, { url, checkedAt: now().toISOString(), outcome: 'open', httpStatus: 200, evidence: 'jobposting_json_ld_present' });
});

test('closed: JobPosting with an expired validThrough is reported closed, never open', async () => {
  const body = htmlWithJsonLd({ '@type': 'JobPosting', url, datePosted: '2026-09-01', validThrough: '2026-09-10' });
  const fetch: CaptureFetch = async () => response(200, body);
  const now = () => new Date('2026-09-18T12:00:00Z');
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver, now });
  assert.equal(result.availability.outcome, 'closed');
  assert.equal(result.publishedAt, undefined);
  assert.equal(result.publicationEvidence, undefined);
});

test('ambiguous: HTTP 200 alone, with no structured JobPosting, is never treated as open', async () => {
  const fetch: CaptureFetch = async () => response(200, '<html><body>Some page with no structured data</body></html>');
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver });
  assert.equal(result.availability.outcome, 'ambiguous');
  assert.equal(result.publishedAt, undefined);
});

test('ambiguous: JSON-LD JobPosting whose own url disagrees with the opportunity url is ignored (fail closed)', async () => {
  const body = htmlWithJsonLd({ '@type': 'JobPosting', url: 'https://jobs.example.com/openings/other-role', datePosted: '2026-09-15' });
  const fetch: CaptureFetch = async () => response(200, body);
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver });
  assert.equal(result.availability.outcome, 'ambiguous');
  assert.equal(result.publishedAt, undefined);
});

test('missing date: JobPosting present without a usable datePosted never invents publishedAt', async () => {
  const body = htmlWithJsonLd({ '@type': 'JobPosting', url, validThrough: '2099-01-01' });
  const fetch: CaptureFetch = async () => response(200, body);
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver });
  assert.equal(result.publishedAt, undefined);
  assert.equal(result.publicationEvidence, undefined);
  assert.equal(result.availability.outcome, 'open');
  assert.equal(result.availability.evidence, 'jobposting_json_ld_present_no_date');
});

test('missing: HTTP 404/410 is reported missing, not ambiguous', async () => {
  const fetch: CaptureFetch = async () => response(404);
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver });
  assert.equal(result.availability.outcome, 'missing');
  assert.equal(result.availability.httpStatus, 404);
});

test('SSRF: a hostname resolving to a private IP is blocked before any fetch call', async () => {
  let called = false;
  const fetch: CaptureFetch = async () => { called = true; return response(200); };
  const resolveHost: ResolveHost = async () => ['10.0.0.5'];
  const result = await captureEvidence(opportunity, { fetch, resolveHost });
  assert.equal(called, false);
  assert.equal(result.availability.outcome, 'error');
  assert.equal(result.availability.evidence, 'ssrf_blocked');
});

test('SSRF: loopback, link-local and reserved literals are all blocked', async () => {
  const fetch: CaptureFetch = async () => response(200);
  for (const [host, address] of [['loopback', '127.0.0.1'], ['linklocal', '169.254.1.1'], ['reserved', '240.0.0.1'], ['ipv6-loopback', '::1'], ['ipv6-uniquelocal', 'fd00::1']] as const) {
    const target: Opportunity = { ...opportunity, url: `https://${host}.example.com/job` };
    const result = await captureEvidence(target, { fetch, resolveHost: async () => [address] });
    assert.equal(result.availability.outcome, 'error', `${host} should be blocked`);
    assert.equal(result.availability.evidence, 'ssrf_blocked');
  }
});

test('SSRF: a redirect hop landing on a private IP is blocked even if the first hop was public', async () => {
  let calls = 0;
  const fetch: CaptureFetch = async () => { calls++; return response(302, '', { location: 'https://internal.example.com/job' }); };
  const resolveHost: ResolveHost = async hostname => hostname === 'internal.example.com' ? ['192.168.1.1'] : [PUBLIC_IP];
  const result = await captureEvidence(opportunity, { fetch, resolveHost });
  assert.equal(calls, 1);
  assert.equal(result.availability.outcome, 'error');
  assert.equal(result.availability.evidence, 'ssrf_blocked');
});

test('redirect: a safe redirect hop is followed and evidence is still attributed to the opportunity url', async () => {
  let calls = 0;
  const body = htmlWithJsonLd({ '@type': 'JobPosting', url, datePosted: '2026-09-16' });
  const fetch: CaptureFetch = async request => {
    calls++;
    if (calls === 1) { assert.equal(request.url, url); return response(302, '', { location: 'https://jobs.example.com/openings/backend-engineer-2' }); }
    return response(200, body);
  };
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver });
  assert.equal(calls, 2);
  assert.equal(result.publishedAt, '2026-09-16');
  assert.equal(result.publicationEvidence?.url, url);
  assert.equal(result.availability.url, url);
  assert.equal(result.availability.outcome, 'open');
});

test('redirect: exceeding the redirect budget fails closed', async () => {
  const fetch: CaptureFetch = async () => response(302, '', { location: 'https://jobs.example.com/openings/backend-engineer' });
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver, maxRedirects: 2 });
  assert.equal(result.availability.outcome, 'error');
  assert.equal(result.availability.evidence, 'too_many_redirects');
});

test('timeout: a fetch that never settles fails closed with outcome timeout', async () => {
  const fetch: CaptureFetch = ({ signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver, timeoutMs: 30 });
  assert.equal(result.availability.outcome, 'timeout');
});

test('size cap: a Content-Length above the limit is rejected without trusting the body', async () => {
  const body = htmlWithJsonLd({ '@type': 'JobPosting', url, datePosted: '2026-09-15' });
  const fetch: CaptureFetch = async () => response(200, body, { 'content-length': String(10_000_000) });
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver, maxBytes: 1000 });
  assert.equal(result.availability.outcome, 'error');
  assert.equal(result.availability.evidence, 'response_too_large');
  assert.equal(result.publishedAt, undefined);
});

test('size cap: an oversized body is rejected even without a Content-Length header', async () => {
  const body = htmlWithJsonLd({ '@type': 'JobPosting', url, datePosted: '2026-09-15' }, 'x'.repeat(5000));
  const fetch: CaptureFetch = async () => response(200, body);
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver, maxBytes: 1000 });
  assert.equal(result.availability.outcome, 'error');
  assert.equal(result.availability.evidence, 'response_too_large');
});

test('malformed content: an unexpected content-type is rejected without parsing the body', async () => {
  const fetch: CaptureFetch = async () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: 'binary-garbage' });
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver });
  assert.equal(result.availability.outcome, 'error');
  assert.equal(result.availability.evidence, 'unsupported_content_type');
});

test('malformed content: an unparsable JSON-LD block is ignored, not thrown, and never invents a date', async () => {
  const body = '<html><head><script type="application/ld+json">{not valid json</script></head><body>plain text</body></html>';
  const fetch: CaptureFetch = async () => response(200, body);
  const result = await captureEvidence(opportunity, { fetch, resolveHost: publicResolver });
  assert.equal(result.availability.outcome, 'ambiguous');
  assert.equal(result.publishedAt, undefined);
});

test('protocol validation: non-HTTP(S) protocols are rejected before any fetch call', async () => {
  let called = false;
  const fetch: CaptureFetch = async () => { called = true; return response(200); };
  const target: Opportunity = { ...opportunity, url: 'ftp://jobs.example.com/openings/backend-engineer' };
  const result = await captureEvidence(target, { fetch, resolveHost: publicResolver });
  assert.equal(called, false);
  assert.equal(result.availability.outcome, 'error');
  assert.equal(result.availability.evidence, 'invalid_protocol');
});

test('throws when the opportunity has no url to capture evidence for', async () => {
  const fetch: CaptureFetch = async () => response(200);
  await assert.rejects(() => captureEvidence({ ...opportunity, url: undefined }, { fetch, resolveHost: publicResolver }), /opportunity_url_missing/);
});
