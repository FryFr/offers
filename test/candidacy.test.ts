import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCandidacyBrief, parseCandidateFacts, renderCandidacyMarkdown, writeCandidacyBriefs } from '../src/candidacy.ts';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { identity, ingest, report, type Store } from '../src/pipeline.ts';

const now = new Date('2026-09-16T12:00:00Z');
const profile = parseProfile({ skills: ['typescript'] });
const factsInput = {
  schemaVersion: 1,
  name: ' Example Candidate ',
  headline: 'Engineer',
  location: 'Bogotá',
  contact: { email: 'candidate@example.com', links: ['https://example.com/me'] },
  skills: ['TypeScript', 'NODE.JS', 'typescript'],
  highlights: ['Built a documented service.'],
};
const facts = parseCandidateFacts(factsInput);
const evidence = {
  url: 'https://example.com/job',
  publishedAt: '2026-09-16',
  publicationEvidence: { url: 'https://example.com/job', excerpt: 'Published today', observedAt: now.toISOString() },
  availability: { url: 'https://example.com/job', checkedAt: now.toISOString(), outcome: 'open' as const, httpStatus: 200, evidence: 'Application form is open' },
};
const opportunity = (overrides: Partial<Opportunity> = {}) => parseOpportunity({ title: 'Developer', company: 'Acme', kind: 'freelance', skills: ['TypeScript', 'Python'], ...evidence, ...overrides });
const record = (overrides: Partial<Opportunity> = {}) => report(ingest({ version: 1, records: [] } satisfies Store, opportunity(overrides)), profile, now).records[0]!;

test('CandidateFacts usa un contrato cerrado, versionado y normalizado', () => {
  assert.deepEqual(facts.skills, ['typescript', 'node.js']);
  assert.equal(facts.name, 'Example Candidate');
  assert.equal(factsInput.name, ' Example Candidate ');
  for (const value of [
    null,
    {},
    { ...factsInput, schemaVersion: 2 },
    { ...factsInput, unknown: true },
    { ...factsInput, skills: null },
    { ...factsInput, highlights: [''] },
    { ...factsInput, contact: { token: 'secret' } },
    { ...factsInput, contact: { links: ['file:///tmp/cv'] } },
    { ...factsInput, contact: { email: 'invalid' } },
  ]) assert.throws(() => parseCandidateFacts(value));
  const sparse: unknown[] = [];
  sparse.length = 1;
  assert.throws(() => parseCandidateFacts({ ...factsInput, skills: sparse }), /candidate\.skills\[0\]/);
});

test('buildCandidacyBrief es puro y calcula matched, missing y ratio sin inferencias', () => {
  const source = record();
  const before = structuredClone(source);
  const brief = buildCandidacyBrief(source, facts)!;
  assert.deepEqual(brief.match, { matched: ['typescript'], missing: ['python'], ratio: 0.5 });
  assert.deepEqual(source, before);
  assert.deepEqual(buildCandidacyBrief(source, facts), brief);
  assert.equal(buildCandidacyBrief(record({ skills: [] }), facts)?.match.ratio, null);
  assert.deepEqual(buildCandidacyBrief(record({ skills: [] }), facts)?.match.missing, []);
});

test('el gate solo admite verified, no discarded y no ineligible', () => {
  assert.ok(buildCandidacyBrief(record(), facts));
  assert.equal(buildCandidacyBrief(record({ publishedAt: undefined }), facts), null);
  assert.equal(buildCandidacyBrief(record({ description: 'Mining slurry pumps' }), facts), null);
  assert.equal(buildCandidacyBrief(record({ kind: 'employment', relocationRequired: false, compensation: { currency: 'USD', period: 'month', min: 2000 } }), facts), null);
  assert.ok(buildCandidacyBrief(record({ kind: 'employment' }), facts), 'unknown no equivale a ineligible');
});

test('Markdown es determinista, explícito y conserva placeholders y disclaimer', () => {
  const brief = buildCandidacyBrief(record(), facts)!;
  const markdown = renderCandidacyMarkdown(brief);
  assert.equal(renderCandidacyMarkdown(brief), markdown);
  assert.match(markdown, /Borrador interno, revisar antes de enviar/);
  assert.match(markdown, /1\/2 \(50%\)/);
  assert.match(markdown, /\[POR COMPLETAR:/);
  assert.match(markdown, /Built a documented service/);
});

test('escritura Markdown es atómica, estable e idempotente', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offers-candidacy-write-'));
  try {
    const brief = buildCandidacyBrief(record(), facts)!;
    const first = await writeCandidacyBriefs(directory, [brief]);
    assert.equal(first[0]?.changed, true);
    const path = first[0]!.path;
    const before = await stat(path);
    const contents = await readFile(path, 'utf8');
    const second = await writeCandidacyBriefs(directory, [brief]);
    assert.equal(second[0]?.changed, false);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    assert.equal(await readFile(path, 'utf8'), contents);
    assert.deepEqual((await readdir(directory)).sort(), [`${brief.opportunityId}.md`]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI opt-in genera solo briefs elegibles y no toca drafts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offers-candidacy-cli-'));
  try {
    const candidatePath = join(directory, 'candidate.json');
    const statePath = join(directory, 'state.json');
    const candidacyDirectory = join(directory, 'candidacy');
    await writeFile(candidatePath, `${JSON.stringify(factsInput)}\n`);
    const eligible = opportunity();
    // Ocho días: un día fuera de PUBLICATION_WINDOW_DAYS, así el caso sigue probando "stale no genera brief".
    const blocked = opportunity({ title: 'Old role', source: 'test', externalId: 'old', publishedAt: '2026-09-08' });
    const args = ['src/cli.ts', '--input', '-', '--state', statePath, '--now', now.toISOString(), '--candidate', candidatePath, '--candidacy-dir', candidacyDirectory];
    const first = spawnSync(process.execPath, args, { input: JSON.stringify([eligible, blocked]), encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).records.length, 2);
    assert.deepEqual(await readdir(candidacyDirectory), [`${identity(eligible)}.md`]);
    const path = join(candidacyDirectory, `${identity(eligible)}.md`);
    const contents = await readFile(path, 'utf8');
    const before = await stat(path);
    const second = spawnSync(process.execPath, args, { input: JSON.stringify([eligible, blocked]), encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(path, 'utf8'), contents);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    const missingCandidate = spawnSync(process.execPath, ['src/cli.ts', '--input', '-', '--state', join(directory, 'unused.json'), '--candidacy-dir', candidacyDirectory], { input: '{}', encoding: 'utf8' });
    assert.equal(missingCandidate.status, 1);
    assert.match(missingCandidate.stderr, /requiere --candidate/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
