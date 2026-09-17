import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { normalize, classify, expiration, evaluate } from '../src/evaluate.ts';
import { identity, ingest, parseStore, report, type Store } from '../src/pipeline.ts';

const profile = parseProfile({ skills: ['TypeScript'], remoteOnly: true });
const now = new Date('2026-09-16T12:00:00Z');
const empty = (): Store => ({ version: 1, records: [] });
const evidence = {
  url: 'https://example.com/job', publishedAt: '2026-09-16',
  publicationEvidence: { url: 'https://example.com/job', excerpt: 'Published 2026-09-16', observedAt: now.toISOString() },
  availability: { url: 'https://example.com/job', checkedAt: now.toISOString(), outcome: 'open' as const, httpStatus: 200, evidence: 'Job details and active application form' },
};
const verifiedOpportunity = (overrides: Partial<Opportunity> = {}) => opportunity({ ...evidence, source: 'test', externalId: overrides.title ?? 'Developer', ...overrides });
const opportunity = (overrides: Partial<Opportunity> = {}): Opportunity => parseOpportunity({ title: 'Developer', company: 'Acme', kind: 'freelance', skills: ['TypeScript'], remote: true, ...overrides });

test('contratos validan fechas, tipos, rangos y perfil', () => {
  assert.deepEqual(profile.skills, ['typescript']);
  for (const value of [null, {}, { title: 4, company: 'Acme' }, { title: 'x', company: 'a', remote: 'yes' }, { title: 'x', company: 'a', expiresAt: '2026-02-30' }, { title: 'x', company: 'a', externalId: '1' }]) assert.throws(() => parseOpportunity(value));
  for (const compensation of [ { currency: 'USD', period: 'hour', min: -1 }, { currency: 'USD', period: 'hour', min: 25, max: 20 }, { currency: 'USD', period: 'project', min: 25, estimatedHours: 0 }, { currency: 'USD', period: 'hour', min: Infinity } ]) assert.throws(() => opportunity({ compensation: compensation as Opportunity['compensation'] }));
  assert.throws(() => parseProfile({ hoursPerMonth: 0 }));
  assert.throws(() => parseProfile({ preferredKinds: ['other'] }));
});
test('normaliza hora, mes y proyecto con rangos y supuestos', () => {
  const hourly = normalize(opportunity({ compensation: { currency: 'usd', period: 'hour', min: 25, max: 40 } }), profile);
  assert.deepEqual(hourly.monthlyUsd, { min: 4000, max: 6400 });
  assert.equal(normalize(opportunity({ compensation: { currency: 'USD', period: 'month', min: 4800, hoursPerMonth: 120 } }), profile).hourlyUsd?.min, 40);
  const project = normalize(opportunity({ compensation: { currency: 'USD', period: 'project', min: 2000, estimatedHours: 100 } }), profile);
  assert.equal(project.hourlyUsd?.min, 20);
  assert.equal(project.monthlyUsd, null);
  assert.equal(project.projectUsd?.min, 2000);
});
test('no inventa tarifas, divisas ni volumen de proyectos', () => {
  for (const compensation of [undefined, { currency: 'COP', period: 'hour' as const, min: 100000 }, { currency: 'USD', period: 'project' as const, min: 3000 }]) {
    const n = normalize(opportunity({ compensation }), profile);
    assert.equal(n.hourlyUsd, null);
    assert.ok(n.assumptions.length);
  }
});
test('clasificación explícita prevalece y ambigüedad requiere revisión', () => {
  assert.equal(classify(opportunity({ title: 'Full-time freelancer' })).kind, 'freelance');
  assert.equal(classify(opportunity({ kind: undefined, title: 'Full-time freelancer' })).kind, 'unknown');
  assert.equal(classify(opportunity({ kind: undefined, title: 'Full-time developer' })).kind, 'employment');
  assert.equal(classify(opportunity({ kind: undefined, title: 'Freelancer' })).kind, 'freelance');
  assert.equal(classify(opportunity({ kind: undefined })).kind, 'unknown');
});
test('vence al terminar la fecha UTC, sin fecha es desconocido', () => {
  const o = opportunity({ expiresAt: '2026-09-16' });
  assert.equal(expiration(o, new Date('2026-09-16T23:59:59.999Z')), 'active');
  assert.equal(expiration(o, new Date('2026-09-17T00:00:00Z')), 'expired');
  assert.equal(expiration(opportunity(), now), 'unknown');
});
test('scores son separados, acotados y explicables por suma de contribuciones', () => {
  const o = opportunity({ compensation: { currency: 'USD', period: 'hour', min: 25 } });
  const first = evaluate(o, profile, now);
  const higher = evaluate({ ...o, compensation: { currency: 'USD', period: 'hour', min: 50 } }, { ...profile, targetHourlyUsd: 50 }, now);
  assert.equal(first.scores.fit.value, 100);
  assert.equal(first.scores.fit.value, higher.scores.fit.value);
  const mismatch = evaluate({ ...o, skills: [], remote: false }, profile, now);
  assert.equal(first.scores.economic.value, mismatch.scores.economic.value);
  for (const s of Object.values(first.scores)) {
    assert.equal(s.value, s.reasons.reduce((n, r) => n + r.points, 0));
    assert.ok(s.value >= 0 && s.value <= 100);
  }
});
test('cada excepción freelance permite revisión bajo USD 25/h sin rechazo automático', () => {
  const base = opportunity({ compensation: { currency: 'USD', period: 'hour', min: 20 } });
  assert.equal(evaluate(base, profile, now).freelanceReview.status, 'below_floor');
  for (const o of [{ ...base, recurring: true }, { ...base, growthPotential: true }, opportunity({ compensation: { currency: 'USD', period: 'project', min: 2000, estimatedHours: 100 } })]) assert.equal(evaluate(o, profile, now).freelanceReview.status, 'flexible_review');
  assert.equal(evaluate({ ...base, kind: 'employment', recurring: true }, profile, now).freelanceReview.status, 'not_applicable');
  assert.equal(evaluate(opportunity({ compensation: { currency: 'USD', period: 'hour', min: 25 } }), profile, now).freelanceReview.status, 'meets_floor');
  assert.equal(evaluate(opportunity({ compensation: { currency: 'USD', period: 'project', min: 4000 } }), profile, now).freelanceReview.status, 'needs_information');
  assert.equal(evaluate({ ...base, kind: 'unknown' }, profile, now).freelanceReview.status, 'needs_classification');
});
test('identidades estables con source/id, URL limpia o título/empresa', () => {
  assert.equal(identity(opportunity({ source: 'Board', externalId: '123' })), identity(opportunity({ source: 'board', externalId: '123', title: 'Changed' })));
  assert.equal(identity(opportunity({ url: 'https://example.com/jobs/1/?utm_source=email#top' })), identity(opportunity({ url: 'https://example.com/jobs/1' })));
  assert.equal(identity(opportunity()), identity(opportunity({ title: '  DEVELOPER ', company: 'ACME' })));
  assert.notEqual(identity(opportunity({ url: 'https://example.com/job?id=1' })), identity(opportunity({ url: 'https://example.com/job?id=2' })));
});
test('ingesta idempotente, reemplazo completo y validación transaccional del lote', () => {
  const o = opportunity();
  const once = ingest(empty(), [o, o]);
  assert.equal(once.records.length, 1);
  assert.deepEqual(ingest(once, o), once);
  assert.equal(ingest(once, { ...o, recurring: true }).records[0]?.opportunity.recurring, true);
  assert.throws(() => ingest(once, [o, {}]));
  assert.deepEqual(parseStore(once), once);
  assert.throws(() => parseStore({ ...once, records: [...once.records, ...once.records] }));
});
test('reporte determinista conserva vencidas y prepara clave para Notion', () => {
  const state = ingest(empty(), opportunity({ expiresAt: '2020-01-01' }));
  const result = report(state, profile, now);
  assert.deepEqual(report(state, profile, now), result);
  assert.equal(result.records[0]?.evaluation.expiration, 'expired');
  assert.equal(result.notion.records[0]?.externalKey, state.records[0]?.id);
  assert.equal(result.notion.records[0]?.properties['Hourly USD'].number, null);
});
test('CLI: JSON, stdin, persistencia, errores y segunda ejecución idempotente', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-test-'));
  try {
    const state = join(dir, 'state.json');
    const output = join(dir, 'output.json');
    const run = (input: string, extras: string[] = []) => spawnSync(process.execPath, ['src/cli.ts', '--input', '-', '--state', state, '--output', output, '--now', now.toISOString(), ...extras], { input, encoding: 'utf8' });
    assert.equal(run(JSON.stringify(opportunity())).status, 0);
    const firstState = await readFile(state, 'utf8');
    const firstOutput = await readFile(output, 'utf8');
    assert.equal(run(JSON.stringify(opportunity())).status, 0);
    assert.equal(await readFile(state, 'utf8'), firstState);
    assert.equal(await readFile(output, 'utf8'), firstOutput);
    assert.equal(run('[{}]').status, 1);
    assert.equal(await readFile(state, 'utf8'), firstState);
    assert.equal(run('{}', ['--wat', 'x']).status, 1);
    assert.equal(run('{}', ['--profile', state]).status, 1);
    await writeFile(state, '{broken');
    assert.equal(run(JSON.stringify(opportunity())).status, 1);
    assert.equal(await readFile(state, 'utf8'), '{broken');
    const fileRun = spawnSync(process.execPath, ['src/cli.ts', '--input', 'examples/opportunities.json', '--profile', 'examples/profile.json', '--state', join(dir, 'fresh.json')], { encoding: 'utf8' });
    assert.equal(fileRun.status, 0, fileRun.stderr);
    assert.equal(JSON.parse(fileRun.stdout).records.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('screening: defaults compatibles y validación de reglas y ubicación', () => {
  const p = parseProfile({});
  assert.equal(p.employmentMinimumMonthlyUsd, 3000);
  assert.equal(p.employmentTargetMonthlyUsd, 4500);
  assert.equal(p.relocationThresholdMonthlyUsd, 6000);
  assert.equal(parseProfile({ employmentMinimumMonthlyUsd: 2500 }).employmentMinimumMonthlyUsd, 2500);
  for (const value of [{ employmentMinimumMonthlyUsd: 0 }, { employmentTargetMonthlyUsd: 2000 }, { relocationThresholdMonthlyUsd: Infinity }, { excludedTerms: [''] }, { excludedIndustries: 'mining' }]) assert.throws(() => parseProfile(value));
  for (const value of [{ relocationRequired: 'yes' }, { location: '' }, { industry: 5 }]) assert.throws(() => parseOpportunity({ title: 'x', company: 'a', ...value }));
  assert.equal(opportunity({ location: ' Bogotá ', relocationRequired: false }).location, 'Bogotá');
});

test('descarte automático conserva registros y explica términos; exclusiones configurables', () => {
  for (const description of ['BOMBAS para MINERÍA', 'Mining slurry pumps', 'Bombas de uso minero']) {
    const result = report(ingest(empty(), opportunity({ description })), profile, now);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.evaluation.screening.status, 'discarded');
    assert.match(result.records[0]!.evaluation.screening.reasons.join(' '), /términos/);
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.notion.records[0]?.properties.Screening.select.name, 'discarded');
    assert.equal(result.notion.records[0]?.properties['Recommendation rank'].number, null);
  }
  assert.equal(evaluate(opportunity({ title: 'Heat pumps developer' }), profile, now).screening.status, 'retained');
  assert.equal(evaluate(opportunity({ title: 'Mining analytics' }), profile, now).screening.status, 'retained');
  const p = parseProfile({ excludedTerms: ['VENTA DIRECTA'], excludedIndustries: ['tabaco'] });
  for (const o of [opportunity({ description: 'Venta directa' }), opportunity({ industry: 'Tabaco' })]) assert.equal(evaluate(o, p, now).screening.status, 'discarded');
  assert.equal(evaluate(opportunity({ description: 'contacto' }), parseProfile({ excludedTerms: ['acto'] }), now).screening.status, 'retained');
});

test('empleo: límites inclusivos, objetivo, relocalización estricta y rangos inciertos', () => {
  const employment = (min: number, relocationRequired: boolean | undefined = false, max = min) => evaluate(opportunity({ kind: 'employment', relocationRequired, compensation: { currency: 'USD', period: 'month', min, max } }), profile, now).screening.employment;
  assert.equal(employment(2999).status, 'ineligible');
  assert.equal(employment(3000).status, 'eligible');
  assert.equal(employment(4500).target.status, 'eligible');
  assert.equal(employment(4499).target.status, 'ineligible');
  assert.equal(employment(6000, true).status, 'ineligible');
  assert.equal(employment(6001, true).status, 'eligible');
  assert.equal(employment(6000, true, 7000).status, 'unknown');
  assert.equal(employment(2500, false, 3500).status, 'unknown');
  assert.equal(evaluate(opportunity({ kind: 'employment', compensation: { currency: 'USD', period: 'month', min: 7000 } }), profile, now).screening.employment.status, 'unknown');
});

test('empleo: información ausente, otras divisas y proyecciones no inventan elegibilidad', () => {
  for (const compensation of [undefined, { currency: 'COP', period: 'month' as const, min: 9000000 }, { currency: 'USD', period: 'hour' as const, min: 50 }, { currency: 'USD', period: 'project' as const, min: 9000 }]) {
    assert.equal(evaluate(opportunity({ kind: 'employment', relocationRequired: false, compensation }), profile, now).screening.employment.status, 'unknown');
  }
  assert.equal(evaluate(opportunity({ kind: 'employment', relocationRequired: false, compensation: { currency: 'USD', period: 'hour', min: 30, hoursPerMonth: 100 } }), profile, now).screening.employment.status, 'eligible');
  assert.equal(evaluate(opportunity(), profile, now).screening.employment.status, 'not_applicable');
  assert.equal(evaluate(opportunity({ kind: 'unknown' }), profile, now).screening.employment.status, 'unknown');
});

test('recomendaciones: máximo 20, balance, orden explicable y desempate determinista', () => {
  const offers = Array.from({ length: 40 }, (_, i) => verifiedOpportunity({ title: `Job ${i}`, kind: i < 30 ? 'employment' : 'freelance', relocationRequired: false, compensation: { currency: 'USD', period: 'month', min: i < 30 ? 7000 : 2000 } }));
  const state = ingest(empty(), offers);
  const result = report(state, profile, now);
  assert.equal(result.recommendations.length, 20);
  assert.equal(result.recommendations.filter(r => r.kind === 'freelance').length, 5);
  assert.deepEqual(report({ ...state, records: [...state.records].reverse() }, profile, now).recommendations, result.recommendations);
  result.recommendations.forEach((r, i) => {
    assert.equal(r.rank, i + 1);
    assert.equal(r.priority, r.reasons.reduce((sum, reason) => sum + reason.points, 0));
    if (i) assert.ok(result.recommendations[i - 1]!.priority >= r.priority);
    assert.equal(result.notion.records.find(n => n.externalKey === r.id)?.properties['Recommendation rank'].number, r.rank);
  });
  assert.deepEqual(result.notion.recommendations, result.recommendations);
  assert.equal(report(ingest(empty(), offers.slice(0, 30)), profile, now).recommendations.length, 20);
  assert.equal(report(empty(), profile, now).recommendations.length, 0);
});

test('recomendaciones excluyen vencidas e inelegibles; conservan unknown para investigar', () => {
  const result = report(ingest(empty(), [verifiedOpportunity({ title: 'Expired', expiresAt: '2026-09-15' }), verifiedOpportunity({ title: 'Low salary', kind: 'employment', compensation: { currency: 'USD', period: 'month', min: 2000 } }), verifiedOpportunity({ title: 'Unknown salary', kind: 'employment' }), verifiedOpportunity({ title: 'Today', expiresAt: '2026-09-16' })]), profile, now);
  assert.equal(result.records.length, 4);
  assert.deepEqual(result.recommendations.map(r => result.records.find(record => record.id === r.id)!.opportunity.title).sort(), ['Today', 'Unknown salary']);
});

test('reevalúa reglas configuradas y selección diaria sin alterar el estado fuente', () => {
  const state = ingest(empty(), verifiedOpportunity({ kind: 'employment', relocationRequired: false, compensation: { currency: 'USD', period: 'month', min: 2700 }, expiresAt: '2026-09-16' }));
  const before = JSON.stringify(state);
  assert.equal(report(state, profile, now).recommendations.length, 0);
  const custom = parseProfile({ employmentMinimumMonthlyUsd: 2500, employmentTargetMonthlyUsd: 2700, relocationThresholdMonthlyUsd: 2600 });
  const result = report(state, custom, now);
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.records[0]?.evaluation.screening.employment.target.status, 'eligible');
  assert.equal(evaluate({ ...state.records[0]!.opportunity, relocationRequired: true }, custom, now).screening.employment.status, 'eligible');
  assert.equal(report(state, custom, new Date('2026-09-17T00:00:00Z')).recommendations.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test('verificación: hoy y 1–3 días inclusivos; >3 stale y prioridad de hoy sobre scores', () => {
  for (const [day, expected] of [[16, 'verified'], [15, 'verified'], [14, 'verified'], [13, 'verified'], [12, 'stale']] as const) {
    const o = verifiedOpportunity({ publishedAt: `2026-09-${day}` });
    const v = evaluate(o, profile, now).verification;
    assert.equal(v.status, expected);
    assert.equal(v.ageDays, 16 - day);
    assert.equal(v.sameDay, day === 16);
    assert.equal(report(ingest(empty(), o), profile, now).recommendations.length, expected === 'verified' ? 1 : 0);
  }
  const today = verifiedOpportunity({ title: 'Today', skills: [] });
  const older = verifiedOpportunity({ title: 'Yesterday', publishedAt: '2026-09-15', compensation: { currency: 'USD', period: 'hour', min: 100 } });
  const result = report(ingest(empty(), [older, today]), profile, now);
  assert.equal(result.recommendations[0]?.id, identity(today));
  assert.ok(result.recommendations[0]!.priority < result.recommendations[1]!.priority);
  const boundary = verifiedOpportunity({ publishedAt: '2026-09-13', availability: { ...evidence.availability, checkedAt: '2026-09-16T23:00:00Z' } });
  assert.equal(evaluate(boundary, profile, new Date('2026-09-16T23:59:59.999Z')).verification.status, 'verified');
  assert.equal(evaluate(boundary, profile, new Date('2026-09-17T00:00:00Z')).verification.status, 'stale');
});

test('prioridad de hoy también controla la selección antes de reservar plazas por tipo', () => {
  const today = Array.from({ length: 20 }, (_, i) => verifiedOpportunity({ title: `Today ${i}`, kind: 'unknown' }));
  const old = Array.from({ length: 10 }, (_, i) => verifiedOpportunity({ title: `Old ${i}`, publishedAt: '2026-09-15', kind: 'employment' }));
  const result = report(ingest(empty(), [...old, ...today]), profile, now);
  assert.equal(result.recommendations.length, 20);
  assert.ok(result.recommendations.every(r => r.sameDay));
});

test('verificación: ausencias, fechas futuras, evidencia ajena y vencimiento bloquean recomendaciones', () => {
  for (const overrides of [
    { publishedAt: undefined }, { publicationEvidence: undefined }, { availability: undefined },
    { publishedAt: '2026-09-17' },
    { publicationEvidence: { ...evidence.publicationEvidence, url: 'https://example.com/other' } },
    { availability: { ...evidence.availability, checkedAt: '2026-09-16T12:00:01Z' } },
    { availability: { ...evidence.availability, checkedAt: '2026-09-15T12:00:00Z' } },
    { availability: { ...evidence.availability, url: 'https://example.com/other' } },
  ]) {
    const result = report(ingest(empty(), verifiedOpportunity(overrides)), profile, now);
    assert.equal(result.records[0]?.evaluation.verification.status, 'unknown');
    assert.ok(result.records[0]!.evaluation.verification.reasons.length);
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.notion.records[0]?.properties['Recommendation rank'].number, null);
  }
  const o = verifiedOpportunity({ publishedAt: '2026-09-15', availability: { ...evidence.availability, checkedAt: '2026-09-15T12:00:00.001Z' } });
  assert.equal(evaluate(o, profile, now).verification.status, 'verified');
});

test('disponibilidad: 404/410, fuente desaparecida, ficha cerrada, 200 ambiguo y timeout', () => {
  for (const [availability, expected, reason] of [
    [{ ...evidence.availability, httpStatus: 404 }, 'unavailable', 'source_http_404'],
    [{ ...evidence.availability, httpStatus: 410 }, 'unavailable', 'source_http_410'],
    [{ ...evidence.availability, outcome: 'missing' }, 'unavailable', 'source_missing'],
    [{ ...evidence.availability, outcome: 'closed' }, 'unavailable', 'listing_closed'],
    [{ ...evidence.availability, outcome: 'ambiguous' }, 'unknown', 'availability_ambiguous'],
    [{ ...evidence.availability, evidence: undefined }, 'unknown', 'availability_not_confirmed'],
    [{ ...evidence.availability, outcome: 'timeout' }, 'unknown', 'availability_timeout'],
  ] as const) {
    const result = report(ingest(empty(), verifiedOpportunity({ availability })), profile, now);
    assert.equal(result.records[0]?.evaluation.verification.status, expected);
    assert.ok(result.records[0]?.evaluation.verification.reasons.includes(reason));
    assert.equal(result.recommendations.length, 0);
  }
});

test('contratos de evidencia: rechazan fechas imposibles, timestamps sin UTC y resultados inválidos', () => {
  for (const overrides of [
    { publishedAt: '2026-02-30' }, { publishedAt: '2026-09-16T12:00:00Z' },
    { publicationEvidence: { ...evidence.publicationEvidence, excerpt: '' } },
    { publicationEvidence: { ...evidence.publicationEvidence, observedAt: '2026-09-16' } },
    { availability: { ...evidence.availability, outcome: 'verified' } },
    { availability: { ...evidence.availability, httpStatus: 200.5 } },
    { availability: { ...evidence.availability, checkedAt: '2026-02-30T12:00:00Z' } },
  ]) assert.throws(() => parseOpportunity({ title: 'Job', company: 'Test', ...overrides }));
});

test('migración conserva ejemplos históricos unknown; reingesta guarda evidencia y causas previas', async () => {
  for (const file of ['examples/opportunities.json', 'examples/real-web-capture-2026-09-16.json']) {
    const state = ingest(empty(), JSON.parse(await readFile(file, 'utf8')));
    const result = report(parseStore(state), profile, now);
    assert.ok(result.records.every(r => r.evaluation.verification.status === 'unknown'));
    assert.equal(result.recommendations.length, 0);
  }
  const original = verifiedOpportunity();
  const closed = { ...original, availability: { ...evidence.availability, outcome: 'closed' as const } };
  const state = ingest(ingest(ingest(empty(), original), closed), original);
  assert.deepEqual(state.records[0]?.history, [original, closed]);
  assert.deepEqual(parseStore(state), state);
  assert.deepEqual(ingest(state, original), state);
  const result = report(state, profile, now);
  assert.ok(result.records[0]?.historicalEvaluations[1]?.evaluation.verification.reasons.includes('listing_closed'));
  assert.deepEqual(result.records[0]?.historicalEvaluations[0]?.opportunity.availability, evidence.availability);
});
