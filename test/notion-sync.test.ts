import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { report, ingest } from '../src/pipeline.ts';
import { parseAvailability, parseProfile } from '../src/contracts.ts';
import { validateNotionConfig, planNotionSync as planSync, queryExistingPages, upsertNotionRecords as upsertSync, type HttpTransport, type HttpRequest } from '../src/notion-sync.ts';
const config = { enabled: true, dataSourceId: '12345678-1234-1234-1234-123456789012', externalKeyProperty: 'External key' };
const now = new Date('2026-09-16T12:00:00Z');
const evidence = { url: 'https://example.com/job', publishedAt: '2026-09-16', publicationEvidence: { url: 'https://example.com/job', excerpt: 'Published 2026-09-16', observedAt: now.toISOString() }, availability: { url: 'https://example.com/job', checkedAt: now.toISOString(), outcome: 'open' as const, httpStatus: 200, evidence: 'Active application form for this job' } };
const upsertNotionRecords: typeof upsertSync = (records, config, transport, options) => upsertSync(records, config, transport, { now: () => now, ...options });
const planNotionSync: typeof planSync = (records, config, at = now) => planSync(records, config, at);
const records = report(ingest({ version: 1, records: [] }, [{ ...evidence, source: 'test', externalId: '1', title: 'Developer', company: 'Acme' }, { ...evidence, source: 'test', externalId: '2', title: 'Designer', company: 'Acme' }]), parseProfile({}), new Date('2026-09-16T12:00:00Z')).notion.records;
const list = (results: unknown[] = []) => ({ status: 200, body: { object: 'list', results, has_more: false } });
test('Notion: configuración explícita, desactivada por defecto, nombres sin colisiones', async () => {
  assert.equal(validateNotionConfig({ ...config, enabled: undefined }).enabled, false);
  for (const value of [{}, { ...config, dataSourceId: undefined }, { ...config, databaseId: config.dataSourceId }, { ...config, externalKeyProperty: '' }, { ...config, propertyMap: { Name: 'Company' } }, { ...config, propertyMap: { Fake: 'x' } }, { ...config, externalKeyProperty: 'Name' }]) assert.throws(() => validateNotionConfig(value));
  const result = await upsertNotionRecords(records, { ...config, enabled: false }, async () => { assert.fail('sin red'); });
  assert.equal(result.skipped, 2);
});
test('Notion: crea, omite sin cambios y actualiza idempotentemente usando transporte falso', async () => {
  const calls: HttpRequest[] = [];
  let stored: Record<string, unknown> | undefined;
  const transport: HttpTransport = async req => {
    calls.push(req);
    if (req.url.endsWith('/query')) return list(stored ? [{ object: 'page', id: 'page-1', properties: stored }] : []);
    stored = req.body.properties as Record<string, unknown>;
    return { status: 200, body: { object: 'page', id: 'page-1' } };
  };
  const first = records.slice(0, 1);
  assert.equal((await upsertNotionRecords(first, config, transport)).created, 1);
  stored!.Name = { id: 'title', type: 'title', title: [{ type: 'text', text: { content: first[0]!.properties.Name.title[0]!.text.content, link: null }, plain_text: first[0]!.properties.Name.title[0]!.text.content }] };
  assert.equal((await upsertNotionRecords(first, config, transport)).skipped, 1);
  const changed = [{ ...first[0]!, properties: { ...first[0]!.properties, Company: { rich_text: [{ text: { content: 'New company' } }] } } }];
  assert.equal((await upsertNotionRecords(changed, config, transport)).updated, 1);
  assert.equal((await upsertNotionRecords(changed, config, transport)).skipped, 1);
  assert.equal(calls.filter(c => !c.url.endsWith('/query')).length, 2);
  assert.equal(calls.at(-2)?.method, 'PATCH');
});
test('Notion: plan limita propiedades, mapea nombres y soporta database legacy', () => {
  const row = { ...records[0]!, properties: { ...records[0]!.properties, Arbitrary: { number: 123 } } };
  const plan = planNotionSync([row], { ...config, propertyMap: { Name: 'Título' } });
  const props = plan.records[0]!.create.body.properties as Record<string, unknown>;
  assert.ok(props.Título);
  assert.equal(props.Name, undefined);
  assert.equal(props.Arbitrary, undefined);
  assert.equal(props.Explanation, undefined);
  assert.equal(plan.confirmed, false);
  assert.equal('explanation' in plan.records[0]!.create.body, false);
  const legacy = planNotionSync([row], { databaseId: config.dataSourceId, externalKeyProperty: 'ID' });
  assert.match(legacy.records[0]!.query.url, /databases/);
  assert.equal(legacy.records[0]!.query.headers['Notion-Version'], '2022-06-28');
});
test('Notion: contexto de cálculo es explícito y opt-in para preservar esquemas existentes', () => {
  const row = report(ingest({ version: 1, records: [] }, [{ ...evidence, title: 'Developer', company: 'Acme', source: 'Manual board', compensation: { currency: 'USD', period: 'hour', min: 25 } }]), parseProfile({}), new Date('2026-09-16T12:00:00Z')).notion.records[0]!;
  const projected = row.properties;
  assert.equal(projected.Origin.rich_text.map(v => v.text.content).join(''), 'Manual board');
  assert.deepEqual(projected['Calculation assumptions'].rich_text.map(v => v.text.content), row.explanation.normalized.assumptions);
  assert.deepEqual(JSON.parse(projected.Explanation.rich_text.map(v => v.text.content).join('')), row.explanation);
  const configured = { ...config, includeCalculationContext: true, propertyMap: { Origin: 'Fuente', Explanation: 'Explicación', 'Calculation assumptions': 'Supuestos' } };
  const props = planNotionSync([row], configured).records[0]!.create.body.properties as Record<string, unknown>;
  assert.ok(props.Fuente);
  assert.ok(props.Explicación);
  assert.ok(props.Supuestos);
  assert.throws(() => validateNotionConfig({ ...configured, externalKeyProperty: 'Explicación' }));
});
test('Notion: deduplica claves repetidas dentro del lote', async () => {
  let calls = 0;
  const result = await upsertNotionRecords([records[0]!, records[0]!], config, async req => {
    calls++;
    return req.url.endsWith('/query') ? list() : { status: 200, body: { object: 'page', id: 'page-1' } };
  });
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.records[1]?.reason, 'duplicate_in_batch');
  assert.equal(calls, 2);
});
test('Notion: una página archivada falla sin intentar crear otra', async () => {
  let calls = 0;
  const result = await upsertNotionRecords(records.slice(0, 1), config, async () => {
    calls++;
    return list([{ object: 'page', id: 'archived', archived: true, properties: {} }]);
  });
  assert.equal(result.failed, 1);
  assert.equal(result.records[0]?.reason, 'invalid_response');
  assert.equal(calls, 1);
});
test('Notion: reconcilia en la siguiente ejecución si el transporte falla después de escribir', async () => {
  let stored: Record<string, unknown> | undefined;
  let writes = 0;
  const transport: HttpTransport = async req => {
    if (req.url.endsWith('/query')) return list(stored ? [{ object: 'page', id: 'page-1', properties: stored }] : []);
    writes++;
    stored = req.body.properties as Record<string, unknown>;
    throw new Error('timeout after write');
  };
  const first = await upsertNotionRecords(records.slice(0, 1), config, transport);
  assert.equal(first.records[0]?.reason, 'transport_error');
  const retry = await upsertNotionRecords(records.slice(0, 1), config, transport);
  assert.equal(retry.skipped, 1);
  assert.equal(retry.records[0]?.reason, 'unchanged');
  assert.equal(writes, 1);
});
test('Notion: sincronizaciones concurrentes en el proceso se serializan por destino y clave', async () => {
  let stored: Record<string, unknown> | undefined;
  let writes = 0;
  const transport: HttpTransport = async req => {
    if (req.url.endsWith('/query')) return list(stored ? [{ object: 'page', id: 'page-1', properties: stored }] : []);
    writes++;
    stored = req.body.properties as Record<string, unknown>;
    return { status: 200, body: { object: 'page', id: 'page-1' } };
  };
  const [a, b] = await Promise.all([
    upsertNotionRecords(records.slice(0, 1), config, transport),
    upsertNotionRecords(records.slice(0, 1), config, transport),
  ]);
  assert.deepEqual([a.created + b.created, a.skipped + b.skipped], [1, 1]);
  assert.equal(writes, 1);
});
test('Notion: errores aislados, respuestas sin confirmación y secretos nunca reflejados', async () => {
  const secret = 'fake-secret-never-output';
  for (const response of [{ status: 401, body: { message: secret } }, { status: 429, body: secret }, { status: 500, body: secret }, { status: 200, body: {} }, { status: 204, body: null }]) {
    const result = await upsertNotionRecords(records, config, async req => req.url.endsWith('/query') ? list() : response);
    assert.equal(result.failed, 2);
    assert.equal(result.created + result.updated, 0);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  let count = 0;
  const result = await upsertNotionRecords(records, config, async req => {
    if (++count === 1) throw new Error(secret);
    return req.url.endsWith('/query') ? list() : { status: 200, body: { object: 'page', id: 'ok' } };
  });
  assert.equal(result.failed, 1);
  assert.equal(result.created, 1);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.throws(() => validateNotionConfig({ ...config, token: secret }), e => !String(e).includes(secret));
});
test('Notion: consultas fallidas, duplicadas o incompletas nunca crean páginas', async () => {
  for (const response of [{ status: 403, body: {} }, { status: 200, body: {} }, { status: 200, body: { object: 'list', results: [], has_more: true } }, list([{ object: 'page', id: 'a', properties: {} }, { object: 'page', id: 'b', properties: {} }])]) {
    let calls = 0;
    const result = await upsertNotionRecords(records.slice(0, 1), config, async req => { calls++; assert.match(req.url, /query$/); return response; });
    assert.equal(result.failed, 1);
    assert.equal(calls, 1);
  }
  await assert.rejects(queryExistingPages(records[0]!.externalKey, { ...config, enabled: false }, async () => { assert.fail(); }));
});
test('CLI Notion: dry-run local, flags explícitos y configuración sin reflejar secretos', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-notion-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(config));
    const run = (args: string[]) => spawnSync(process.execPath, ['src/cli.ts', '--input', 'examples/opportunities.json', '--state', join(dir, 'state.json'), ...args], { encoding: 'utf8' });
    const dry = run(['--notion-dry-run', '--notion-config', path]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).notionPlan.confirmed, false);
    assert.equal(JSON.parse(dry.stdout).notionPlan.records.length, 0);
    assert.equal(JSON.parse(dry.stdout).notionPlan.blocked.length, 2);
    assert.equal(run(['--notion-sync', '--notion-config', path]).status, 1);
    assert.equal(run(['--notion-sync']).status, 1);
    assert.equal(run(['--notion-dry-run', '--notion-sync', '--notion-config', path]).status, 1);
    await writeFile(path, '{"token":"fake-secret-never-output",broken');
    const bad = run(['--notion-dry-run', '--notion-config', path]);
    assert.equal(bad.status, 1);
    assert.ok(!(bad.stdout + bad.stderr).includes('fake-secret-never-output'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Notion: límite de 3 días y evidencia ausente; bloqueados hacen cero llamadas incluso a query', async () => {
  for (const [day, allowed] of [[16, true], [15, true], [14, true], [13, true], [12, false]] as const) {
    const row = { ...records[0]!, opportunity: { ...records[0]!.opportunity, publishedAt: `2026-09-${day}` } };
    let calls = 0;
    const result = await upsertNotionRecords([row], config, async req => { calls++; return req.url.endsWith('/query') ? list() : { status: 200, body: { object: 'page', id: 'ok' } }; });
    assert.equal(result.created, allowed ? 1 : 0);
    assert.equal(calls, allowed ? 2 : 0);
    assert.equal(planNotionSync([row], config).blocked.length, allowed ? 0 : 1);
  }
  for (const opportunity of [undefined, { ...records[0]!.opportunity, publishedAt: undefined }, { ...records[0]!.opportunity, publicationEvidence: undefined }, { ...records[0]!.opportunity, availability: undefined }]) {
    const row = { ...records[0]!, opportunity };
    const result = await upsertNotionRecords([row], config, async () => { assert.fail('cero llamadas Notion'); });
    assert.equal(result.skipped, 1);
    assert.equal(result.records[0]?.reason, 'verification_blocked');
    assert.equal(planNotionSync([row], config).records.length, 0);
  }
});

test('Notion: 404/410/desaparición/cierre/200 ambiguo/timeout/vencimiento bloquean antes de Notion', async () => {
  const observations = [
    { ...evidence.availability, httpStatus: 404 }, { ...evidence.availability, httpStatus: 410 },
    { ...evidence.availability, outcome: 'missing' as const }, { ...evidence.availability, outcome: 'closed' as const },
    { ...evidence.availability, outcome: 'ambiguous' as const }, { ...evidence.availability, evidence: undefined },
    { ...evidence.availability, outcome: 'timeout' as const },
    { ...evidence.availability, checkedAt: '2026-09-15T12:00:00Z' },
  ];
  for (const availability of observations) {
    // Check both already captured evidence and newly discovered failures during revalidation.
    for (const recheck of [false, true]) {
      let checks = 0;
      const row = { ...records[0]!, opportunity: { ...records[0]!.opportunity, availability: recheck ? evidence.availability : availability } };
      const result = await upsertNotionRecords([row], config, async () => { assert.fail('cero llamadas Notion'); }, recheck ? { revalidate: async () => { checks++; return availability; } } : {});
      assert.equal(result.skipped, 1);
      assert.equal(result.records[0]?.reason, 'verification_blocked');
      assert.notEqual(result.records[0]?.verification?.status, 'verified');
      assert.equal(checks, recheck ? 1 : 0);
      if (recheck) assert.deepEqual(result.records[0]?.opportunity?.availability, parseAvailability(availability));
    }
  }
});

test('Notion: revalidación con timeout real, excepción o resultado malformado falla cerrada', async () => {
  let aborted = false;
  const timed = await upsertNotionRecords(records.slice(0, 1), config, async () => { assert.fail('cero llamadas'); }, {
    timeoutMs: 5,
    revalidate: async (_o, signal) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); },
  });
  assert.equal(aborted, true);
  assert.ok(timed.records[0]?.verification?.reasons.includes('availability_timeout'));
  for (const revalidate of [async () => { throw new Error('private detail'); }, async () => ({} as typeof evidence.availability)]) {
    const result = await upsertNotionRecords(records.slice(0, 1), config, async () => { assert.fail('cero llamadas'); }, { revalidate });
    assert.ok(result.records[0]?.verification?.reasons.includes('availability_error'));
    assert.ok(!JSON.stringify(result).includes('private detail'));
  }
});

test('Notion: revalida antes de consultar, conserva evidencia y comprueba vigencia antes de escribir', async () => {
  const events: string[] = [];
  const result = await upsertNotionRecords(records.slice(0, 1), config, async req => {
    events.push(req.url.endsWith('/query') ? 'query' : 'create');
    return req.url.endsWith('/query') ? list() : { status: 200, body: { object: 'page', id: 'ok' } };
  }, { revalidate: async () => { events.push('verify'); return evidence.availability; } });
  assert.deepEqual(events, ['verify', 'query', 'create']);
  assert.equal(result.created, 1);
  assert.deepEqual(result.records[0]?.opportunity?.availability, evidence.availability);
  let clock = now;
  let calls = 0;
  const delayed = await upsertNotionRecords(records.slice(0, 1), config, async req => {
    calls++;
    assert.match(req.url, /query$/);
    clock = new Date('2026-09-17T12:00:00Z');
    return list();
  }, { now: () => clock });
  assert.equal(calls, 1);
  assert.equal(delayed.skipped, 1);
  assert.ok(delayed.records[0]?.verification?.reasons.includes('verification_expired'));
});

test('CLI: persiste revalidación cerrada e historial y elimina recomendaciones sin llamadas Notion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-verify-cli-'));
  try {
    const { readFile, access } = await import('node:fs/promises');
    const current = new Date();
    const url = evidence.url;
    const fresh = { title: 'Developer', company: 'Acme', ...evidence, publishedAt: current.toISOString().slice(0, 10),
      publicationEvidence: { ...evidence.publicationEvidence, observedAt: current.toISOString() },
      availability: { ...evidence.availability, checkedAt: current.toISOString() } };
    const input = join(dir, 'input.json');
    const state = join(dir, 'state.json');
    const cfg = join(dir, 'config.json');
    const module = join(dir, 'transport.mjs');
    const marker = join(dir, 'called');
    await writeFile(input, JSON.stringify(fresh));
    await writeFile(cfg, JSON.stringify(config));
    await writeFile(module, `import { writeFile } from 'node:fs/promises';
export async function transport() { await writeFile(${JSON.stringify(marker)}, 'called'); throw new Error('Must not call'); }
export async function revalidate() { return { url: ${JSON.stringify(url)}, checkedAt: new Date().toISOString(), outcome: 'closed', httpStatus: 200, evidence: 'Applications closed' }; }`);
    const run = spawnSync(process.execPath, ['src/cli.ts', '--input', input, '--state', state, '--notion-sync', '--notion-config', cfg, '--notion-transport', module], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.notionSync.skipped, 1);
    assert.equal(result.notionSync.created + result.notionSync.updated, 0);
    assert.equal(result.records[0].evaluation.verification.status, 'unavailable');
    assert.equal(result.recommendations.length, 0);
    const stored = JSON.parse(await readFile(state, 'utf8'));
    assert.equal(stored.records[0].opportunity.availability.outcome, 'closed');
    assert.deepEqual(stored.records[0].history[0].availability, fresh.availability);
    await assert.rejects(access(marker));
    // A historical --now cannot reactivate an old verification during real sync.
    await writeFile(input, JSON.stringify({ ...fresh, publishedAt: '2000-01-01', publicationEvidence: { ...fresh.publicationEvidence, observedAt: '2000-01-01T12:00:00Z' }, availability: { ...fresh.availability, checkedAt: '2000-01-01T12:00:00Z' } }));
    const old = spawnSync(process.execPath, ['src/cli.ts', '--input', input, '--state', state, '--now', '2000-01-01T12:00:00Z', '--notion-sync', '--notion-config', cfg, '--notion-transport', module], { encoding: 'utf8' });
    assert.equal(old.status, 0, old.stderr);
    assert.equal(JSON.parse(old.stdout).notionSync.records[0].verification.status, 'stale');
    await assert.rejects(access(marker));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
