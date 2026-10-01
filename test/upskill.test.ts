import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { ingest, report, type Store } from '../src/pipeline.ts';
import { GAP_VOCABULARY, renderUpskill, upskillReport } from '../src/upskill.ts';

const now = new Date('2026-09-16T12:00:00Z');
const evidence = (url: string) => ({ url, publishedAt: '2026-09-16',
  publicationEvidence: { url, excerpt: 'Published', observedAt: now.toISOString() },
  availability: { url, checkedAt: now.toISOString(), outcome: 'open' as const, httpStatus: 200, evidence: 'listing' } });
// El perfil declara `llm` en el núcleo con su alias, y `fastapi` que nadie va a pedir.
const profile = parseProfile({ skills: ['llm', 'python', 'fastapi'], secondarySkills: ['kubernetes'],
  relevance: { roleTerms: ['ai engineer'], skillAliases: { llm: ['llms', 'large language models'] } } });
const job = (n: number, description: string, title = 'Senior AI Engineer') =>
  parseOpportunity({ title, company: 'Acme', skills: [], remoteness: 'fully_remote', description, ...evidence(`https://example.com/j${n}`) });
const records = (...jobs: Opportunity[]) => report(ingest({ version: 1, records: [] } satisfies Store, jobs), profile, now).records;

test('el informe cuenta lo que piden las ofertas QUE TE SIRVEN, no el mercado entero', () => {
  const pool = records(
    job(1, 'Build with python, terraform and large language models.'),
    job(2, 'We use python, terraform and kubernetes daily.'),
    // Una oferta que el ranker descarta no debe contar: el mercado entero no es la pregunta.
    job(3, 'Pastry work with terraform somehow.', 'Pastry Chef'),
  );
  const r = upskillReport(pool, profile);
  assert.equal(r.pool, 2, 'la de pastelería queda fuera del pool');

  // `terraform` es la brecha real: dos ofertas lo piden y el perfil no lo declara.
  const terraform = r.gaps.find(g => g.skill === 'terraform')!;
  assert.equal(terraform.demand, 2);
  assert.equal(terraform.status, 'undeclared');
  assert.equal(terraform.examples.length, 2, 'con títulos reales para comprobarlo a mano');

  // Lo declarado NO aparece como brecha, ni el núcleo ni las secundarias.
  for (const declarada of ['llm', 'python', 'kubernetes']) {
    assert.equal(r.gaps.some(g => g.skill === declarada), false, `${declarada} está declarada`);
  }
  // Y se usan los MISMOS alias que el ranker: `llm` encuentra "large language models".
  assert.equal(r.gaps.some(g => g.skill === 'llm'), false);
});

test('también nombra lo que declaras y el pool no pide, que es lo que diluye el puntaje', () => {
  // El puntaje divide por el tamaño del núcleo, así que una del núcleo que nadie pide baja el puntaje
  // de TODAS las ofertas por igual. Esta lista es la que dice cuál mover a secundarias.
  const r = upskillReport(records(job(1, 'Build with python and terraform.')), profile);
  assert.deepEqual(r.unused.map(g => g.skill), ['fastapi', 'llm'], 'del núcleo, las que no aparecieron');
  assert.ok(r.unused.every(g => g.demand === 0));
});

test('el orden pondera la demanda en lo strong y el informe es determinista', () => {
  const pool = records(
    // `rust` solo en una `possible`; `graphql` en una que llega a `strong`.
    job(1, 'Senior work with rust.', 'Senior AI Engineer'),
    job(2, 'Senior role: python, llm, graphql, docker, aws, testing, postgresql and more python.', 'Senior AI Engineer'),
  );
  const r = upskillReport(pool, profile);
  const tiers = new Set(pool.map(p => p.evaluation.relevance.tier));
  assert.ok(tiers.has('strong') || tiers.has('possible'));
  // Quien aparece en una `strong` va antes que quien solo aparece en una `possible`.
  const porStrong = [...r.gaps].sort((a, b) => b.strongDemand - a.strongDemand || b.demand - a.demand || a.skill.localeCompare(b.skill));
  assert.deepEqual(r.gaps.map(g => g.skill), porStrong.map(g => g.skill));
  assert.deepEqual(upskillReport(pool, profile), r, 'determinista');
});

test('el vocabulario es explícito, no extracción libre del texto', () => {
  // Contar n-gramas de una descripción pone "team", "experience" y "customer" en el top, y un informe
  // así no se vuelve a abrir. Cada entrada tiene que ser algo que alguien pueda estudiar el lunes.
  assert.ok(GAP_VOCABULARY.length > 50);
  for (const ruido of ['team', 'experience', 'customer', 'work', 'role', 'company']) {
    assert.equal(GAP_VOCABULARY.includes(ruido), false, `"${ruido}" no es una habilidad estudiable`);
  }
  assert.equal(new Set(GAP_VOCABULARY).size, GAP_VOCABULARY.length, 'sin duplicados');
  // El Markdown nombra sus límites en vez de presentarse como un veredicto.
  const markdown = renderUpskill(upskillReport(records(job(1, 'python and terraform')), profile));
  assert.match(markdown, /Que aparezca no dice a qué nivel/);
  assert.match(markdown, /verificadas y relevantes/);
});

test('el perfil real no declara en el núcleo nada que el vocabulario considere brecha', async () => {
  // Si una habilidad estuviera en las dos listas, el informe la contaría como brecha y como declarada
  // a la vez según de dónde se lea, y el consejo "muévela a secundarias" se contradiría solo.
  const real = parseProfile(JSON.parse(await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8')));
  const r = upskillReport([], real);
  assert.deepEqual(r.gaps, [], 'sin pool no hay brechas que inventar');
  assert.deepEqual(r.unused.map(g => g.skill).sort(), [...real.skills].sort(), 'sin pool, todo el núcleo está sin usar');
});

test('un término que es ALIAS de algo declarado NO es una brecha', () => {
  // El informe decía que `github actions` era una brecha cuando el perfil la declara como alias de
  // `ci/cd` y el ranker ya la encuentra. Recomendar estudiar algo que ya tienes es la forma más rápida
  // de que un informe no se vuelva a abrir.
  const conAlias = parseProfile({ skills: ['ci/cd', 'python'],
    relevance: { roleTerms: ['ai engineer'], skillAliases: { 'ci/cd': ['github actions', 'continuous integration'] } } });
  const pool = report(ingest({ version: 1, records: [] } satisfies Store,
    [job(1, 'Senior pipelines with github actions, python and terraform.')]), conAlias, now).records;
  const r = upskillReport(pool, conAlias);
  assert.equal(r.gaps.some(g => g.skill === 'github actions'), false, 'es alias de ci/cd: ya la tienes');
  assert.ok(r.gaps.some(g => g.skill === 'terraform'), 'terraform sí es brecha de verdad');
  // Y `ci/cd` no queda en `unused`, porque su alias sí apareció en el texto.
  assert.equal(r.unused.some(g => g.skill === 'ci/cd'), false);
});

test('el vocabulario no admite palabras ambiguas que inflan el informe', () => {
  // `evaluation` salía en 13 ofertas y casi ninguna hablaba de evaluar modelos: "evaluation of
  // candidates" es boilerplate de reclutamiento.
  assert.equal(GAP_VOCABULARY.includes('evaluation'), false);
  assert.ok(GAP_VOCABULARY.includes('llm evaluation'), 'la forma inequívoca sí está');
});
