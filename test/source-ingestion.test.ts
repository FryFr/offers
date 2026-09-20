import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRegistry, sourceHeaders, MAX_SOURCES, type Source } from '../src/source-registry.ts';
import { adaptSource, canonicalUrl } from '../src/source-adapters.ts';
import { parseRss } from '../src/rss.ts';
import { collectSource, deduplicate, runSourceCycle } from '../src/multi-source.ts';
import { parseProfile } from '../src/contracts.ts';
import { identity, ingest, report } from '../src/pipeline.ts';
import { runSources, runNotionSync, sourceHealth, parseSourceState, sourcesMain } from '../src/source-cli.ts';
import { upsertNotionRecords, type HttpTransport } from '../src/notion-sync.ts';
const now = new Date('2026-09-19T12:00:00Z'), profile = parseProfile({});
const config = { enabled: false, dataSourceId: '12345678-1234-1234-1234-123456789012', externalKeyProperty: 'External key' };
const fixture = (name: string) => readFile(new URL(`./fixtures/sources/${name}`, import.meta.url), 'utf8');
const source = (adapter: Source['adapter'], extra = {}): Source => parseRegistry({ version: 1, sources: [{ id: adapter, adapter, enabled: true,
  ...(['greenhouse', 'lever', 'ashby'].includes(adapter) ? { board: 'acme', company: 'Acme' } : {}),
  ...(adapter === 'rss' ? { endpoint: 'https://weworkremotely.com/remote-jobs.rss' } : {}), ...extra }] })[0]!;
const resolver = async () => ['93.184.216.34'];
const response = (body: string) => ({ status: 200, headers: { 'content-type': 'application/json' }, body });

test('registry rejects embedded secrets, duplicate IDs, unknown options, unsafe endpoints and too-fast cadence', () => {
  for (const extra of [{ secret: 'bad' }, { endpoint: 'https://evil.test' }, { enabled: 'yes' }, { minIntervalMinutes: 1 }, { secretEnv: 'NOTION_API_KEY' }]) assert.throws(() => source('remotive', extra));
  for (const endpoint of ['file:///etc/passwd', 'https://user:pass@example.com/rss', 'https://example.com/rss?token=secret', 'https://linkedin.com/jobs']) assert.throws(() => source('rss', { endpoint }));
  assert.throws(() => parseRegistry({ version: 1, sources: [{ id: 'x', adapter: 'remotive', enabled: false }, { id: 'x', adapter: 'remotive', enabled: false }] }));
  assert.throws(() => source('greenhouse', { board: '../other' }));
  assert.throws(() => sourceHeaders(source('rss', { secretEnv: 'OFFERS_SOURCE_FEED_TOKEN' }), {}));
  assert.deepEqual(sourceHeaders(source('rss', { secretEnv: 'OFFERS_SOURCE_FEED_TOKEN' }), { OFFERS_SOURCE_FEED_TOKEN: 'test-only' }), { Authorization: 'Bearer test-only' });
});

test(`el registro admite hasta ${MAX_SOURCES} fuentes y rechaza una más`, () => {
  const bulk = (count: number) => ({ version: 1, sources: Array.from({ length: count },
    (_, i) => ({ id: `board-${i}`, adapter: 'greenhouse', board: `acme${i}`, company: 'Acme', enabled: false })) });
  assert.equal(parseRegistry(bulk(MAX_SOURCES)).length, MAX_SOURCES);
  assert.throws(() => parseRegistry(bulk(MAX_SOURCES + 1)), /registry_invalid/);
});
for (const adapter of ['remotive', 'greenhouse', 'lever', 'ashby', 'rss'] as const) test(`${adapter}: fixture normalization and provenance preserve explicit evidence only`, async () => {
  const result = adaptSource(source(adapter), await fixture(adapter === 'rss' ? 'jobs.rss' : `${adapter}.json`), now);
  assert.equal(result.rejected, 0); assert.equal(result.jobs.length, 1);
  const job = result.jobs[0]!;
  assert.equal(job.opportunity.title, 'Backend engineer'); assert.equal(job.opportunity.company, 'Acme');
  assert.equal(job.provenance[0]!.observedAt, now.toISOString()); assert.match(job.provenance[0]!.payloadHash, /^[a-f0-9]{64}$/);
  // Lever ya sí aporta fecha: su createdAt es epoch en milisegundos y no se reescribe.
  // Greenhouse sigue sin ella porque la fixture no trae `first_published`, igual que boards reales.
  assert.equal(job.opportunity.publishedAt, adapter === 'greenhouse' ? undefined : '2026-09-18');
  assert.equal(job.opportunity.availability?.outcome, ['rss', 'remotive'].includes(adapter) ? 'ambiguous' : 'open');
  assert.equal(job.opportunity.externalId, undefined);
  // Ningún proveedor de esta tanda publica salario estructurado en la fixture.
  assert.equal(job.opportunity.payDisclosure, 'not_published');
  assert.equal(job.opportunity.compensation, undefined);
});
test('lever y ashby mapean modalidad, tipo de contrato y restricciones de ubicación', async () => {
  const lever = adaptSource(source('lever'), await fixture('lever.json'), now).jobs[0]!.opportunity;
  assert.equal(lever.remoteness, 'fully_remote');
  assert.equal(lever.remote, true, 'el booleano se deriva de remoteness, no se declara aparte');
  assert.equal(lever.employmentType, 'full_time');
  assert.deepEqual(lever.locationRestrictions, undefined);
  const ashby = adaptSource(source('ashby'), await fixture('ashby.json'), now).jobs[0]!.opportunity;
  assert.equal(ashby.employmentType, 'full_time');
  // Un epoch fuera de rango de calendario no se convierte en fecha: podría ser un identificador.
  const raw = JSON.parse(await fixture('lever.json'));
  for (const createdAt of [1, 946684799000, Date.now() + 86_400_000, -5, 'ayer']) {
    const job = adaptSource(source('lever'), JSON.stringify([{ ...raw[0], createdAt }]), now).jobs[0]!;
    assert.equal(job.opportunity.publishedAt, undefined, String(createdAt));
    assert.ok(job.warnings.includes('publication_missing_or_invalid'));
  }
});
test('greenhouse: el contenido doblemente escapado se reduce a texto sin markup ni entidades', async () => {
  const body = JSON.parse(await fixture('greenhouse.json'));
  // Forma real medida en boards/vercel: HTML escapado DOS veces (`&amp;nbsp;`, `&amp;lt;p&amp;gt;`).
  const content = '&lt;p&gt;Build &amp;amp; ship&amp;nbsp;services&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;ul&gt;&lt;li&gt;TypeScript&lt;/li&gt;&lt;/ul&gt;';
  const job = adaptSource(source('greenhouse'), JSON.stringify({ ...body, jobs: [{ ...body.jobs[0], content }] }), now).jobs[0]!;
  const description = job.opportunity.description!;
  assert.equal(description, 'Build & ship services TypeScript');
  assert.ok(!/<[a-z/]/i.test(description), 'sin etiquetas');
  assert.ok(!/&[a-z#0-9]{2,8};/i.test(description), 'sin entidades sin decodificar');
  assert.ok(!description.includes('alert'), 'el contenido de script no sobrevive');
  // Una descripción enorme se acota para que el store no crezca sin techo.
  const huge = adaptSource(source('greenhouse'), JSON.stringify({ ...body, jobs: [{ ...body.jobs[0], content: 'a'.repeat(50_000) }] }), now).jobs[0]!;
  assert.equal(huge.opportunity.description?.length, 20_000);
});
test('ashby: el salario estructurado se lee, y una cifra inverosímil queda unparsed sin inventarse', async () => {
  const body = JSON.parse(await fixture('ashby.json'));
  const withPay = (component: unknown, summary = '$211.4K - $290.6K') => JSON.stringify({ ...body,
    jobs: [{ ...body.jobs[0], compensation: { scrapeableCompensationSalarySummary: summary, summaryComponents: component ? [component] : [] } }] });
  const salary = { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 211400, maxValue: 290600 };
  const ok = adaptSource(source('ashby'), withPay(salary), now).jobs[0]!.opportunity;
  assert.deepEqual(ok.compensation, { currency: 'USD', period: 'year', min: 211400, max: 290600 });
  assert.equal(ok.payDisclosure, 'published');
  assert.equal(ok.payEvidence?.raw, '$211.4K - $290.6K');
  // Medido en el board real de Vanta: 90 USD AL AÑO. Publicado por la fuente, pero no creíble.
  const absurd = adaptSource(source('ashby'), withPay({ ...salary, minValue: 90, maxValue: 90 }, '$90'), now).jobs[0]!.opportunity;
  assert.equal(absurd.payDisclosure, 'unparsed');
  assert.equal(absurd.compensation, undefined, 'una cifra inverosímil no se convierte en dato');
  assert.equal(absurd.payEvidence?.raw, '$90', 'pero sí se conserva lo que la fuente dijo');
  // Equity sin salario no es salario; un resumen sin componentes queda unparsed.
  const equity = adaptSource(source('ashby'), withPay({ compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null }), now).jobs[0]!.opportunity;
  assert.equal(equity.payDisclosure, 'unparsed');
  assert.equal(equity.compensation, undefined);
  const nothing = adaptSource(source('ashby'), withPay(null, ''), now).jobs[0]!.opportunity;
  assert.equal(nothing.payDisclosure, 'not_published');
});
test('malformed rows are isolated; malformed envelopes fail; unpublished Ashby and Greenhouse prospects are excluded', async () => {
  const body = JSON.parse(await fixture('ashby.json'));
  body.jobs.push(null, { ...body.jobs[0], isListed: false }, { ...body.jobs[0], title: '' });
  assert.equal(adaptSource(source('ashby'), JSON.stringify(body), now).rejected, 3);
  assert.throws(() => adaptSource(source('ashby'), '{', now));
  assert.throws(() => adaptSource(source('ashby'), '{"jobs":{}}', now));
  const gh = JSON.parse(await fixture('greenhouse.json')); gh.jobs[0].internal_job_id = null;
  assert.equal(adaptSource(source('greenhouse'), JSON.stringify(gh), now).jobs.length, 0);
});
test('future and invalid calendar dates never become publication evidence', async () => {
  const body = JSON.parse(await fixture('ashby.json'));
  for (const date of ['2099-01-01', '2026-02-30', 'yesterday', '2026-09-18garbage']) {
    body.jobs[0].publishedAt = date;
    assert.equal(adaptSource(source('ashby'), JSON.stringify(body), now).jobs[0]?.opportunity.publishedAt, undefined);
  }
});
test('RSS Jobscollider/RemoteFirstJobs titles ending in " at Company" extract company; WWR pattern untouched', async () => {
  const rss = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Jobscollider</title>' +
    '<item><title>Senior Backend Engineer at Acme</title><link>https://jobscollider.com/job/42</link>' +
    '<guid>42</guid><pubDate>Fri, 18 Sep 2026 08:00:00 GMT</pubDate><description><![CDATA[Build TypeScript services.]]></description></item>' +
    '</channel></rss>';
  const result = adaptSource(source('rss', { endpoint: 'https://jobscollider.com/remote-jobs.rss' }), rss, now);
  assert.equal(result.rejected, 0); assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0]!.opportunity.title, 'Senior Backend Engineer'); assert.equal(result.jobs[0]!.opportunity.company, 'Acme');
});
test('RSS parser rejects XXE, malformed nesting, duplicate fields and unsupported entities', () => {
  for (const xml of ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', '<rss><channel></rss>', '<rss><channel><item><title>A</title><title>B</title></item></channel></rss>', '<rss><channel><item><title>&evil;</title></item></channel></rss>']) assert.throws(() => parseRss(xml));
});
test('canonical dedup preserves provenance and meaningful URL query identity; conflicts quarantine', async () => {
  const job = adaptSource(source('ashby'), await fixture('ashby.json'), now).jobs[0]!;
  const copy = structuredClone(job); copy.provenance[0]!.sourceId = 'rss'; copy.opportunity.url += '/?utm_source=rss#x';
  assert.equal(canonicalUrl(copy.opportunity.url!), job.opportunity.url);
  const merged = deduplicate([job, copy]); assert.equal(merged.length, 1); assert.equal(merged[0]!.provenance.length, 2);
  assert.equal(identity(merged[0]!.opportunity), identity(job.opportunity));
  assert.notEqual(canonicalUrl('https://example.com/job?id=1'), canonicalUrl('https://example.com/job?id=2'));
  copy.opportunity.company = 'Different';
  const conflicting = deduplicate([job, copy, job])[0]!;
  assert.equal(conflicting.opportunity.publishedAt, undefined); assert.equal(conflicting.opportunity.availability?.outcome, 'ambiguous');
  assert.ok(conflicting.warnings.includes('duplicate_conflict'));
});
test('Lever pagination drains complete pages and fails repeated pages without partial success', async () => {
  const row = JSON.parse(await fixture('lever.json'))[0]; let calls = 0;
  const page = Array.from({ length: 100 }, (_, i) => ({ ...row, id: `job-${i}`, hostedUrl: `https://jobs.lever.co/acme/job-${i}` }));
  const result = await collectSource(source('lever'), now, { resolveHost: resolver, transport: async req => {
    calls++; assert.equal(new URL(req.url).searchParams.get('skip'), calls === 1 ? '0' : '100'); return response(JSON.stringify(calls === 1 ? page : []));
  } });
  assert.equal(calls, 2); assert.equal(result.jobs.length, 100);
  await assert.rejects(collectSource(source('lever'), now, { resolveHost: resolver, transport: async () => response(JSON.stringify(page)) }), /source_pagination_repeated/);
});
test('HTML failure supersedes API availability; publication conflict blocks eligibility', async () => {
  const body = await fixture('ashby.json');
  const opts = { resolveHost: resolver, transport: async () => response(body) };
  const failed = await collectSource(source('ashby', { captureHtml: true }), now, { ...opts, htmlFetch: async () => ({ status: 403, headers: {}, body: '' }) });
  assert.equal(failed.jobs[0]!.opportunity.availability?.outcome, 'ambiguous');
  const result = await collectSource(source('ashby', { captureHtml: true }), now, { ...opts, htmlFetch: async req => ({ status: 200, headers: { 'content-type': 'text/html' }, body: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url: req.url, datePosted: '2026-09-19' })}</script>` }) });
  assert.equal(result.jobs[0]!.opportunity.publishedAt, undefined);
  assert.equal(result.jobs[0]!.opportunity.availability?.evidence, 'publication_conflict');
});
test('dry-run gate blocks enabled Notion config before reads; default disabled sources make no requests', async () => {
  const transport = async () => { assert.fail('no network expected'); };
  await assert.rejects(runSourceCycle({ sources: [source('ashby')], profile, now, notionConfig: { ...config, enabled: true }, transport }), /external_writes_disabled/);
  const result = await runSourceCycle({ sources: [source('ashby', { enabled: false })], profile, now, transport });
  assert.equal(result.mode, 'dry-run'); assert.equal(result.confirmed, false); assert.equal(result.notionPlan.confirmed, false);
});
test('cycle normalizes, deduplicates, plans and replays with stable Notion identity; no external transport', async () => {
  const body = await fixture('ashby.json'); const data = JSON.parse(body); data.jobs.push(data.jobs[0]);
  const options = { sources: [source('ashby')], profile, now, notionConfig: config, resolveHost: resolver, transport: async () => response(JSON.stringify(data)) };
  const first = await runSourceCycle(options); const second = await runSourceCycle({ ...options, store: first.store, state: first.state });
  assert.equal(first.counts.duplicates, 1); assert.equal(first.notionPlan.records.length, 1); assert.equal(first.notionPlan.confirmed, false);
  assert.deepEqual(second.store, first.store); assert.equal(second.health[0]!.status, 'not_due');
  assert.equal(second.notionPlan.records[0]?.externalKey, first.notionPlan.records[0]?.externalKey);
  const rows = report(first.store, profile, now).notion.records;
  let stored: Record<string, unknown> | undefined; let writes = 0;
  const transport: HttpTransport = async request => {
    if (request.url.endsWith('/query')) return { status: 200, body: { object: 'list', has_more: false, results: stored ? [{ object: 'page', id: 'fixture-page', properties: stored }] : [] } };
    stored = request.body.properties as Record<string, unknown>; writes++; return { status: 200, body: { object: 'page', id: 'fixture-page' } };
  };
  assert.equal((await upsertNotionRecords(rows, { ...config, enabled: true }, transport, { now: () => now })).created, 1);
  assert.equal((await upsertNotionRecords(rows, { ...config, enabled: true }, transport, { now: () => now })).skipped, 1);
  assert.equal(writes, 1);
});
test('legacy source-key records retain identity; existing duplicate aliases are blocked', async () => {
  const body = await fixture('ashby.json'), job = adaptSource(source('ashby'), body, now).jobs[0]!;
  const store = ingest({ version: 1, records: [] }, { ...job.opportunity, source: 'existing', externalId: '42' });
  const options = { sources: [source('ashby')], profile, now, notionConfig: config, resolveHost: resolver, transport: async () => response(body) };
  const result = await runSourceCycle({ ...options, store });
  assert.equal(result.store.records.length, 1); assert.equal(result.store.records[0]!.id, store.records[0]!.id);
  const aliases = ingest(store, { ...job.opportunity, source: 'other', externalId: '43' });
  const blocked = await runSourceCycle({ ...options, store: aliases });
  assert.equal(blocked.store.records.length, 2); assert.equal(blocked.notionPlan.records.length, 0);
});
test('a stored record on a disallowed host cannot abort the cycle', async () => {
  // Measured 2026-09-19: 46 LinkedIn alert records in data/offers.json killed every run with
  // `source_disallowed`, thrown by canonicalUrl() out of the legacy-alias filter. safe-http
  // disallows linkedin.com by design, so one unreachable host in the existing store took down
  // all sources. A record that cannot be canonicalised simply cannot alias an incoming job.
  const body = await fixture('ashby.json'), job = adaptSource(source('ashby'), body, now).jobs[0]!;
  const poisoned = ingest({ version: 1, records: [] },
    { ...job.opportunity, url: 'https://www.linkedin.com/jobs/view/123456789', source: 'linkedin', externalId: 'li-1' });
  assert.throws(() => canonicalUrl(poisoned.records[0]!.opportunity.url!), /source_disallowed/);
  const result = await runSourceCycle({ sources: [source('ashby')], profile, now, notionConfig: config,
    resolveHost: resolver, transport: async () => response(body), store: poisoned });
  assert.equal(result.health[0]!.status, 'ok');
  assert.ok(result.counts.captured > 0, 'the allowed source still produces jobs');
});
test('source failures remain unhealthy during cooldown and never echo secrets', async () => {
  const options = { sources: [source('ashby')], profile, now, resolveHost: resolver, transport: async () => { throw new Error('SECRET_VALUE'); } };
  const result = await runSourceCycle(options);
  const next = await runSourceCycle({ ...options, state: result.state });
  assert.equal(next.health[0]!.status, 'failed'); assert.equal(JSON.stringify(result).includes('SECRET_VALUE'), false);
});
test('optional enrichment follows capture, rejects evidence mutation, never changes deterministic fields', async () => {
  const body = await fixture('ashby.json'); let captured = false, enriched = 0;
  const result = await runSourceCycle({ sources: [source('ashby')], profile, now, notionConfig: config, resolveHost: resolver,
    transport: async () => { captured = true; return response(body); }, enrich: async job => {
      assert.ok(captured); assert.ok(job.provenance.length); enriched++; job.opportunity.publishedAt = '2099-01-01';
      return { summary: 'Backend role', skills: [{ name: 'TypeScript', quote: 'Build TypeScript services.' }] };
    } });
  assert.equal(enriched, 1); assert.equal(result.jobs[0]!.opportunity.publishedAt, '2026-09-18'); assert.deepEqual(result.jobs[0]!.opportunity.skills, []);
  const failed = await runSourceCycle({ sources: [source('ashby')], profile, now, resolveHost: resolver, transport: async () => response(body), enrich: async () => ({ summary: 'x', skills: [], publishedAt: '2099-01-01' }) });
  assert.ok(failed.jobs[0]!.warnings.includes('enrichment_failed'));
});
test('checkpoint atomically persists local plan and cadence, retains provenance, reports stale health and preserves legacy input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-sources-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), '{}');
    await writeFile(join(root, 'examples/sources.json'), JSON.stringify({ version: 1, sources: [{ id: 'ashby', adapter: 'ashby', enabled: true, board: 'acme', company: 'Acme' }] }));
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: true, config }));
    const legacy = '{"version":1,"records":[]}'; await writeFile(join(root, 'data/offers.json'), legacy);
    const body = await fixture('ashby.json');
    const first = await runSources({ root, now, dependencies: { resolveHost: resolver, transport: async () => response(body) } });
    const second = await runSources({ root, now, dependencies: { transport: async () => assert.fail('cadence prevents network') } });
    assert.deepEqual(second.store, first.store);
    assert.equal(await readFile(join(root, 'data/offers.json'), 'utf8'), legacy);
    const disk = JSON.parse(await readFile(join(root, 'data/source-cycle.json'), 'utf8'));
    assert.equal(Object.keys(disk.provenance).length, 1); assert.equal(disk.confirmed, false);
    // `jobs` no se persiste: nadie lo relee y duplicaba el checkpoint. Lo que sí se recupera, sigue ahí.
    assert.equal(Object.hasOwn(disk, 'jobs'), false);
    assert.ok(first.jobs.length > 0, 'el ciclo sí devuelve jobs en memoria');
    for (const key of ['version', 'mode', 'confirmed', 'state', 'store', 'provenance']) assert.ok(Object.hasOwn(disk, key), key);
    assert.equal((await sourceHealth(root, now)).healthy, true);
    assert.equal((await sourceHealth(root, new Date('2026-09-21'))).healthy, false);
    assert.equal(await sourcesMain(['--sync'], root), 5);
    await writeFile(join(root, 'data/source-cycle.json'), '{malformed');
    await assert.rejects(runSources({ root, now }));
    assert.equal(await readFile(join(root, 'data/source-cycle.json'), 'utf8'), '{malformed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('un checkpoint ausente no es una degradación: --health sale 0 hasta el primer ciclo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-health-'));
  try {
    await mkdir(join(root, 'data'));
    const missing = await sourceHealth(root, now);
    assert.equal(missing.healthy, false);
    assert.equal(missing.reason, 'no_checkpoint');
    assert.equal(await sourcesMain(['--health'], root), 0, 'una instalación limpia no debe alertar');
    // Un checkpoint presente pero vencido sí es una degradación real y sí alerta.
    await writeFile(join(root, 'data/source-cycle.json'), JSON.stringify({ version: 1, mode: 'dry-run', confirmed: false,
      generatedAt: new Date(now.getTime() - 25 * 60 * 60_000).toISOString(), health: [{ sourceId: 'ashby', status: 'ok' }] }));
    assert.equal((await sourceHealth(root, now)).reason, 'checkpoint_degraded');
    assert.equal(await sourcesMain(['--health'], root), 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('--dry-run distingue "sin Notion configurado" de "esquema sin verificar"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-clean-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), '{}');
    // Fuentes deshabilitadas: el ciclo no toca la red y aun así produce un plan.
    await writeFile(join(root, 'examples/sources.json'), JSON.stringify({ version: 1, sources: [{ id: 'ashby', adapter: 'ashby', enabled: false, board: 'acme', company: 'Acme' }] }));
    await writeFile(join(root, 'data/offers.json'), JSON.stringify(ingest({ version: 1, records: [] },
      { title: 'Developer', company: 'Acme', url: 'https://example.com/job', skills: [] })));
    assert.equal(await sourcesMain(['--dry-run'], root), 0, 'sin notion-local.json el ciclo completo es un éxito');
    const disk = JSON.parse(await readFile(join(root, 'data/source-cycle.json'), 'utf8'));
    assert.equal(disk.notionPlan.blocked[0]?.reason, 'schema_unverified');
    // El mismo bloqueo, pero con un destino Notion declarado y sin verificar, sí debe avisar.
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: false, config }));
    assert.equal(await sourcesMain(['--dry-run'], root), 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('--dry-run never trips the write guard when notion-local.json has an enabled config, and makes no Notion calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-sources-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), '{}');
    await writeFile(join(root, 'examples/sources.json'), JSON.stringify({ version: 1, sources: [{ id: 'ashby', adapter: 'ashby', enabled: true, board: 'acme', company: 'Acme' }] }));
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: true, config: { ...config, enabled: true } }));
    const body = await fixture('ashby.json');
    const result = await runSources({ root, now, dependencies: { resolveHost: resolver, transport: async () => response(body) } });
    assert.equal(result.mode, 'dry-run'); assert.equal(result.confirmed, false); assert.equal(result.notionPlan.confirmed, false);
    assert.equal(result.health[0]!.status, 'ok'); assert.equal(result.notionPlan.records.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('state timestamps reject corruption instead of silently resetting cadence', () => {
  for (const state of [null, { version: 1, lastAttempt: { ashby: 'yesterday' } }, { version: 1, lastAttempt: {}, lastResult: { ashby: 'maybe' } }]) assert.throws(() => parseSourceState(state));
});

test('RSS calendar rollover and future cadence never masquerade as fresh healthy evidence', async () => {
  const body = (await fixture('jobs.rss')).replace('Fri, 18 Sep 2026 08:00:00 GMT', 'Mon, 30 Feb 2026 08:00:00 GMT');
  assert.equal(adaptSource(source('rss'), body, now).jobs[0]?.opportunity.publishedAt, undefined);
  const result = await runSourceCycle({ sources: [source('ashby')], profile, now,
    state: { version: 1, lastAttempt: { ashby: '2099-01-01T00:00:00.000Z' } }, transport: async () => assert.fail('no requests with corrupt future cadence') });
  assert.equal(result.health[0]?.status, 'failed'); assert.equal(result.health[0]?.reason, 'source_clock_invalid');
});

test('--sync requires a verified enabled Notion config and never recollects sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-sync-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), '{}');
    const checkpoint = { version: 1, mode: 'dry-run', confirmed: false, generatedAt: now.toISOString(),
      health: [{ sourceId: 'ashby', status: 'ok', fetched: 1, rejected: 0, checkedAt: now.toISOString() }],
      store: { version: 1, records: [] } };
    await writeFile(join(root, 'data/source-cycle.json'), JSON.stringify(checkpoint));
    const transport = async () => { assert.fail('no network expected'); };
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: true, config: { ...config, enabled: false } }));
    await assert.rejects(runNotionSync({ root, now, dependencies: { transport } }), /notion_sync_disabled/);
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: false, config: { ...config, enabled: true } }));
    await assert.rejects(runNotionSync({ root, now, dependencies: { transport } }), /notion_sync_disabled/);
    await rm(join(root, 'data/notion-local.json'));
    await assert.rejects(runNotionSync({ root, now, dependencies: { transport } }), /notion_sync_disabled/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--sync refuses a stale or unhealthy checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-sync-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), '{}');
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: true, config: { ...config, enabled: true } }));
    const transport = async () => { assert.fail('no network expected'); };
    const stale = { version: 1, mode: 'dry-run', confirmed: false, generatedAt: new Date(now.getTime() - 25 * 60 * 60_000).toISOString(),
      health: [{ sourceId: 'ashby', status: 'ok', fetched: 1, rejected: 0, checkedAt: now.toISOString() }], store: { version: 1, records: [] } };
    await writeFile(join(root, 'data/source-cycle.json'), JSON.stringify(stale));
    await assert.rejects(runNotionSync({ root, now, dependencies: { transport } }), /checkpoint_unhealthy/);
    const failed = { ...stale, generatedAt: now.toISOString(), health: [{ sourceId: 'ashby', status: 'failed', fetched: 0, rejected: 0, checkedAt: now.toISOString() }] };
    await writeFile(join(root, 'data/source-cycle.json'), JSON.stringify(failed));
    await assert.rejects(runNotionSync({ root, now, dependencies: { transport } }), /checkpoint_unhealthy/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--sync reads the existing checkpoint store and writes through the existing upsert path with a fake transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-sync-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), '{}');
    const body = await fixture('ashby.json');
    const cycle = await runSourceCycle({ sources: [source('ashby')], profile, now, resolveHost: resolver, transport: async () => response(body) });
    const checkpoint = { version: 1, mode: 'dry-run', confirmed: false, generatedAt: now.toISOString(),
      health: [{ sourceId: 'ashby', status: 'ok', fetched: 1, rejected: 0, checkedAt: now.toISOString() }], store: cycle.store };
    await writeFile(join(root, 'data/source-cycle.json'), JSON.stringify(checkpoint));
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: true, config: { ...config, enabled: true } }));
    let stored: Record<string, unknown> | undefined; let writes = 0;
    const transport: HttpTransport = async request => {
      if (request.url.endsWith('/query')) return { status: 200, body: { object: 'list', has_more: false, results: stored ? [{ object: 'page', id: 'fixture-page', properties: stored }] : [] } };
      stored = request.body.properties as Record<string, unknown>; writes++; return { status: 200, body: { object: 'page', id: 'fixture-page' } };
    };
    const result = await runNotionSync({ root, now, dependencies: { transport } });
    assert.equal(result.counts.created, 1); assert.equal(result.counts.failed, 0); assert.equal(writes, 1);
    const saved = JSON.parse(await readFile(join(root, 'data/notion-sync.json'), 'utf8'));
    assert.deepEqual(saved.counts, result.counts);
    const disk = JSON.parse(await readFile(join(root, 'data/source-cycle.json'), 'utf8'));
    assert.deepEqual(disk.store, cycle.store);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--sync surfaces an occupied lock through the CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-sync-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'data/automation.lock'), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    assert.equal(await sourcesMain(['--sync'], root), 3);
    assert.equal(await sourcesMain(['--sync', 'extra'], root), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
