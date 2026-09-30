import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCandidateFacts, type CandidateFacts } from '../src/candidacy.ts';
import { buildCandidacyPackage, writeCandidacyPackage, type CandidacyPackage } from '../src/candidacy-package.ts';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { ingest, report, type Store } from '../src/pipeline.ts';

const now = new Date('2026-09-16T12:00:00Z');
const evidence = {
  url: 'https://example.com/job', publishedAt: '2026-09-16',
  publicationEvidence: { url: 'https://example.com/job', excerpt: 'Published', observedAt: now.toISOString() },
  availability: { url: 'https://example.com/job', checkedAt: now.toISOString(), outcome: 'open' as const, httpStatus: 200, evidence: 'form' },
};
const profile = parseProfile({ skills: ['n8n', 'llm'], relevance: { roleTerms: {
  ai_automation: ['ai automation engineer'], robotics: ['robotics engineer'], management: ['engineering manager'] } } });
const facts = (headline: string, extra: Partial<CandidateFacts> = {}) => parseCandidateFacts({
  schemaVersion: 2, name: 'Juan Sebastian Silva Medina', headline,
  skills: ['n8n', 'llm'], highlights: ['Runs 30+ production n8n workflows.'],
  experience: [{ company: 'Dynapro Pumps', role: 'AI Specialist', start: '2026-01',
    achievements: ['Run 30+ production n8n workflows.', 'Built an llm document pipeline.'] }],
  skillGroups: [{ name: 'AI & agents', skills: ['LLM integration'] }], ...extra,
});
const byFamily = { ai_automation: facts('AI & Automation Engineer'), management: facts('Engineering Lead') };
const record = (overrides: Partial<Opportunity> = {}) => report(ingest({ version: 1, records: [] } satisfies Store,
  parseOpportunity({ title: 'AI Automation Engineer', company: 'Acme', skills: [], remoteness: 'fully_remote',
    description: 'Senior role building n8n workflows and llm integrations.', ...evidence, ...overrides })), profile, now).records[0]!;

test('el paquete lleva ficha, carta, CV y revisión, y la familia decide el CV', () => {
  const pack = buildCandidacyPackage(record(), byFamily, profile) as CandidacyPackage;
  assert.equal(pack.roleFamily, 'ai_automation');
  assert.deepEqual(pack.files.map(f => f.name).sort(), ['brief.md', 'cover-letter.md', 'cv.md', 'review.json']);
  assert.equal(pack.deliverable, true);
  // El CV que viaja es el de la familia de la oferta, con SU titular.
  assert.match(pack.files.find(f => f.name === 'cv.md')!.contents, /AI & Automation Engineer/);
  // Y la revisión queda escrita junto al material, con lo que hay que confirmar antes de enviar.
  const review = JSON.parse(pack.files.find(f => f.name === 'review.json')!.contents);
  assert.equal(review.roleFamily, 'ai_automation');
  // El informe lleva el `item` en inglés y el `detail` con la redacción del digest, en español: la
  // carta solo imprime el primero para no mezclar idiomas en el documento que se envía.
  assert.ok(review.beforeSending.some((c: { item: string }) => c.item === 'confirm the listing is still open'));
  assert.equal(/[áéíóúñ]/i.test(pack.files.find(f => f.name === 'cover-letter.md')!.contents), false, 'la carta no mezcla idiomas');
});

test('una familia sin hechos declarados NO cae en el CV de otra: se reporta y no genera nada', () => {
  // Mandarle un CV de robótica a un puesto de management es peor que no mandar nada.
  const robotica = record({ title: 'Robotics Engineer', source: 'test', externalId: 'rob' });
  assert.equal(robotica.evaluation.relevance.roleFamily, 'robotics');
  const skipped = buildCandidacyPackage(robotica, byFamily, profile);
  assert.deepEqual(skipped, { opportunityId: robotica.id, reason: 'candidate_facts_missing', detail: 'robotics' });
  // Y con su archivo presente, sí genera.
  const conRobotica = buildCandidacyPackage(robotica, { ...byFamily, robotics: facts('Mechatronics / Robotics Engineer') }, profile) as CandidacyPackage;
  assert.equal(conRobotica.roleFamily, 'robotics');
  assert.match(conRobotica.files.find(f => f.name === 'cv.md')!.contents, /Mechatronics/);
});

test('el gate del tier se respeta y se nombra el motivo', () => {
  const flojo = report(ingest({ version: 1, records: [] } satisfies Store,
    parseOpportunity({ title: 'Pastry Chef', company: 'Acme', skills: [], ...evidence })), profile, now).records[0]!;
  const skipped = buildCandidacyPackage(flojo, byFamily, profile);
  assert.equal('reason' in skipped && skipped.reason, 'gate_blocked');
});

test('la escritura es atómica, idempotente por bytes y no deja temporales', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offers-pack-'));
  try {
    const pack = buildCandidacyPackage(record(), byFamily, profile) as CandidacyPackage;
    const first = await writeCandidacyPackage(directory, pack);
    assert.deepEqual(first.changed.sort(), ['brief.md', 'cover-letter.md', 'cv.md', 'review.json']);
    assert.deepEqual((await readdir(first.path)).sort(), ['brief.md', 'cover-letter.md', 'cv.md', 'review.json'], 'sin temporales huérfanos');
    const before = await stat(join(first.path, 'cv.md'));
    const contents = await readFile(join(first.path, 'cv.md'), 'utf8');

    // Segunda pasada: mismos bytes, así que NO se reescribe nada.
    const second = await writeCandidacyPackage(directory, pack);
    assert.deepEqual(second.changed, [], 'idempotente por bytes');
    assert.equal((await stat(join(first.path, 'cv.md'))).mtimeMs, before.mtimeMs, 'ni se toca el mtime');
    assert.equal(await readFile(join(first.path, 'cv.md'), 'utf8'), contents);

    // El id tiene que ser el SHA-256 del registro: es el mismo que la External Key de Notion.
    assert.match(first.path, /[a-f0-9]{64}$/);
    await assert.rejects(writeCandidacyPackage(directory, { ...pack, opportunityId: '../fuera' }), /SHA-256 inválido/);
    await assert.rejects(writeCandidacyPackage(directory, { ...pack, files: [{ name: '../x.md', contents: 'x' }] }), /nombre de archivo inválido/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
