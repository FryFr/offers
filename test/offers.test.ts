import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { normalize, classify, expiration, evaluate, verification, PUBLICATION_WINDOW_DAYS } from '../src/evaluate.ts';
import { compactHistory, identity, ingest, parseStore, pruneStore, report, MAX_HISTORY, STORE_GRACE_DAYS, NOTION_RICH_TEXT_LIMIT, type Store } from '../src/pipeline.ts';
import { FX, FX_MAX_AGE_DAYS, toUsd } from '../src/fx.ts';

// El perfil de las pruebas DECLARA el rol que busca. Antes no lo hacía y sus ofertas entraban al
// corte igual, porque el componente de habilidades saturaba y las empujaba justo por encima de 40.
// Eso ataba pruebas de recomendación —topes, reservas, recencia— a un margen de tres puntos en un
// componente que no estaban probando: separar núcleo de secundarias las tumbó todas de golpe.
const profile = parseProfile({ skills: ['TypeScript'], remoteOnly: true, relevance: { roleTerms: ['developer', 'software engineer'] } });
const now = new Date('2026-09-16T12:00:00Z');
const empty = (): Store => ({ version: 1, records: [] });
const evidence = {
  url: 'https://example.com/job', publishedAt: '2026-09-16',
  publicationEvidence: { url: 'https://example.com/job', excerpt: 'Published 2026-09-16', observedAt: now.toISOString() },
  availability: { url: 'https://example.com/job', checkedAt: now.toISOString(), outcome: 'open' as const, httpStatus: 200, evidence: 'Job details and active application form' },
};
const verifiedOpportunity = (overrides: Partial<Opportunity> = {}) => opportunity({ ...evidence, source: 'test', externalId: overrides.title ?? 'Developer', ...overrides });
// La descripción por defecto existe para que las pruebas que cambian el TÍTULO (`Today`, `Expired`,
// `Job 0`…) sigan siendo ofertas relevantes: el título ahí identifica el caso, no describe el puesto.
const opportunity = (overrides: Partial<Opportunity> = {}): Opportunity => parseOpportunity({ title: 'Developer', company: 'Acme', kind: 'freelance', skills: ['TypeScript'], remote: true, description: 'We are hiring a remote developer, a software engineer, to build TypeScript services.', ...overrides });

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
  const wider = report(state, parseProfile({ skills: ['TypeScript'], remoteOnly: true, relevance: { roleTerms: ['developer', 'software engineer'], dailyTarget: 25 } }), now);
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
  // roleTerms hace que la oferta sea relevante: el corte diario solo admite strong/possible.
  const custom = parseProfile({ employmentMinimumMonthlyUsd: 2500, employmentTargetMonthlyUsd: 2700, relocationThresholdMonthlyUsd: 2600, relevance: { roleTerms: ['developer'] } });
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
  const today = verifiedOpportunity({ title: 'Today' });
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

test('la familia de rol que menos puntúa conserva sus plazas aunque las reservas no quepan', () => {
  // Buscar tres perfiles a la vez solo es honesto si el que publica menos volumen —o peor
  // pagado— no desaparece del corte. Aquí management no declara salario, así que pierde los 50
  // puntos de elegibilidad y objetivo frente a IA y robótica: sin reserva por familia caería
  // entero, y la decisión de las dos semanas ("qué familia produjo entrevistas") sería
  // incontestable porque una de las tres nunca se habría entregado.
  const tresFamilias = parseProfile({
    skills: ['TypeScript'], remoteOnly: true,
    relevance: {
      dailyTarget: 9,
      roleTerms: { ai: ['ai engineer'], robotics: ['robotics engineer'], management: ['engineering manager'] },
    },
  });
  const pagadas = (role: string) => Array.from({ length: 20 }, (_, i) => verifiedOpportunity({
    title: `${role} ${i}`, kind: 'employment', relocationRequired: false,
    compensation: { currency: 'USD', period: 'month', min: 7000 },
  }));
  const sinSalario = Array.from({ length: 3 }, (_, i) => verifiedOpportunity({ title: `Engineering Manager ${i}`, kind: 'employment', relocationRequired: false }));
  const result = report(ingest(empty(), [...pagadas('AI Engineer'), ...pagadas('Robotics Engineer'), ...sinSalario]), tresFamilias, now);
  const porFamilia = (family: string) => result.recommendations.filter(r => r.roleFamily === family);

  assert.equal(result.recommendations.length, 9);
  // La premisa: management puntúa por debajo de TODAS las demás. Si esto dejara de ser cierto,
  // la prueba pasaría sin demostrar nada.
  const peorDeLasOtras = Math.min(...result.recommendations.filter(r => r.roleFamily !== 'management').map(r => r.priority));
  assert.ok(porFamilia('management').every(r => r.priority < peorDeLasOtras), 'management debe ser la familia peor puntuada');
  for (const family of ['ai', 'robotics', 'management']) assert.ok(porFamilia(family).length >= 2, `la familia ${family} se quedó sin plazas`);
  assert.match(porFamilia('management')[0]!.selectionReason, /familia de rol management/);
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
  // La descripción NO se repite en el historial cuando no cambió: una entrada sin `description`
  // significa "el mismo texto que la revisión siguiente". Todo lo demás se archiva literal.
  const archived = ({ description: _unchanged, ...rest }: Opportunity) => rest;
  assert.deepEqual(state.records[0]?.history, [archived(original), archived(closed)]);
  assert.equal(state.records[0]!.opportunity.description, original.description, 'la revisión vigente sí la conserva');
  assert.deepEqual(parseStore(state), state);
  assert.deepEqual(ingest(state, original), state);
  // El historial conserva cada revisión tal como se observó, y sigue siendo evaluable a demanda.
  // `report()` ya NO lo evalúa: con 25.136 registros eran ~125.000 `evaluate()` por corrida para
  // un campo que nadie leía. Quien quiera el veredicto de una revisión vieja, la evalúa.
  assert.deepEqual(state.records[0]?.history?.[0]?.availability, evidence.availability);
  assert.ok(evaluate(state.records[0]!.history![1]!, profile, now).verification.reasons.includes('listing_closed'));
  const result = report(state, profile, now);
  assert.equal('historicalEvaluations' in result.records[0]!, false, 'report no evalúa el historial');
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
  const { description: _unchanged, ...archivada } = rechecked;
  assert.deepEqual(changed.records[0]?.history, [archivada], 'se archiva sin repetir la descripción');
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

test('una revisión cuya cita de patrocinio vive en la descripción la conserva entera', () => {
  // `parseOpportunity` exige que la cita de patrocinio aparezca LITERALMENTE en la descripción.
  // Quitarla del historial para ahorrar bytes dejaría el checkpoint imposible de volver a cargar,
  // así que esas revisiones son la excepción explícita y pagan el espacio.
  const quote = 'We sponsor visas for this role.';
  const description = `Build TypeScript services. ${quote} Apply today.`;
  const conPatrocinio = verifiedOpportunity({ description,
    sponsorship: { status: 'stated', evidence: { kind: 'description_phrase', source: 'test', quote, observedAt: now.toISOString() } } });
  // Cambia la ubicación, no la descripción: el caso que dispara el ahorro en todos los demás.
  const movida = { ...conPatrocinio, location: 'Remote' };
  const state = ingest(ingest(empty(), conPatrocinio), movida);
  assert.equal(state.records[0]?.history?.length, 1);
  assert.equal(state.records[0]!.history![0]!.description, description, 'la descripción se conserva');
  // La prueba que de verdad importa: el store vuelve a cargar. Sin la excepción, esto lanzaría.
  assert.deepEqual(parseStore(state), state);

  // Y el caso normal, sin patrocinio en la descripción, sí ahorra.
  const normal = verifiedOpportunity({ description });
  const normalMovida = { ...normal, location: 'Remote' };
  const ahorrada = ingest(ingest(empty(), normal), normalMovida);
  assert.equal('description' in ahorrada.records[0]!.history![0]!, false, 'sin evidencia que sostener, se ahorra');
  assert.deepEqual(parseStore(ahorrada), ahorrada);
});

test('ninguna propiedad de texto se pasa del tope de 2000 que impone Notion', () => {
  /**
   * `Location`, `Company` y `Screening reasons` construían su `rich_text` a mano y se saltaban el
   * troceo de `notionRichText`. El 2026-10-08 la oferta de Consensys —195 restricciones de
   * ubicación— puso 2.410 caracteres en `Location` y Notion respondió, textual:
   * "body.properties.Location.rich_text[0].text.content.length should be ≤ 2000, instead was 2410".
   * El sync la reportaba `failed: 1` en cada corrida.
   *
   * El tope es por FRAGMENTO, no por propiedad: `Explanation` con 2.841 caracteres nunca falló
   * porque ya pasaba por el helper y salía en dos. El helper funcionaba; fallaba quien no lo usaba.
   */
  const largo = (n: number) => 'x'.repeat(n);
  const monstruo = verifiedOpportunity({
    title: largo(2500), company: largo(2400),
    location: Array.from({ length: 195 }, (_, i) => `pais-numero-${i}`).join(', '),
    description: largo(9000),
  });
  const result = report(ingest(empty(), [monstruo]), profile, now);
  const props = result.notion.records[0]!.properties as Record<string, { rich_text?: { text: { content: string } }[]; title?: { text: { content: string } }[] }>;
  let revisadas = 0;
  for (const [name, value] of Object.entries(props)) {
    for (const chunk of [...(value.rich_text ?? []), ...(value.title ?? [])]) {
      revisadas++;
      assert.ok(chunk.text.content.length <= NOTION_RICH_TEXT_LIMIT,
        `${name}: un fragmento mide ${chunk.text.content.length}, y Notion devuelve 400 por encima de ${NOTION_RICH_TEXT_LIMIT}`);
    }
  }
  assert.ok(revisadas >= 6, `se revisaron ${revisadas} fragmentos`);
  // Y trocear no es truncar: el texto completo sigue ahí, repartido.
  assert.equal(props.Location!.rich_text!.map(c => c.text.content).join(''), monstruo.location);
  assert.equal(props.Name!.title!.map(c => c.text.content).join(''), monstruo.title);
});

test('la purga conserva lo vigente y olvida lo caducado', () => {
  const fresh = verifiedOpportunity({ title: 'Vigente' });
  // Publicada hace 40 días: fuera de la ventana de 7, `stale` irreversible. No puede volver a un corte.
  const vieja = verifiedOpportunity({ title: 'Vieja', publishedAt: '2026-08-07',
    publicationEvidence: { ...evidence.publicationEvidence, excerpt: 'Published 2026-08-07' } });
  // Comprobada hace 10 días: el TTL de 24 h venció y `validUntil` quedó muy atrás.
  const rancia = verifiedOpportunity({ title: 'Rancia',
    availability: { ...evidence.availability, checkedAt: '2026-09-06T12:00:00Z' } });
  // Sin `availability` no hay `validUntil`: sin señal, se conserva.
  const sinSenal = verifiedOpportunity({ title: 'Sin senal', availability: undefined });

  const state = ingest(empty(), [fresh, vieja, rancia, sinSenal]);
  assert.equal(state.records.length, 4);
  const { store, report: r } = pruneStore(state, profile, now);
  const titulos = store.records.map(x => x.opportunity.title).sort();
  assert.deepEqual(titulos, ['Sin senal', 'Vigente'], 'sobreviven la vigente y la que no tiene señal');
  assert.equal(r.records, 4);
  assert.equal(r.wouldRemove, 2);
  assert.equal(r.byReason.no_expiry_signal, 1);
  assert.equal(r.byReason.still_valid, 1);
  // El motivo nombra el estado con el que se fue, no solo que se fue.
  assert.equal(Object.keys(r.byReason).filter(k => k.startsWith('removed_')).length > 0, true);
  // Y el store purgado sigue siendo un store válido.
  assert.deepEqual(parseStore(store), store);
});

test('un off_target caducado no recibe gracia, salvo si ya se entregó', () => {
  // Caducada hace dos días: DENTRO de los siete de gracia, así que la regla uniforme la conserva.
  const caducadaEnGracia = { ...evidence.availability, checkedAt: '2026-09-13T12:00:00Z' };
  const en = (slug: string, overrides: Partial<Opportunity> = {}) => {
    const url = `https://example.com/${slug}`;
    return verifiedOpportunity({ title: slug, externalId: slug, url,
      publicationEvidence: { ...evidence.publicationEvidence, url },
      availability: { ...caducadaEnGracia, url }, ...overrides });
  };
  // Perfil LOCAL con un término excluido: el de arriba no declara ninguno, y `roleExcludedTerms`
  // aplica solo al TÍTULO. Primero intenté llegar a `off_target` con una descripción de ventas y
  // daba `weak`; la aserción del fixture lo cazó, que es justo para lo que está.
  const perfil = parseProfile({ skills: ['TypeScript'], remoteOnly: true,
    relevance: { roleTerms: ['developer', 'software engineer'], roleExcludedTerms: ['account executive'] } });
  const fuera = en('fuera-de-objetivo', { title: 'Enterprise Account Executive' });
  const fueraEntregada = en('fuera-entregada', { title: 'Senior Account Executive' });
  const relevante = en('relevante');

  const state = ingest(empty(), [fuera, fueraEntregada, relevante]);
  // El fixture se AFIRMA, no se supone: si mañana el ranker cambia y estas dejan de ser
  // `off_target`, esta prueba debe caerse aquí y no pasar en verde midiendo otra cosa.
  const tier = (url: string) => evaluate(state.records.find(r => r.opportunity.url === url)!.opportunity, perfil, now).relevance.tier;
  assert.equal(tier('https://example.com/fuera-de-objetivo'), 'off_target');
  assert.equal(tier('https://example.com/fuera-entregada'), 'off_target');
  assert.equal(tier('https://example.com/relevante') === 'off_target', false);

  // EL CONTRASTE, con los mismos tres registros y dos perfiles: bajo el perfil base, que no declara
  // términos excluidos, ninguna es `off_target`, así que la gracia de siete días las cubre a todas y
  // sobreviven las tres. Lo que decide no es la fecha —es idéntica—, es el tier.
  assert.equal(tier('https://example.com/fuera-de-objetivo') === 'off_target', true);
  assert.equal(evaluate(fuera, profile, now).relevance.tier === 'off_target', false, 'sin términos excluidos no es off_target');
  assert.equal(pruneStore(state, profile, now).report.wouldRemove, 0, 'caducadas hace 2 días, la gracia son 7: sobreviven');

  // Con la gracia por tier, la `off_target` se va: nunca estuvo en un corte y no puede entrar a uno.
  const entregada = new Set([identity(fueraEntregada)]);
  const { store, report: r } = pruneStore(state, perfil, now, STORE_GRACE_DAYS, { delivered: entregada });
  // Se compara por URL, no por título: el título lleva el término excluido, la URL es la identidad.
  assert.deepEqual(store.records.map(x => x.opportunity.url).sort(),
    ['https://example.com/fuera-entregada', 'https://example.com/relevante']);
  assert.equal(r.wouldRemove, 1);
  // El motivo distingue a quién se lo llevó la gracia cero de quién habría caído igual, porque de
  // eso depende saber si la palanca alcanzó.
  assert.equal(r.byReason.removed_off_target, 1);
  // La entregada se cuenta como `delivered`, no como `still_valid`: salió por la protección, no
  // porque la fecha la salvara. El motivo tiene que decir cuál de las dos cosas pasó.
  assert.equal(r.byReason.delivered, 1);
  assert.equal(r.byReason.still_valid, 1);

  // Lo ENTREGADO se queda aunque sea `off_target` y esté caducado: Juan lo vio y pudo postularse.
  // Borrarlo sería borrar la oferta a la que se postuló y con ella la única fila del embudo.
  assert.equal(store.records.some(x => x.opportunity.url === 'https://example.com/fuera-entregada'), true);
  // Y sin registro de entregas, esa misma purga sí se la lleva: la protección ES el ledger, no una
  // propiedad del registro. Si `data/delivered.json` se pierde, se pierde el escudo.
  assert.equal(pruneStore(state, perfil, now, STORE_GRACE_DAYS, { delivered: new Set() }).report.wouldRemove, 2);

  // Y el caso que de verdad costó registros: un entregado RELEVANTE, caducado MÁS allá de la
  // gracia. La protección por tier no lo salvaba —al no ser `off_target` pasaba al camino normal—
  // y la gracia se le acababa igual. Medido el 2026-10-08: así se perdieron 8 de 123 entregados,
  // seis de ellos `strong`, y seis estaban a 7,0 días exactos del borde.
  const urlVieja = 'https://example.com/entregada-vieja';
  const entregadaVieja = verifiedOpportunity({ title: 'Developer', externalId: 'entregada-vieja', url: urlVieja,
    publicationEvidence: { ...evidence.publicationEvidence, url: urlVieja },
    // Comprobada hace 30 días: caducó hace 29, muy por fuera de los 7 de gracia.
    availability: { ...evidence.availability, url: urlVieja, checkedAt: '2026-08-17T12:00:00Z' } });
  const conVieja = ingest(empty(), [entregadaVieja]);
  assert.equal(evaluate(entregadaVieja, perfil, now).relevance.tier === 'off_target', false, 'es relevante, no off_target');
  assert.equal(pruneStore(conVieja, perfil, now, STORE_GRACE_DAYS, { delivered: new Set() }).report.wouldRemove, 1,
    'sin el ledger se va, por vieja');
  const protegida = pruneStore(conVieja, perfil, now, STORE_GRACE_DAYS, { delivered: new Set([identity(entregadaVieja)]) });
  assert.equal(protegida.report.wouldRemove, 0, 'entregada: ningún número de días autoriza a borrarla');
  assert.equal(protegida.report.byReason.delivered, 1, 'y el motivo lo nombra, para poder contarlo');
  // Sigue siendo un store válido e idempotente.
  assert.deepEqual(parseStore(store), store);
  assert.equal(pruneStore(store, perfil, now, STORE_GRACE_DAYS, { delivered: entregada }).report.wouldRemove, 0);
});

test('la purga es idempotente y no borra nada en la segunda pasada', () => {
  const state = ingest(empty(), [verifiedOpportunity({ title: 'Vigente' }),
    verifiedOpportunity({ title: 'Vieja', publishedAt: '2026-08-07', publicationEvidence: { ...evidence.publicationEvidence, excerpt: 'old' } })]);
  const first = pruneStore(state, profile, now);
  const second = pruneStore(first.store, profile, now);
  assert.equal(first.report.wouldRemove, 1);
  assert.equal(second.report.wouldRemove, 0, 'la segunda pasada no encuentra nada que borrar');
  assert.deepEqual(second.store, first.store);
  // Los días de gracia son un parámetro, no una constante incrustada, y se validan.
  assert.equal(pruneStore(state, profile, now, 0).report.wouldRemove >= 1, true);
  for (const invalid of [-1, 1.5, Number.NaN]) assert.throws(() => pruneStore(state, profile, now, invalid), /graceDays/);
});

test('compactHistory aplica la regla al historial ya escrito y no pierde texto recuperable', () => {
  // `ingest` solo evita la repetición en revisiones nuevas. Lo escrito antes conserva su copia:
  // medido el 2026-09-30, 12.829 de 27.225 revisiones repetían la descripción siguiente, 66,9 MB.
  const description = 'Build TypeScript services for a distributed team.';
  const base = verifiedOpportunity({ description });
  // Se construye un historial "viejo" a mano, con la descripción repetida en cada revisión.
  const viejo: Store = { version: 1, records: [{ id: identity(base), opportunity: base,
    history: [{ ...base, location: 'Rev 1' }, { ...base, location: 'Rev 2' }] }] };
  const { store, revisions, compacted } = compactHistory(viejo);
  assert.equal(revisions, 2);
  assert.equal(compacted, 2);
  for (const entry of store.records[0]!.history!) assert.equal('description' in entry, false);
  // El texto sigue siendo recuperable: se avanza en la cadena hasta la primera que lo trae.
  assert.equal(store.records[0]!.opportunity.description, description);
  assert.deepEqual(parseStore(store), store, 'el store compactado sigue cargando');
  // Idempotente.
  assert.equal(compactHistory(store).compacted, 0);

  // Una revisión cuya descripción SÍ difiere se conserva entera.
  const distinta: Store = { version: 1, records: [{ id: identity(base), opportunity: base,
    history: [{ ...base, description: 'Otro texto por completo.' }] }] };
  assert.equal(compactHistory(distinta).compacted, 0);
  assert.equal(compactHistory(distinta).store.records[0]!.history![0]!.description, 'Otro texto por completo.');

  // Y la excepción del patrocinio se respeta también retroactivamente.
  const quote = 'We sponsor visas.';
  const conCita = verifiedOpportunity({ description: `Work here. ${quote}`,
    sponsorship: { status: 'stated', evidence: { kind: 'description_phrase', source: 'test', quote, observedAt: now.toISOString() } } });
  const conPatrocinio: Store = { version: 1, records: [{ id: identity(conCita), opportunity: conCita, history: [{ ...conCita, location: 'Rev 1' }] }] };
  assert.equal(compactHistory(conPatrocinio).compacted, 0, 'no se toca una revisión con cita que sostener');
  assert.deepEqual(parseStore(compactHistory(conPatrocinio).store), compactHistory(conPatrocinio).store);
});
