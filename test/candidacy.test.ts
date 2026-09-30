import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCandidacyBrief, parseCandidateFacts, renderCandidacyMarkdown } from '../src/candidacy.ts';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { identity, ingest, report, type Store } from '../src/pipeline.ts';

const now = new Date('2026-09-16T12:00:00Z');
// El perfil DECLARA el rol que busca. Sin eso las ofertas caen en `weak` y el gate nuevo —que
// exige el mismo tier que llega al tablero de Notion— no genera material para ninguna.
const profile = parseProfile({ skills: ['typescript'], relevance: { roleTerms: ['developer'] } });
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
// La descripción existe a propósito: es donde el cruce busca ahora. Sin ella, `skills` era el único
// sitio con "TypeScript", y una oferta con `skills: []` —el 70% del pool real— no coincidía en nada.
// Menciona typescript y NO node.js, para que `absent` tenga algo que reportar.
const opportunity = (overrides: Partial<Opportunity> = {}) => parseOpportunity({ title: 'Developer', company: 'Acme', kind: 'freelance',
  description: 'We are hiring a developer to build TypeScript services for a distributed team.',
  skills: ['TypeScript', 'Python'], ...evidence, ...overrides });
const record = (overrides: Partial<Opportunity> = {}) => report(ingest({ version: 1, records: [] } satisfies Store, opportunity(overrides)), profile, now).records[0]!;

test('CandidateFacts usa un contrato cerrado, versionado y normalizado', () => {
  assert.deepEqual(facts.skills, ['typescript', 'node.js']);
  assert.equal(facts.name, 'Example Candidate');
  assert.equal(factsInput.name, ' Example Candidate ');
  for (const value of [
    null,
    {},
    { ...factsInput, schemaVersion: 3 },
    { ...factsInput, unknown: true },
    // La v1 RECHAZA los campos de la v2. Si los aceptara en silencio, un typo en `experence`
    // pasaría por clave desconocida válida en vez de fallar ruidosamente.
    { ...factsInput, experience: [] },
    { ...factsInput, skillGroups: [] },
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

test('el cruce va contra el TEXTO de la oferta, no contra un array que los adaptadores dejan vacío', () => {
  // Siete de los diez adaptadores dejan `opportunity.skills` en `[]`, y los TRES ATS —las fuentes
  // de mayor confianza— están todos en ese grupo. Cruzar por igualdad exacta contra ese campo daba
  // `ratio: null` para cualquier oferta de un board: la ficha moría en las mejores ofertas.
  const source = record();
  const before = structuredClone(source);
  const brief = buildCandidacyBrief(source, facts)!;
  assert.equal(brief.match.basis, 'offer_text');
  assert.deepEqual(brief.match.matched, ['typescript'], 'hallada en el texto, con alias');
  assert.deepEqual(brief.match.absent, ['node.js'], 'declarada por el candidato y ausente del texto');
  assert.deepEqual(brief.match.declaredMissing, ['python'], 'declarada por la oferta y sin respaldo');
  // La proporción es sobre las habilidades del CANDIDATO: cuánto de lo que sabe pide esta oferta.
  assert.equal(brief.match.ratio, 0.5);
  assert.deepEqual(source, before, 'no muta el record');
  assert.deepEqual(buildCandidacyBrief(source, facts), brief, 'determinista');

  // LA PRUEBA QUE FIJA EL ARREGLO: una oferta SIN habilidades declaradas —el 70% del pool— sigue
  // produciendo una proporción real, porque el cruce ya no depende de ese campo.
  const sinDeclarar = buildCandidacyBrief(record({ skills: [] }), facts)!;
  assert.equal(sinDeclarar.match.ratio, 0.5, 'la proporción sobrevive a un array vacío');
  assert.deepEqual(sinDeclarar.match.matched, ['typescript']);
  assert.deepEqual(sinDeclarar.match.declaredMissing, []);
});

test('el gate exige el mismo tier que llega al tablero, con escape explícito', () => {
  // Sin el tier, esto genera una carpeta por cada registro verificado del histórico.
  const debil = parseProfile({ skills: ['typescript'] });
  const flojo = report(ingest({ version: 1, records: [] } satisfies Store, opportunity()), debil, now).records[0]!;
  assert.equal(flojo.evaluation.relevance.tier, 'weak');
  assert.equal(buildCandidacyBrief(flojo, facts), null, 'una oferta weak no merece un paquete');
  assert.ok(buildCandidacyBrief(flojo, facts, { tiers: ['strong', 'possible', 'weak'] }), 'y el escape existe');
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


test('CLI opt-in genera solo briefs elegibles y no toca drafts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offers-candidacy-cli-'));
  try {
    const candidatePath = join(directory, 'candidate.json');
    const statePath = join(directory, 'state.json');
    const candidacyDirectory = join(directory, 'candidacy');
    await writeFile(candidatePath, `${JSON.stringify(factsInput)}\n`);
    // El perfil se pasa explícito: el gate exige tier `strong` o `possible`, y con el perfil por
    // defecto —sin habilidades ni términos de rol— toda oferta sale `weak` y no habría material.
    const profilePath = join(directory, 'profile.json');
    await writeFile(profilePath, `${JSON.stringify({ skills: ['typescript'], relevance: { roleTerms: ['developer'] } })}\n`);
    const eligible = opportunity();
    // Ocho días: un día fuera de PUBLICATION_WINDOW_DAYS, así el caso sigue probando "stale no genera brief".
    const blocked = opportunity({ title: 'Old role', source: 'test', externalId: 'old', publishedAt: '2026-09-08' });
    const args = ['src/cli.ts', '--input', '-', '--state', statePath, '--profile', profilePath, '--now', now.toISOString(), '--candidate', candidatePath, '--candidacy-dir', candidacyDirectory];
    const first = spawnSync(process.execPath, args, { input: JSON.stringify([eligible, blocked]), encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).records.length, 2);
    // Un DIRECTORIO por oferta, nombrado con el SHA-256 que también es la External Key de Notion:
    // desde una fila del tablero se llega a la carpeta copiando esa celda.
    assert.deepEqual(await readdir(candidacyDirectory), [identity(eligible)], 'la stale no genera paquete');
    const path = join(candidacyDirectory, identity(eligible), 'cv.md');
    assert.deepEqual((await readdir(join(candidacyDirectory, identity(eligible)))).sort(), ['brief.md', 'cover-letter.md', 'cv.md', 'review.json']);
    const contents = await readFile(path, 'utf8');
    const before = await stat(path);
    const second = spawnSync(process.execPath, args, { input: JSON.stringify([eligible, blocked]), encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(path, 'utf8'), contents);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs, 'idempotente por bytes');
    assert.deepEqual(JSON.parse(second.stdout).candidacy.written.map((w: { changed: string[] }) => w.changed), [[]], 'la segunda pasada no reescribe');
    const missingCandidate = spawnSync(process.execPath, ['src/cli.ts', '--input', '-', '--state', join(directory, 'unused.json'), '--candidacy-dir', candidacyDirectory], { input: '{}', encoding: 'utf8' });
    assert.equal(missingCandidate.status, 1);
    assert.match(missingCandidate.stderr, /requiere --candidate o --candidate-by-family/);
    // Y el patrón por familia exige el marcador: sin él, todas las familias leerían el mismo archivo.
    const badPattern = spawnSync(process.execPath, ['src/cli.ts', '--input', '-', '--state', join(directory, 'unused2.json'), '--candidate-by-family', 'facts.json'], { input: '{}', encoding: 'utf8' });
    assert.equal(badPattern.status, 1);
    assert.match(badPattern.stderr, /\{family\}/);
    assert.match(missingCandidate.stderr, /requiere --candidate/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CandidateFacts v2 declara el CV como datos, ordenado y con periodos comprobados', () => {
  const v2 = {
    ...factsInput, schemaVersion: 2,
    experience: [
      { company: 'Teleperformance', role: 'Client Account Manager', start: '2020-06', end: '2022-08', location: 'Bogotá, Colombia',
        achievements: ['Managed an operation of 1,200 people and achieved +30% in sales.'] },
      { company: 'Dynapro Pumps', role: 'Business Systems & AI Specialist', start: '2026-01', location: 'Bogotá, Colombia (remote)',
        achievements: ['Run 30+ production n8n workflows.', 'Reduced order processing from ~90 minutes to ~2 minutes.'] },
    ],
    education: [{ institution: 'Universidad EAN', degree: 'B.Eng. Mechatronics Engineering', start: '2021-02', end: '2025-11' }],
    languages: [{ name: 'English', level: 'C1', evidence: 'IELTS, British Council; valid 07/2025-07/2028' }, { name: 'Spanish', level: 'Native' }],
    skillGroups: [{ name: 'AI & agents', skills: ['LLM integration', 'RAG', 'MCP'] }, { name: 'Automation', skills: ['n8n', 'Webhooks'] }],
  };
  const parsed = parseCandidateFacts(v2);
  // El orden es un HECHO de la cronología, no una preferencia que cada renderizador deba recordar:
  // se fija al parsear, del presente al pasado.
  assert.deepEqual(parsed.experience!.map(e => e.company), ['Dynapro Pumps', 'Teleperformance']);
  // Los logros son texto literal: no se normalizan ni se deduplican, porque la carta los cita verbatim.
  assert.equal(parsed.experience![0]!.achievements[1], 'Reduced order processing from ~90 minutes to ~2 minutes.');
  assert.equal(parsed.experience![0]!.end, undefined, 'un puesto vigente no tiene fin');
  // La evidencia del idioma se conserva: "C1" es una afirmación, el IELTS con vigencia es un hecho.
  assert.match(parsed.languages![0]!.evidence!, /IELTS/);
  assert.deepEqual(parsed.skillGroups![0]!.skills, ['llm integration', 'rag', 'mcp']);
  assert.deepEqual(parseCandidateFacts(v2), parsed, 'determinista');

  // Un periodo imposible se rechaza, igual que una fecha imposible en un contrato de oferta.
  const conFechas = (start: string, end?: string) => ({ ...v2, experience: [{ company: 'Acme', role: 'Dev', start, ...(end ? { end } : {}), achievements: ['Shipped.'] }] });
  assert.throws(() => parseCandidateFacts(conFechas('2026-01', '2025-12')), /anterior a start/);
  assert.throws(() => parseCandidateFacts(conFechas('2026-1')), /YYYY-MM/);
  assert.throws(() => parseCandidateFacts(conFechas('2026-13')), /YYYY-MM/);
  assert.throws(() => parseCandidateFacts(conFechas('2026-01-15')), /YYYY-MM/);
  // Y el contrato sigue cerrado DENTRO de cada entrada.
  assert.throws(() => parseCandidateFacts({ ...v2, experience: [{ company: 'Acme', role: 'Dev', start: '2026-01', achievements: ['x'], extra: 1 }] }));
  assert.throws(() => parseCandidateFacts({ ...v2, languages: [{ name: 'English' }] }));
  assert.throws(() => parseCandidateFacts({ ...v2, experience: 'no es lista' }), /se esperaba una lista/);
});

test('el ejemplo del repositorio cumple el contrato v2 y no trae datos reales', async () => {
  // `examples/candidate-facts.json` era un placeholder inservible con 3 habilidades genéricas. Su
  // único trabajo legítimo es ser el ejemplo del contrato, así que se comprueba que lo cumpla.
  const example = parseCandidateFacts(JSON.parse(await readFile(new URL('../examples/candidate-facts.json', import.meta.url), 'utf8')));
  assert.equal(example.schemaVersion, 2);
  assert.ok(example.experience?.length, 'el ejemplo declara experiencia');
  assert.ok(example.skillGroups?.length && example.languages?.length && example.education?.length);
  // Y es FICTICIO a propósito: los hechos reales viven en data/, que está gitignoreado.
  assert.match(example.name, /Example/);
  assert.match(example.contact!.email!, /@example\.com$/);
  for (const link of example.contact!.links!) assert.match(link, /^https:\/\/example\.com\//);
});
