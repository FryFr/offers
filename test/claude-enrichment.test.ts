import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeEnricher, validateEnrichment } from '../src/claude-enrichment.ts';
import type { CapturedJob } from '../src/source-adapters.ts';
const job: CapturedJob = { opportunity: { title: 'Engineer', company: 'Acme', skills: [], description: 'Build TypeScript services.', availability: { url: 'https://example.com/job', checkedAt: '2026-09-19T00:00:00Z', outcome: 'ambiguous' } }, provenance: [{ sourceId: 'fixture', adapter: 'rss', externalId: '42', endpoint: 'https://example.com/rss', originalUrl: 'https://example.com/job', observedAt: '2026-09-19T00:00:00Z', payloadHash: 'a'.repeat(64) }], warnings: [] };
const valid = { summary: 'Build services', skills: [{ name: 'TypeScript', quote: 'Build TypeScript services.' }] };
test('schema rejects fabricated quotes, added evidence, types, duplicates and excessive output', () => {
  for (const value of [{ ...valid, availability: 'open' }, { ...valid, skills: [{ name: 'Python', quote: 'Python' }] }, { ...valid, skills: [{ name: 'Python', quote: 'Build TypeScript services.' }] }, { ...valid, skills: [...valid.skills, ...valid.skills] }, { ...valid, summary: 'x'.repeat(1001) }, { summary: 'x', skills: 'TypeScript' }]) assert.throws(() => validateEnrichment(value, job.opportunity.description!));
});
test('Claude opt-in authenticates with external secret, forces schema tool and bounds request; mock response only', async () => {
  const enrich = createClaudeEnricher({ model: 'fixture-model', env: { ANTHROPIC_API_KEY: 'test-only' }, fetcher: async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'test-only');
    const body = JSON.parse(String(init?.body)); assert.equal(body.tool_choice.name, 'job_enrichment'); assert.equal(body.tools[0].input_schema.additionalProperties, false);
    return new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'job_enrichment', input: valid }] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await enrich(job), valid);
});
test('Claude cannot run before deterministic capture; credentials and failures do not leak', async () => {
  let called = false;
  const fetcher: typeof fetch = async () => { called = true; throw new Error('SECRET_VALUE'); };
  await assert.rejects(createClaudeEnricher({ model: 'fixture', env: { ANTHROPIC_API_KEY: 'test-only' }, fetcher })({ ...job, provenance: [] }), /deterministic_capture_required/);
  assert.equal(called, false);
  await assert.rejects(createClaudeEnricher({ model: 'fixture', env: {}, fetcher })(job), /enrichment_credentials_missing/);
  assert.equal(called, false);
  await assert.rejects(createClaudeEnricher({ model: 'fixture', env: { ANTHROPIC_API_KEY: 'test-only' }, fetcher })(job), /^Error: enrichment_failed$/);
});
test('Claude truncated, multiple-tool and oversized responses fail closed', async () => {
  const responses = [JSON.stringify({ stop_reason: 'max_tokens', content: [] }), JSON.stringify({ stop_reason: 'tool_use', content: [1, 2].map(() => ({ type: 'tool_use', name: 'job_enrichment', input: valid })) }), 'x'.repeat(100001)];
  for (const body of responses) await assert.rejects(createClaudeEnricher({ model: 'fixture', env: { ANTHROPIC_API_KEY: 'test-only' }, fetcher: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) })(job), /enrichment_failed/);
});
