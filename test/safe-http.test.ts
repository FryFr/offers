import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { safeRead, assertSafeUrl, createPinnedTransport, isPublicAddress } from '../src/safe-http.ts';
import { captureEvidence } from '../src/evidence-capture.ts';
const publicResolver = async () => ['93.184.216.34'];
const target = 'https://jobs.example.com/job-42';
const job = { title: 'Engineer', company: 'Acme', skills: [], url: target };
const html = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const ok = (body = '{}') => ({ status: 200, headers: { 'content-type': 'application/json' }, body });

test('public address filter blocks private, reserved, mapped and transition forms', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.1.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '192.88.99.1', '::', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2001::1', '2002:7f00:1::', '2001:db8::1', 'fe80::1', 'fd00::1', 'ff02::1', 'not-an-ip']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
});
test('SSRF rejects decimal/hex IPs, IPv6 literals, mixed DNS and credential URLs before transport', async () => {
  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:7f00:1]/', 'http://[::1]/', 'http://user:pass@example.com/', 'http://example.com:22/']) {
    await assert.rejects(safeRead(url, { resolveHost: publicResolver, transport: async () => assert.fail('blocked before transport') }));
  }
  await assert.rejects(assertSafeUrl(target, async () => ['93.184.216.34', '10.1.1.1']), /ssrf_blocked/);
});
test('validated DNS addresses are passed to transport without unpinned fetch; direct transport rejects unsafe pins', async () => {
  let resolutions = 0;
  const result = await safeRead(target, { resolveHost: async () => { resolutions++; return ['93.184.216.34']; }, transport: async request => {
    assert.deepEqual(request.addresses, ['93.184.216.34']); assert.equal(request.url, target); return ok();
  } });
  assert.equal(result.status, 200); assert.equal(resolutions, 1);
  await assert.rejects(createPinnedTransport()({ url: target, signal: new AbortController().signal, addresses: ['127.0.0.1'] }), /ssrf_blocked/);
});
test('every redirect hop validates DNS, including mixed public/private answers', async () => {
  let calls = 0;
  await assert.rejects(safeRead(target, { resolveHost: async host => host === 'private.example.com' ? ['8.8.8.8', '192.168.1.1'] : ['93.184.216.34'],
    transport: async () => { calls++; return { status: 302, headers: { location: 'https://private.example.com/' }, body: '' }; } }), /ssrf_blocked/);
  assert.equal(calls, 1);
});
test('redirect policies block downgrade, credential forwarding, disallowed sites, loops and missing location', async () => {
  for (const [location, error] of [['http://example.com/', /redirect_downgrade/], ['https://linkedin.com/jobs', /source_disallowed/], ['https://glassdoor.com/jobs', /source_disallowed/], ['https://indeed.com/jobs', /source_disallowed/]] as const) {
    await assert.rejects(safeRead(target, { resolveHost: publicResolver, transport: async () => ({ status: 302, headers: { location }, body: '' }) }), error);
  }
  let calls = 0;
  await assert.rejects(safeRead(target, { resolveHost: publicResolver, headers: { Authorization: 'Bearer test-only' }, transport: async () => {
    calls++; return { status: 302, headers: { location: 'https://another.example.com/' }, body: '' };
  } }), /credential_redirect_blocked/); assert.equal(calls, 1);
  await assert.rejects(safeRead(target, { resolveHost: publicResolver, maxRedirects: 1, transport: async () => ({ status: 302, headers: { location: '/again' }, body: '' }) }), /too_many_redirects/);
  await assert.rejects(safeRead(target, { resolveHost: publicResolver, transport: async () => ({ status: 302, headers: {}, body: '' }) }), /redirect_missing_location/);
});
test('safe relative redirects, content type and byte-size checks', async () => {
  let calls = 0;
  const result = await safeRead(target, { resolveHost: publicResolver, transport: async req => {
    calls++; if (calls === 1) return { status: 307, headers: { location: '/final' }, body: '' }; assert.match(req.url, /\/final$/); return ok();
  } }); assert.equal(result.finalUrl, 'https://jobs.example.com/final');
  await assert.rejects(safeRead(target, { resolveHost: publicResolver, contentTypes: ['application/json'], transport: async () => ({ ...ok(), headers: { 'content-type': 'text/html' } }) }), /unsupported_content_type/);
  await assert.rejects(safeRead(target, { resolveHost: publicResolver, maxBytes: 5, transport: async () => ok('ééé') }), /response_too_large/);
  await assert.rejects(safeRead(target, { resolveHost: publicResolver, maxBytes: 5, transport: async () => ({ ...ok(), headers: { 'content-type': 'application/json', 'content-length': '100' } }) }), /response_too_large/);
});
test('timeouts cover DNS and transports that ignore abort; late DNS cannot initiate a request', async () => {
  let resolveDns: (addresses: string[]) => void = () => {};
  const pending = safeRead(target, { timeoutMs: 10, resolveHost: () => new Promise(resolve => { resolveDns = resolve; }), transport: async () => assert.fail('late fetch') });
  await assert.rejects(pending, /request_timeout/); resolveDns(['93.184.216.34']);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(safeRead(target, { timeoutMs: 10, resolveHost: publicResolver, transport: async () => new Promise(() => {}) }), /request_timeout/);
});
test('invalid limits fail immediately', async () => {
  for (const opts of [{ maxBytes: 0 }, { maxBytes: NaN }, { timeoutMs: -1 }, { maxRedirects: 1.5 }, { maxRedirects: 11 }]) await assert.rejects(safeRead(target, opts), /invalid_limits/);
});
test('HTML ambiguity, unbound JobPosting, invalid deadlines and future dates remain blocked', async () => {
  const ambiguous = await readFile(new URL('./fixtures/sources/ambiguous.html', import.meta.url), 'utf8');
  for (const body of [ambiguous, html({ '@type': 'JobPosting', datePosted: '2026-09-18' }), html({ '@type': 'JobPosting', url: target, datePosted: '2026-09-18', validThrough: 'tomorrow' }), html({ '@type': 'JobPosting', url: target, datePosted: '2099-01-01' })]) {
    const result = await captureEvidence(job, { now: () => new Date('2026-09-19T12:00:00Z'), resolveHost: publicResolver, fetch: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body }) });
    assert.equal(result.availability.outcome, 'ambiguous'); assert.equal(result.publishedAt, undefined);
  }
});

test('HTML examples inside comments, quoted attributes, raw text and templates cannot establish evidence', async () => {
  const posting = html({ '@type': 'JobPosting', url: target, datePosted: '2026-09-18' });
  for (const body of [`<!-- ${posting} -->`, `<textarea>${posting}</textarea>`, `<template><template></template>${posting}</template>`, `<style>${posting}</style>`, `<div data-example='${posting}'></div>`, posting.replace('type=', 'data-type='), posting.replace('type="application/ld+json"', `data-example=' type="application/ld+json"'`)]) {
    const result = await captureEvidence(job, { now: () => new Date('2026-09-19T12:00:00Z'), resolveHost: publicResolver, fetch: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body }) });
    assert.equal(result.availability.outcome, 'ambiguous', body); assert.equal(result.publishedAt, undefined);
  }
});
