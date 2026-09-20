import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { normalize, classify, expiration, evaluate, verification, PUBLICATION_WINDOW_DAYS } from '../src/evaluate.ts';
import { identity, ingest, parseStore, report, MAX_HISTORY, type Store } from '../src/pipeline.ts';
import { FX, FX_MAX_AGE_DAYS, toUsd } from '../src/fx.ts';

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
test('no inventa tarifas ni volumen de proyectos; convierte solo con tasa declarada', () => {
  // Sin compensación, con moneda fuera de la tabla, o proyecto sin horas: no se deriva tarifa.
  for (const compensation of [undefined, { currency: 'KRW', period: 'hour' as const, min: 100000 }, { currency: 'USD', period: 'project' as const, min: 3000 }]) {
    const n = normalize(opportunity({ compensation }), profile);
    assert.equal(n.hourlyUsd, null);
    assert.ok(n.assumptions.length);
  }
  // Una moneda cubierta SÍ se convierte, y la cifra arrastra la tasa y su fecha para que nadie
  // la confunda con un dato del proveedor. Bloquearlas sería un falso negativo enorme en Europa.
  const eur = normalize(opportunity({ compensation: { currency: 'EUR', period: 'year', min: 90000 } }), profile);
  assert.ok(eur.monthlyUsd!.min > 8000 && eur.monthlyUsd!.min < 8200, `esperaba ~8.100 USD/mes, obtuve ${eur.monthlyUsd!.min}`);
  assert.ok(eur.assumptions.some(a => a.includes('EUR') && a.includes(FX.asOf) && a.includes('no es cotización')));
  const local = normalize(opportunity({ compensation: { currency: 'COP', period: 'month', min: 9_000_000 } }), profile);
  assert.ok(local.monthlyUsd!.min < 3000, 'un salario local convertido debe quedar por debajo del umbral, no fuera de la evaluación');
});

test('la tabla de cambio es estática, versionada y falla cuando envejece', () => {
  const ageDays = (Date.now() - Date.parse(FX.asOf)) / 86_400_000;
  assert.ok(ageDays >= 0, 'la tabla no puede tener fecha futura');
  assert.ok(ageDays <= FX_MAX_AGE_DAYS, `la tabla tiene ${Math.round(ageDays)} días: refrescar src/fx.ts a mano`);
  assert.equal(FX.rates.USD, 1);
  assert.equal(toUsd(100, 'KRW'), null, 'una moneda sin tasa no se estima');
  assert.equal(toUsd(100, 'usd')?.converted, false, 'USD no se marca como convertido');
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

test('empleo: información ausente, divisas sin tasa y proyecciones no inventan elegibilidad', () => {
  // Una tarifa horaria sin horas declaradas NO habilita el gate: las horas del perfil sirven
  // para proyectar, no son evidencia de volumen pagado.
  for (const compensation of [undefined, { currency: 'KRW', period: 'month' as const, min: 9000000 }, { currency: 'USD', period: 'hour' as const, min: 50 }, { currency: 'USD', period: 'project' as const, min: 9000 }]) {
    assert.equal(evaluate(opportunity({ kind: 'employment', relocationRequired: false, compensation }), profile, now).screening.employment.status, 'unknown');
  }
  // Pero sí alimenta la señal orientativa, que ordena sin decidir.
  const proyectada = evaluate(opportunity({ kind: 'employment', relocationRequired: false, compensation: { currency: 'USD', period: 'hour', min: 50 } }), profile, now).screening;
  assert.equal(proyectada.employment.salary.status, 'unknown');
  assert.equal(proyectada.indicative.status, 'meets');
  assert.ok(proyectada.indicative.reason.includes('proyectado con horas del perfil'));
  // Una moneda con tasa sí se evalúa: un salario local queda por debajo del umbral, no fuera.
  assert.equal(evaluate(opportunity({ kind: 'employment', relocationRequired: false, compensation: { currency: 'COP', period: 'month', min: 9_000_000 } }), profile, now).screening.employment.status, 'ineligible');
  assert.equal(evaluate(opportunity({ kind: 'employment' }), profile, now).screening.payDisclosure, 'not_published');
  assert.equal(evaluate(opportunity({ kind: 'employment', relocationRequired: false, compensation: { currency: 'USD', period: 'hour', min: 30, hoursPerMonth: 100 } }), profile, now).screening.employment.status, 'eligible');
  assert.equal(evaluate(opportunity(), profile, now).screening.employment.status, 'not_applicable');
  assert.equal(evaluate(opportunity({ kind: 'unknown' }), profile, now).screening.employment.status, 'unknown');
});

test('recomendaciones: tope configurable, balance, orden explicable y desempate determinista', () => {
  const offers = Array.from({ length: 40 }, (_, i) => verifiedOpportunity({ title: `Job ${i}`, kind: i < 30 ? 'employment' : 'freelance', relocationRequired: false, compensation: { currency: 'USD', period: 'month', min: i < 30 ? 7000 : 2000 } }));
  const state = ingest(empty(), offers);
  const result = report(state, profile, now);
  // El tope lo fija el perfil, no una constante: un corte diario es una preferencia, no una regla.
  assert.equal(result.recommendations.length, profile.relevance.dailyTarget);
  assert.equal(result.recommendations.filter(r => r.kind === 'freelance').length, 5, 'la reserva por tipo protege freelance del volumen de empleo');
  const wider = report(state, parseProfile({ skills: ['TypeScript'], remoteOnly: true, relevance: { dailyTarget: 25 } }), now);
  assert.equal(wider.recommendations.length, 25);
  assert.deepEqual(report({ ...state, records: [...state.records].reverse() }, profile, now).recommendations, result.recommendations);
  result.recommendations.forEach((r, i) => {
    assert.equal(r.rank, i + 1);
    assert.equal(r.priority, r.reasons.reduce((sum, reason) => sum + reason.points, 0));
    if (i) assert.ok(result.recommendations[i - 1]!.priority >= r.priority);
    assert.equal(result.notion.records.find(n => n.externalKey === r.id)?.properties['Recommendation rank'].number, r.rank);
  });
  assert.deepEqual(result.notion.recommendations, result.recommendations);
  assert.equal(report(ingest(empty(), offers.slice(0, 30)), profile, now).recommendations.length, profile.relevance.dailyTarget);
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

test('verificación: ventana de 7 días inclusiva; >7 stale y prioridad de hoy sobre scores', () => {
  assert.equal(PUBLICATION_WINDOW_DAYS, 7);
  for (const [day, expected] of [[16, 'verified'], [13, 'verified'], [10, 'verified'], [9, 'verified'], [8, 'stale']] as const) {
    const o = verifiedOpportunity({ publishedAt: `2026-09-${String(day).padStart(2, '0')}` });
    const v = evaluate(o, profile, now).verification;
    assert.equal(v.status, expected);
    assert.equal(v.ageDays, 16 - day);
    assert.equal(v.sameDay, day === 16);
    assert.equal(v.windowDays, PUBLICATION_WINDOW_DAYS);
    assert.equal(report(ingest(empty(), o), profile, now).recommendations.length, expected === 'verified' ? 1 : 0);
  }
  // La ventana es un parámetro, no una constante incrustada en la lógica.
  const eightDays = verifiedOpportunity({ publishedAt: '2026-09-08' });
  assert.equal(verification(eightDays, now, 8).status, 'verified');
  assert.equal(verification(eightDays, now, 3).reasons.includes('publication_older_than_window_3d'), true);
  for (const invalid of [-1, 1.5, Number.NaN]) assert.throws(() => verification(eightDays, now, invalid));
  // validUntil se corta al primer límite: TTL de 24h, fin de la ventana, o deadline.
  const ttlBound = verifiedOpportunity({ publishedAt: '2026-09-16', availability: { ...evidence.availability, checkedAt: '2026-09-16T00:00:00Z' } });
  assert.equal(verification(ttlBound, now).validUntil, '2026-09-17T00:00:00.000Z');
  const windowBound = verifiedOpportunity({ publishedAt: '2026-09-09' });
  assert.equal(verification(windowBound, now, 3).validUntil, '2026-09-13T00:00:00.000Z');
  // La recencia inclina, no decide: una oferta de ayer claramente mejor gana a una de hoy floja.
  // Con la ventana de 7 días, lo contrario hundiría coincidencias perfectas bajo ruido fresco.
  const today = verifiedOpportunity({ title: 'Today', skills: [] });
  const older = verifiedOpportunity({ title: 'Yesterday', publishedAt: '2026-09-15', compensation: { currency: 'USD', period: 'hour', min: 100 } });
  const result = report(ingest(empty(), [older, today]), profile, now);
  assert.equal(result.recommendations[0]?.id, identity(older));
  assert.ok(result.recommendations[0]!.priority > result.recommendations[1]!.priority);
  // El bono de recencia existe, está acotado y decae con la antigüedad.
  const bonus = (r: typeof result.recommendations[number]) => r.reasons.find(x => x.reason.startsWith('Recencia'))!.points;
  assert.equal(bonus(result.recommendations.find(r => r.id === identity(today))!), 12);
  assert.equal(bonus(result.recommendations.find(r => r.id === identity(older))!), 10);
  const boundary = verifiedOpportunity({ publishedAt: '2026-09-09', availability: { ...evidence.availability, checkedAt: '2026-09-16T23:00:00Z' } });
  assert.equal(evaluate(boundary, profile, new Date('2026-09-16T23:59:59.999Z')).verification.status, 'verified');
  assert.equal(evaluate(boundary, profile, new Date('2026-09-17T00:00:00Z')).verification.status, 'stale');
});

test('la reserva por tipo sobrevive al volumen y el tipo desconocido compite en las plazas restantes', () => {
  const unknownKind = Array.from({ length: 20 }, (_, i) => verifiedOpportunity({ title: `Unknown ${i}`, kind: 'unknown' }));
  const freelance = Array.from({ length: 2 }, (_, i) => verifiedOpportunity({ title: `Freelance ${i}`, kind: 'freelance' }));
  const result = report(ingest(empty(), [...unknownKind, ...freelance]), profile, now);
  assert.equal(result.recommendations.length, profile.relevance.dailyTarget);
  // Dos freelance entre veintidós candidatas: sin reserva se perderían bajo el volumen.
  assert.equal(result.recommendations.filter(r => r.kind === 'freelance').length, 2);
  assert.ok(result.recommendations.some(r => r.kind === 'unknown'), 'el tipo desconocido compite, no se excluye');
  assert.ok(result.recommendations.every(r => r.tier !== 'off_target'));
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

test('una re-comprobación que solo mueve timestamps actualiza la oferta sin generar revisión', () => {
  const original = verifiedOpportunity();
  // Mismo outcome, mismo httpStatus, misma evidencia: solo avanzaron los sellos de re-comprobación.
  const rechecked = { ...original, availability: { ...evidence.availability, checkedAt: '2026-09-16T18:00:00Z' },
    publicationEvidence: { ...evidence.publicationEvidence, observedAt: '2026-09-16T18:00:00Z' } };
  const state = ingest(ingest(empty(), original), rechecked);
  assert.equal(state.records[0]?.opportunity.availability?.checkedAt, '2026-09-16T18:00:00Z', 'el TTL necesita el sello fresco');
  assert.equal(state.records[0]?.history, undefined, 'una re-comprobación no es una revisión');
  // Un cambio real sí se registra, y arrastra la versión vigente aunque venga de una re-comprobación.
  const closed = { ...rechecked, availability: { ...rechecked.availability, outcome: 'closed' as const } };
  const changed = ingest(state, closed);
  assert.deepEqual(changed.records[0]?.history, [rechecked]);
  assert.deepEqual(parseStore(changed), changed);
});

test(`el historial por registro se acota a ${MAX_HISTORY} revisiones y conserva las más recientes`, () => {
  const revisions = Array.from({ length: 8 }, (_, i) => verifiedOpportunity({ location: `Rev ${i}` }));
  const state = revisions.reduce(ingest, empty());
  const record = state.records[0]!;
  assert.equal(state.records.length, 1, 'todas las revisiones comparten identidad');
  assert.equal(record.opportunity.location, 'Rev 7');
  assert.equal(record.history?.length, MAX_HISTORY);
  // Se descartan las más antiguas (Rev 0 y Rev 1), nunca las recientes.
  assert.deepEqual(record.history?.map(o => o.location), ['Rev 2', 'Rev 3', 'Rev 4', 'Rev 5', 'Rev 6']);
  assert.deepEqual(parseStore(state), state);
});

test('la razón de ventana lleva el número y la cadena de 3 días ya no existe', () => {
  const stale = verifiedOpportunity({ publishedAt: '2026-09-01' });
  const reasons = verification(stale, now).reasons;
  assert.ok(reasons.includes(`publication_older_than_window_${PUBLICATION_WINDOW_DAYS}d`));
  const everything = JSON.stringify(report(ingest(empty(), stale), profile, now));
  assert.equal(everything.includes('publication_older_than_3_days'), false);
});
