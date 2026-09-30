import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRegistry, sourceHeaders, MAX_SOURCES, type Source } from '../src/source-registry.ts';
import { adaptSource, canonicalUrl } from '../src/source-adapters.ts';
import { parseRss } from '../src/rss.ts';
import { collectSource, deduplicate, probeSource, runSourceCycle } from '../src/multi-source.ts';
import { parseOpportunity, parseProfile } from '../src/contracts.ts';
import { relevance } from '../src/relevance.ts';
import { identity, ingest, report } from '../src/pipeline.ts';
import { runSources, runNotionSync, sourceHealth, parseSourceState, sourcesMain } from '../src/source-cli.ts';
import { upsertNotionRecords, compactNotionPlan, type HttpTransport } from '../src/notion-sync.ts';
const now = new Date('2026-09-19T12:00:00Z'), profile = parseProfile({});
const config = { enabled: false, dataSourceId: '12345678-1234-1234-1234-123456789012', externalKeyProperty: 'External key' };
const fixture = (name: string) => readFile(new URL(`./fixtures/sources/${name}`, import.meta.url), 'utf8');
const source = (adapter: Source['adapter'], extra = {}): Source => parseRegistry({ version: 1, sources: [{ id: adapter, adapter, enabled: true,
  ...(['greenhouse', 'lever', 'ashby'].includes(adapter) ? { board: 'acme', company: 'Acme' } : {}),
  ...(adapter === 'rss' ? { endpoint: 'https://weworkremotely.com/remote-jobs.rss' } : {}), ...extra }] })[0]!;
const resolver = async () => ['93.184.216.34'];
const response = (body: string) => ({ status: 200, headers: { 'content-type': 'application/json' }, body });
/** Esquema mínimo que `verifyNotionSchema` debe encontrar en la base para permitir escribir. */
const notionSchema = (overrides: Record<string, { type: string }> = {}) => ({
  Name: { type: 'title' }, Company: { type: 'rich_text' }, URL: { type: 'url' }, Type: { type: 'select' },
  Expiration: { type: 'select' }, Deadline: { type: 'date' }, Verification: { type: 'select' },
  'Verification reasons': { type: 'rich_text' }, Published: { type: 'date' }, Screening: { type: 'select' },
  'Screening reasons': { type: 'rich_text' }, 'Employment eligibility': { type: 'select' },
  Location: { type: 'rich_text' }, Relocation: { type: 'select' }, 'Recommendation rank': { type: 'number' },
  'Recommendation priority': { type: 'number' }, Relevance: { type: 'number' }, 'Relevance tier': { type: 'select' },
  'Fit score': { type: 'number' }, 'Economic score': { type: 'number' }, 'Hourly USD': { type: 'number' },
  'Freelance review': { type: 'select' }, Origin: { type: 'rich_text' }, 'External key': { type: 'rich_text' }, ...overrides,
});

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
  // Las etiquetas de bloque se vuelven saltos de línea, no espacios: son el límite de oración.
  // Sin ellos, una lista con viñetas se convierte en una sola frase de miles de caracteres y
  // cualquier análisis por oración decide sobre texto que nunca estuvo junto.
  assert.equal(description, 'Build & ship services\nTypeScript');
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
test('la salud se decide por quórum, no por unanimidad', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-quorum-'));
  try {
    await mkdir(join(root, 'data'));
    const checkpoint = (statuses: string[]) => JSON.stringify({ version: 1, mode: 'dry-run', confirmed: false, generatedAt: now.toISOString(),
      health: statuses.map((status, i) => ({ sourceId: `s${i}`, status, fetched: 0, rejected: 0, checkedAt: now.toISOString() })) });
    const write = (statuses: string[]) => writeFile(join(root, 'data/source-cycle.json'), checkpoint(statuses));
    const many = (n: number, status: string) => Array.from({ length: n }, () => status);
    // Una rota de veinte no puede dejar sin ofertas a nadie por un 429 ajeno.
    await write([...many(19, 'ok'), 'failed']);
    assert.equal((await sourceHealth(root, now)).healthy, true);
    assert.deepEqual((await sourceHealth(root, now)).quorum?.degraded, ['s19'], 'la rota se reporta con nombre aunque no bloquee');
    // Pero una mayoría rota sí significa que el resultado no es fiable.
    await write([...many(16, 'ok'), ...many(4, 'failed')]);
    assert.equal((await sourceHealth(root, now)).healthy, true, '80% exacto todavía alcanza el quórum');
    await write([...many(15, 'ok'), ...many(5, 'failed')]);
    assert.equal((await sourceHealth(root, now)).healthy, false, '75% ya no es fiable');
    // Las deshabilitadas no cuentan como rotas ni como sanas: salen del denominador.
    await write([...many(4, 'ok'), ...many(16, 'disabled')]);
    assert.equal((await sourceHealth(root, now)).healthy, true);
    await write(many(3, 'disabled'));
    assert.equal((await sourceHealth(root, now)).healthy, false, 'un ciclo sin ninguna fuente activa no sirve para sincronizar');
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
    // El sync ahora COMPRUEBA el esquema antes de escribir, así que el transporte falso tiene que
    // devolverlo. Es justo la protección que faltaba: sin ella, cada upsert devolvía 400.
    const transport: HttpTransport = async request => {
      if (request.method === 'GET') return { status: 200, body: { object: 'data_source', properties: notionSchema() } };
      if (request.url.endsWith('/query')) {
        return { status: 200, body: { object: 'list', has_more: false,
          results: stored ? [{ object: 'page', id: 'fixture-page', properties: stored }] : [] } };
      }
      stored = request.body.properties as Record<string, unknown>; writes++; return { status: 200, body: { object: 'page', id: 'fixture-page' } };
    };
    const result = await runNotionSync({ root, now, dependencies: { transport } });
    assert.equal(result.counts.created, 1); assert.equal(result.counts.failed, 0); assert.equal(writes, 1);
    const saved = JSON.parse(await readFile(join(root, 'data/notion-sync.json'), 'utf8'));
    assert.deepEqual(saved.counts, result.counts);
    assert.equal('failures' in saved, false, 'sin fallos no se escribe la clave');
    // Un fallo se guarda con su motivo y su clave: "failed: 2" a secas no permite volver a ellos.
    const rompiendo: HttpTransport = async request => {
      if (request.method === 'GET') return { status: 200, body: { object: 'data_source', properties: notionSchema() } };
      if (request.url.endsWith('/query')) return { status: 500, body: null };
      return { status: 200, body: { object: 'page', id: 'fixture-page' } };
    };
    await runNotionSync({ root, now, dependencies: { transport: rompiendo } });
    const conFallos = JSON.parse(await readFile(join(root, 'data/notion-sync.json'), 'utf8'));
    assert.equal(conFallos.counts.failed, 1);
    assert.equal(conFallos.failures.length, 1);
    assert.ok(conFallos.failures[0].reason, 'el motivo queda registrado');
    assert.match(conFallos.failures[0].externalKey, /^[a-f\d]{64}$/);
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

test('--probe-source mide lo que decide si un board sirve: fecha, geografía y rol', async () => {
  // Adivinar el identificador de un board acierta poco; y un board que EXISTE no es un board que
  // SIRVA. Lo que decide son tres cosas, y el sondeo las mide antes de tocar sources.json.
  const body = JSON.parse(await fixture('ashby.json'));
  const restringida = { ...body.jobs[0], title: 'Senior Backend Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/job-43', location: 'Remote, US' };
  const sinFecha = { ...body.jobs[0], title: 'Platform Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/job-44', publishedAt: undefined };
  const transport = async () => response(JSON.stringify({ ...body, jobs: [body.jobs[0], restringida, sinFecha] }));
  const buscador = parseProfile({ skills: ['typescript'], remoteOnly: true, relevance: { roleTerms: { ai_automation: ['backend engineer', 'platform engineer'] } } });

  const probe = await probeSource(source('ashby'), buscador, now, { resolveHost: resolver, transport });
  assert.equal(probe.jobs, 3);
  // Sin fecha, el gate de frescura tumba el 100% de sus ofertas. Ese fue el fallo del adaptador
  // de Greenhouse y costó seis sesiones: el sondeo lo vuelve visible en una línea.
  assert.equal(probe.withPublishedAt, 2);
  assert.equal(probe.withinWindow, 2);
  // Un "Remote, US" no es remoto desde Colombia. Medido el 2026-09-22, ese bloqueo se come el 98%
  // del pool, así que el volumen bruto de un board no dice nada sobre lo que aportará al corte.
  assert.equal(probe.geoViable, 2, 'la restringida a US no cuenta como viable');
  assert.equal(probe.roleRelevant, 2);
  assert.ok(probe.sample.includes('Backend engineer'));

  // Un board que no existe se reporta como dato, no como excepción: sondear es leer.
  assert.equal(await sourcesMain(['--probe-source', 'ashby']), 2, 'faltando el token, se rechazan los argumentos');
});

test('el plan de Notion persistido guarda claves y motivos, no peticiones HTTP', async () => {
  // Medido el 2026-09-30: de los 427 MB del checkpoint, 57,4 MB eran peticiones HTTP del plan
  // —URL, cabeceras y cuerpo por registro— y ningún código las leía: `upsertNotionRecords`
  // reconstruye la suya desde el registro vigente, porque vuelve a pasar el gate antes de escribir.
  const root = await mkdtemp(join(tmpdir(), 'offers-plan-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), '{}');
    await writeFile(join(root, 'examples/sources.json'), JSON.stringify({ version: 1, sources: [{ id: 'ashby', adapter: 'ashby', enabled: false, board: 'acme', company: 'Acme' }] }));
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: true, config }));
    const fresh = new Date().toISOString();
    const url = 'https://example.com/job';
    await writeFile(join(root, 'data/offers.json'), JSON.stringify(ingest({ version: 1, records: [] }, [parseOpportunity({
      title: 'Senior Software Engineer', company: 'Acme', skills: [], url, publishedAt: fresh.slice(0, 10),
      publicationEvidence: { url, excerpt: 'Published', observedAt: fresh },
      availability: { url, checkedAt: fresh, outcome: 'open', httpStatus: 200, evidence: 'listing' } })])));

    const result = await runSources({ root });
    // En MEMORIA el plan sigue completo: es lo que el CLI inspecciona para decidir el código de
    // salida, y lo que las pruebas de notion-sync cotejan propiedad por propiedad.
    assert.ok(result.notionPlan.records.length > 0, 'la oferta vigente debe planificarse');
    assert.ok('create' in result.notionPlan.records[0]!, 'el plan en memoria conserva la petición');

    const disk = JSON.parse(await readFile(join(root, 'data/source-cycle.json'), 'utf8'));
    assert.deepEqual(disk.notionPlan.records, [result.notionPlan.records[0]!.externalKey], 'en disco solo la clave');
    // La prueba que de verdad importa: ni una URL de Notion ni una cabecera en todo el archivo.
    const serialized = JSON.stringify(disk.notionPlan);
    for (const leak of ['api.notion.com', 'Notion-Version', 'query-then-upsert', 'properties']) {
      assert.equal(serialized.includes(leak), false, `el plan persistido no debe contener "${leak}"`);
    }
    assert.equal(disk.counts.eligible, 1, 'el recuento se calcula del plan en memoria y no cambia');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('el plan persistido conserva el motivo de bloqueo en sus dos formas', async () => {
  // `planNotionSync` bloquea con la verificación completa; el plan de reserva, sin esquema
  // verificado, bloquea con un motivo único. Compactar no puede colapsar las dos en una.
  const verification = { status: 'unknown' as const, reasons: ['availability_missing'], ageDays: null, sameDay: false, validUntil: null, windowDays: 7 };
  const key = 'a'.repeat(64);
  assert.deepEqual(compactNotionPlan({ mode: 'dry-run', confirmed: false, records: [], blocked: [{ externalKey: key, verification }] }).blocked,
    [{ externalKey: key, reasons: ['availability_missing'] }]);
  assert.deepEqual(compactNotionPlan({ mode: 'dry-run', confirmed: false, records: [], blocked: [{ externalKey: key, reason: 'schema_unverified' }] }).blocked,
    [{ externalKey: key, reason: 'schema_unverified' }]);
});

test('la salud del ciclo se lee de un archivo de KB, no del checkpoint', async () => {
  // `--health` solo mira fecha, modo y estado por fuente, pero los sacaba de un `JSON.parse` del
  // checkpoint entero: 427 MB medidos el 2026-09-30 para leer 32 entradas. Y `--sync` lo hacía dos
  // veces, una aquí y otra para el store.
  const root = await mkdtemp(join(tmpdir(), 'offers-health-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), '{}');
    await writeFile(join(root, 'examples/sources.json'), JSON.stringify({ version: 1, sources: [{ id: 'ashby', adapter: 'ashby', enabled: false, board: 'acme', company: 'Acme' }] }));
    await writeFile(join(root, 'data/offers.json'), JSON.stringify(ingest({ version: 1, records: [] },
      { title: 'Developer', company: 'Acme', url: 'https://example.com/job', skills: [] })));
    assert.equal(await sourcesMain(['--dry-run'], root), 0);

    const summary = JSON.parse(await readFile(join(root, 'data/source-health.json'), 'utf8'));
    assert.equal(summary.version, 1);
    assert.equal(summary.mode, 'dry-run');
    assert.ok(Array.isArray(summary.health));
    // El resumen NO lleva el store ni el plan: si los llevara, no habría ahorrado nada.
    for (const heavy of ['store', 'notionPlan', 'provenance', 'enrichments', 'jobs']) {
      assert.equal(heavy in summary, false, `el resumen de salud no debe contener "${heavy}"`);
    }
    const checkpointBytes = (await readFile(join(root, 'data/source-cycle.json'), 'utf8')).length;
    const summaryBytes = (await readFile(join(root, 'data/source-health.json'), 'utf8')).length;
    assert.ok(summaryBytes < checkpointBytes, 'el resumen debe ser más pequeño que el checkpoint');

    // Con el checkpoint BORRADO, la salud sigue leyéndose: la prueba de que ya no lo parsea.
    await rm(join(root, 'data/source-cycle.json'));
    const health = await sourceHealth(root, new Date(summary.generatedAt));
    assert.equal(health.generatedAt, summary.generatedAt);
    assert.notEqual(health.reason, 'no_checkpoint', 'con resumen presente no es una instalación limpia');

    // Y sin el resumen, cae al checkpoint: una instalación cuyo primer ciclo nuevo no ha corrido.
    await rm(join(root, 'data/source-health.json'));
    await writeFile(join(root, 'data/source-cycle.json'), JSON.stringify({ version: 1, mode: 'dry-run', confirmed: false,
      generatedAt: summary.generatedAt, health: [{ sourceId: 'ashby', status: 'ok' }], counts: {} }));
    assert.equal((await sourceHealth(root, new Date(summary.generatedAt))).healthy, true, 'el respaldo por checkpoint sigue funcionando');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('la descripción se acota en todos los adaptadores, no solo en greenhouse', async () => {
  // `DESCRIPTION_LIMIT` vivía dentro de `htmlToText`, que es el camino de Greenhouse. Los otros
  // nueve adaptadores guardaban hasta 100.000 caracteres, cinco veces el tope.
  const largo = `Build TypeScript services. ${'x'.repeat(60_000)}`;
  const body = JSON.parse(await fixture('ashby.json'));
  const { jobs } = adaptSource(source('ashby'), JSON.stringify({ ...body, jobs: [{ ...body.jobs[0], descriptionPlain: largo }] }), now);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.opportunity.description!.length, 20_000, 'acotada al tope declarado');

  // Y la invariante que hace peligroso acotar en dos sitios: si el detector de patrocinio viera
  // más texto que el campo guardado, una cita del tramo cortado haría fallar `parseOpportunity`.
  const citaCortada = `Build services. ${'y'.repeat(25_000)} We sponsor visas for this role.`;
  const conCita = adaptSource(source('ashby'), JSON.stringify({ ...body, jobs: [{ ...body.jobs[0], descriptionPlain: citaCortada }] }), now);
  assert.equal(conCita.jobs.length, 1, 'la fila no se rechaza: el detector ve el mismo texto acotado');
  assert.equal(conCita.jobs[0]!.opportunity.sponsorship, undefined, 'la mención quedó fuera del tope y no se afirma');
});

test('--vacuum informa sin escribir y solo borra con --apply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-vacuum-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), '{}');
    const fresh = new Date().toISOString();
    const stamp = (url: string, publishedAt: string) => ({ title: 'Developer', company: 'Acme', skills: [], url, publishedAt,
      publicationEvidence: { url, excerpt: 'Published', observedAt: fresh },
      availability: { url, checkedAt: fresh, outcome: 'open' as const, httpStatus: 200, evidence: 'listing' } });
    const viva = stamp('https://example.com/viva', fresh.slice(0, 10));
    const vieja = stamp('https://example.com/vieja', '2026-01-15');
    const store = ingest({ version: 1, records: [] }, [viva, vieja]);
    // `provenance` con una clave huérfana: ninguna oferta viva la reclama.
    await writeFile(join(root, 'data/source-cycle.json'), JSON.stringify({ version: 1, mode: 'dry-run', confirmed: false,
      generatedAt: fresh, store, counts: {}, provenance: { [viva.url]: [], [vieja.url]: [], 'https://example.com/fantasma': [] } }, null, 2));
    const before = await readFile(join(root, 'data/source-cycle.json'), 'utf8');

    const out: string[] = [];
    const log = console.log;
    console.log = (line: string) => { out.push(line); };
    try { assert.equal(await sourcesMain(['--vacuum', '--dry-run'], root), 0); } finally { console.log = log; }
    const dry = JSON.parse(out.at(-1)!);
    assert.equal(dry.records, 2);
    assert.equal(dry.wouldRemove, 1, 'la publicada en enero no puede volver a un corte');
    assert.equal(dry.applied, false);
    assert.equal(dry.provenanceKeys, 3);
    assert.equal(dry.provenanceKept, 1, 'solo la URL de la oferta viva');
    assert.ok(dry.bytesAfter < dry.bytesBefore);
    // LA propiedad: el archivo no se tocó. Byte a byte.
    assert.equal(await readFile(join(root, 'data/source-cycle.json'), 'utf8'), before, '--dry-run no escribe');

    out.length = 0;
    console.log = (line: string) => { out.push(line); };
    try { assert.equal(await sourcesMain(['--vacuum', '--apply'], root), 0); } finally { console.log = log; }
    assert.equal(JSON.parse(out.at(-1)!).applied, true);
    const after = JSON.parse(await readFile(join(root, 'data/source-cycle.json'), 'utf8'));
    assert.equal(after.store.records.length, 1);
    assert.deepEqual(Object.keys(after.provenance), [viva.url]);
    assert.equal(after.generatedAt, fresh, 'la purga no reescribe el resto del checkpoint');
    // Idempotente: una segunda pasada no encuentra nada.
    out.length = 0;
    console.log = (line: string) => { out.push(line); };
    try { assert.equal(await sourcesMain(['--vacuum', '--apply'], root), 0); } finally { console.log = log; }
    assert.equal(JSON.parse(out.at(-1)!).wouldRemove, 0);
    // Un argumento desconocido se rechaza en vez de interpretarse como "borra".
    assert.equal(await sourcesMain(['--vacuum', '--force'], root), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('freehire: fecha presente, región declarada como restricción y descripción en texto', async () => {
  // Fixture capturado del servicio real el 2026-09-30. La primera afirmación es la lección que
  // costó seis sesiones con greenhouse: un adaptador sin `publishedAt` hace que el gate de frescura
  // tumbe el 100% de sus ofertas, y nada lo detectaba hasta medir por qué el corte bajó.
  // El fixture se capturó el 2026-09-30, así que se juzga con un reloj de ese día: `publication()`
  // rechaza una fecha futura, y con el reloj compartido de las demás pruebas lo serían todas.
  const capturado = new Date('2026-09-30T12:00:00Z');
  const { jobs, rejected } = adaptSource(source('freehire'), await fixture('freehire.json'), capturado);
  assert.equal(rejected, 0);
  assert.equal(jobs.length, 3);
  for (const job of jobs) assert.ok(job.opportunity.publishedAt, `${job.opportunity.title} sin publishedAt`);

  const latam = jobs.find(j => j.opportunity.title.includes('Backend Developer'))!;
  assert.equal(latam.opportunity.remoteness, 'fully_remote');
  // `regions` y `countries` son las restricciones declaradas del puesto. La compuerta de geografía
  // las lee junto a `location`, y reconoce `latam`, así que un remoto de la región PUNTÚA.
  // Región Y país: los dos son restricción declarada, y juntos dicen más que cualquiera solo.
  assert.deepEqual(latam.opportunity.locationRestrictions, ['latam', 'ar']);
  const geo = relevance(latam.opportunity, parseProfile({ remoteOnly: true }), 'employment');
  assert.equal(geo.blockers.includes('remote_region_excluded'), false, 'un remoto LATAM no puede bloquearse');
  assert.match(geo.signals.find(s => s.reason.startsWith('Remoto'))!.reason, /abierto a la región/);

  // La descripción llega en HTML y se guarda como texto, acotada al tope de todos los adaptadores.
  assert.ok(latam.opportunity.description);
  assert.equal(latam.opportunity.description!.includes('<'), false, 'el HTML se convierte a texto');
  assert.ok(latam.opportunity.description!.length <= 20_000);
  // El id viene del `external_id` del proveedor, que es estable; el `public_slug` cambia con el título.
  assert.equal(latam.provenance[0]!.externalId, JSON.parse(await fixture('freehire.json')).data.find((j: { title: string }) => j.title.includes('Backend Developer')).external_id);

  // Y el gate de rol hace su trabajo con lo que el agregador trae de todo: el abogado y el conductor
  // salen `off_target` sin que nadie los filtre a mano.
  const real = parseProfile(JSON.parse(await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8')));
  for (const titulo of ['Attorney', 'Driver']) {
    const job = jobs.find(j => j.opportunity.title.includes(titulo))!;
    assert.equal(relevance(job.opportunity, real, 'employment').tier, 'off_target', `${titulo} debe quedar fuera`);
  }
});

test('--probe-source no exige token a un agregador, que no lo tiene', async () => {
  // El registro fija el endpoint de un agregador y RECHAZA `board`. Exigir un token hacía que
  // `--probe-source freehire x` fallara con `source_endpoint_invalid`, que parece un fallo del
  // proveedor cuando era la herramienta pidiendo un dato que no existe.
  assert.equal(await sourcesMain(['--probe-source', 'freehire', 'x']), 2, 'un agregador con token es un error de argumentos');
  assert.equal(await sourcesMain(['--probe-source', 'ashby']), 2, 'un board ATS sin token también');
  // Y la fuente se construye igual por el registro, así que valida lo mismo que el ciclo.
  const [aggregator] = parseRegistry({ version: 1, sources: [{ id: 'probe', adapter: 'freehire', enabled: true, captureHtml: false }] });
  assert.match(aggregator!.endpoint, /^https:\/\/freehire\.me\/api\/v1\//);
  assert.equal(aggregator!.availabilityTrust, 'ambiguous', 'un agregador no confirma disponibilidad por estar en el feed');
});
