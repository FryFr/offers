import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { ingest, report, identity } from '../src/pipeline.ts';
import { renderDigest } from '../src/digest.ts';
import { parseLedger, recordDelivery, deliveredIds, pruneLedger, emptyLedger } from '../src/delivery-ledger.ts';
import { sourcesMain } from '../src/source-cli.ts';

const now = new Date('2026-09-16T12:00:00.000Z');
const profile = parseProfile({ skills: ['typescript'], relevance: { roleTerms: ['software engineer'], dailyTarget: 3 } });
const evidence = {
  url: 'https://example.com/job', publishedAt: '2026-09-16',
  publicationEvidence: { url: 'https://example.com/job', excerpt: 'Published', observedAt: now.toISOString() },
  availability: { url: 'https://example.com/job', checkedAt: now.toISOString(), outcome: 'open' as const, httpStatus: 200, evidence: 'listing' },
};
const job = (overrides: Partial<Opportunity> = {}): Opportunity => parseOpportunity({
  title: 'Senior Software Engineer', company: 'Acme', skills: ['typescript'], remoteness: 'fully_remote',
  description: 'TypeScript services.', ...evidence,
  url: overrides.url ?? evidence.url,
  ...(overrides.url ? { publicationEvidence: { ...evidence.publicationEvidence, url: overrides.url }, availability: { ...evidence.availability, url: overrides.url } } : {}),
  ...overrides,
});

test('el ledger valida, acumula entregas y conserva la primera fecha', () => {
  assert.deepEqual(parseLedger(undefined), emptyLedger());
  const id = identity(job());
  const first = recordDelivery(emptyLedger(), [id], '2026-09-16T12:00:00.000Z');
  assert.deepEqual(first.entries, [{ id, firstDeliveredAt: '2026-09-16T12:00:00.000Z', deliveries: 1 }]);
  const second = recordDelivery(first, [id, id], '2026-09-17T12:00:00.000Z');
  assert.equal(second.entries[0]?.deliveries, 2);
  assert.equal(second.entries[0]?.firstDeliveredAt, '2026-09-16T12:00:00.000Z', 'cuándo la viste por primera vez no se reescribe');
  assert.ok(deliveredIds(second).has(id));
  assert.deepEqual(parseLedger(second), second, 'ida y vuelta estable');
  // Olvidar entregas viejas permite volver a ofrecer una vacante meses después.
  assert.equal(pruneLedger(second, '2026-09-17T00:00:00.000Z').entries.length, 0);
  for (const invalid of [{ version: 2, entries: [] }, { version: 1, entries: [{ id: 'x', firstDeliveredAt: '2026-09-16T12:00:00.000Z', deliveries: 1 }] },
    { version: 1, entries: [{ id: 'a'.repeat(64), firstDeliveredAt: 'ayer', deliveries: 1 }] },
    { version: 1, entries: [{ id: 'a'.repeat(64), firstDeliveredAt: '2026-09-16T12:00:00.000Z', deliveries: 0 }] }]) {
    assert.throws(() => parseLedger(invalid), /ledger_invalid/);
  }
});

test('lo ya entregado se degrada, no se elimina', () => {
  const offers = Array.from({ length: 5 }, (_, i) => job({ url: `https://example.com/job-${i}` }));
  const state = ingest({ version: 1, records: [] }, offers);
  const first = report(state, profile, now);
  assert.equal(first.recommendations.length, 3, 'dailyTarget del perfil');
  assert.ok(first.recommendations.every(r => !r.repeated));
  // Con dos sin entregar, la siguiente tanda las prioriza y completa con una repetida.
  const delivered = new Set(first.recommendations.map(r => r.id));
  const second = report(state, profile, now, { delivered });
  assert.equal(second.recommendations.length, 3);
  assert.equal(second.recommendations.filter(r => !r.repeated).length, 2, 'las nuevas van primero');
  assert.deepEqual(second.recommendations.slice(0, 2).map(r => r.repeated), [false, false]);
  assert.ok(second.recommendations[2]!.repeated, 'se completa con una repetida en vez de entregar dos');
  assert.match(second.recommendations[2]!.selectionReason, /Repetida/);
  // Con todo entregado, sigue entregando: quedarse en cero sería peor.
  const all = new Set(state.records.map(r => r.id));
  assert.equal(report(state, profile, now, { delivered: all }).recommendations.length, 3);
});

test('el digest es determinista, explica cada oferta y no rellena cuando no hay nada', () => {
  const state = ingest({ version: 1, records: [] }, [job()]);
  const snapshot = report(state, profile, now);
  const markdown = renderDigest(snapshot, { date: '2026-09-16', profile });
  assert.equal(markdown, renderDigest(snapshot, { date: '2026-09-16', profile }), 'misma entrada, mismo archivo');
  assert.match(markdown, /# Ofertas del 2026-09-16/);
  assert.match(markdown, /Senior Software Engineer/);
  assert.match(markdown, /Salario no publicado por la fuente/);
  assert.match(markdown, /Habilidades encontradas:\*\* typescript/);
  assert.match(markdown, /Remoto/);
  assert.match(markdown, /Por qué está aquí/);
  // Cero ofertas se dice, no se disimula rellenando con lo que no encaja.
  const vacio = renderDigest(report({ version: 1, records: [] }, profile, now), { date: '2026-09-16', profile });
  assert.match(vacio, /no hay ninguna oferta que supere el umbral/);
  assert.match(vacio, /ampliar fuentes, no bajar el umbral/);
});

test('el digest declara el pago con su procedencia y avisa cuando no se pudo interpretar', () => {
  const conPago = report(ingest({ version: 1, records: [] }, [job({ compensation: { currency: 'EUR', period: 'year', min: 90_000 }, payDisclosure: 'published' })]), profile, now);
  const markdown = renderDigest(conPago, { date: '2026-09-16', profile });
  assert.match(markdown, /90\.000 EUR\/year/);
  assert.match(markdown, /USD\/mes/, 'la equivalencia mensual se muestra');
  assert.match(markdown, /convertido/, 'y se dice que pasó por la tabla de cambio');
  const sinLeer = report(ingest({ version: 1, records: [] }, [job({ payDisclosure: 'unparsed', payEvidence: { field: 'salary', raw: '$90' } })]), profile, now);
  assert.match(renderDigest(sinLeer, { date: '2026-09-16', profile }), /no se pudo interpretar.*\$90/s);
});

test('--digest entrega, anota la entrega y acumula métricas sin recolectar fuentes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-digest-'));
  try {
    await mkdir(join(root, 'examples')); await mkdir(join(root, 'data'));
    await writeFile(join(root, 'examples/profile.json'), JSON.stringify({ skills: ['typescript'], relevance: { roleTerms: ['software engineer'], dailyTarget: 2 } }));
    // `--digest` usa el reloj real, así que la evidencia debe estar vigente frente a ÉL:
    // con timestamps fijos en el pasado el TTL de 24h la vencería y no habría nada que entregar.
    const fresh = new Date().toISOString();
    const today = fresh.slice(0, 10);
    const store = ingest({ version: 1, records: [] }, Array.from({ length: 4 }, (_, i) => {
      const url = `https://example.com/job-${i}`;
      return parseOpportunity({ title: 'Senior Software Engineer', company: 'Acme', skills: ['typescript'], remoteness: 'fully_remote',
        description: 'TypeScript services.', url, publishedAt: today,
        publicationEvidence: { url, excerpt: 'Published', observedAt: fresh },
        availability: { url, checkedAt: fresh, outcome: 'open', httpStatus: 200, evidence: 'listing' } });
    }));
    await writeFile(join(root, 'data/source-cycle.json'), JSON.stringify({ version: 1, mode: 'dry-run', confirmed: false, generatedAt: new Date().toISOString(), store, counts: { captured: 4 } }));
    assert.equal(await sourcesMain(['--digest'], root), 0);
    assert.equal(await sourcesMain(['--digest'], root), 0);
    assert.match(await readFile(join(root, 'data/digest', `${today}.md`), 'utf8'), /# Ofertas del/);
    const ledger = parseLedger(JSON.parse(await readFile(join(root, 'data/delivered.json'), 'utf8')));
    assert.equal(ledger.entries.length, 4, 'dos cortes de dos entregan las cuatro');
    const metrics = (await readFile(join(root, 'data/metrics.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(metrics.length, 2, 'una línea por corte, append-only');
    assert.equal(metrics[0].deliveredNew, 2);
    assert.equal(metrics[1].deliveredNew, 2, 'el segundo corte trae otras dos, no las mismas');
    assert.equal(metrics[0].captured, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
