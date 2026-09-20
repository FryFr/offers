import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutomation, target, automationMain } from '../src/automation.ts';
import { withMailLock } from '../src/mail-runner.ts';
import { createNotionTransport } from '../src/notion-transport.ts';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'offers-cycle-'));
  await mkdir(join(root, 'data')); await mkdir(join(root, 'examples'));
  await writeFile(join(root, 'examples/profile.json'), '{}');
  await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ ...target, schemaVerified: false, config: null }));
  return root;
}
const fixture = await readFile(new URL('./fixtures/linkedin/real-reduced.eml', import.meta.url), 'utf8');
const command = (_: string, args: string[]) => args[0] === '--version' ? 'himalaya 2.1.0' : args[0] === 'message' ? fixture : JSON.stringify({ envelopes: [{ id: 'job' }] });

test('cycle is idempotent, persists blocked evidence, and refuses overlap', async () => {
  const root = await setup();
  try {
    const options = { root, account: 'test', command, now: new Date('2026-09-19T12:00:00Z') };
    assert.equal((await runAutomation(options)).schemaVerified, false);
    const initial = await readFile(join(root, 'data/offers.json'), 'utf8');
    await runAutomation(options);
    assert.equal(await readFile(join(root, 'data/offers.json'), 'utf8'), initial);
    const plan = JSON.parse(await readFile(join(root, 'data/automation-plan.json'), 'utf8'));
    assert.equal(plan.notionPlan.records.length, 0);
    assert.equal(plan.notionPlan.blocked.length, 3);
    assert.ok(plan.records.every((r: any) => !r.opportunity.publishedAt));
    await withMailLock(join(root, 'data/automation'), async () => {
      await assert.rejects(runAutomation(options), /existe .lock/);
    });
    // A configured schema still cannot bypass the publication/availability gate.
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ ...target, schemaVerified: true, config: { enabled: false, dataSourceId: target.dataSourceId, externalKeyProperty: 'External key', propertyMap: {} } }));
    const checked = await runAutomation(options);
    assert.equal(checked.eligible, 0); assert.equal(checked.blocked, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed plan leaves pending mail; retry persists plan before cursor acknowledgement', async () => {
  const root = await setup();
  try {
    const path = join(root, 'data/automation-plan.json');
    await mkdir(path);
    await assert.rejects(runAutomation({ root, account: 'test', command }));
    const pending = JSON.parse(await readFile(join(root, 'data/mail-cursor.json'), 'utf8'));
    assert.deepEqual(pending.processed, []); assert.ok(pending.pending);
    const state = await readFile(join(root, 'data/offers.json'), 'utf8');
    await rm(path, { recursive: true });
    await runAutomation({ root, account: 'test', command: () => { throw new Error('must replay without mail access'); } });
    assert.equal(await readFile(join(root, 'data/offers.json'), 'utf8'), state);
    const committed = JSON.parse(await readFile(join(root, 'data/mail-cursor.json'), 'utf8'));
    assert.deepEqual(committed.processed, ['job']); assert.equal(committed.pending, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI rejects sync and missing account', async () => {
  assert.equal(await automationMain([]), 2);
  assert.equal(await automationMain(['--account', 'test', '--notion-sync', 'true']), 2);
});

test('transport injects environment credential, constrains destination and suppresses errors', async () => {
  const request = { method: 'POST' as const, url: 'https://api.notion.com/v1/pages', headers: { 'Notion-Version': '2025-09-03' }, body: {} };
  let calls = 0;
  const fake = (async (_url, init) => {
    calls++;
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-secret');
    assert.equal(init!.redirect, 'error'); assert.ok(init!.signal);
    return new Response('{"object":"page"}', { status: 200 });
  }) as typeof fetch;
  const transport = createNotionTransport(fake, { NOTION_API_KEY: 'test-secret' });
  assert.deepEqual(await transport(request), { status: 200, body: { object: 'page' } });
  await assert.rejects(transport({ ...request, url: 'https://evil.example/v1/pages' }), /request_rejected/);
  await assert.rejects(createNotionTransport(fake, {})(request), /credentials/);
  assert.equal(calls, 1);
  await assert.rejects(createNotionTransport(async () => { throw new Error('test-secret'); }, { NOTION_API_KEY: 'test-secret' })(request), /^Error: notion_transport_error$/);
  const failed = await createNotionTransport(async () => new Response('test-secret', { status: 429 }), { NOTION_API_KEY: 'test-secret' })(request);
  assert.deepEqual(failed, { status: 429, body: null });
});
