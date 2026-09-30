import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidateFacts } from '../src/candidacy.ts';
import { parseOpportunity, parseProfile } from '../src/contracts.ts';
import { renderCoverLetterDraft, renderTailoredCv, selectAchievements } from '../src/application-draft.ts';
import { deliverable, reviewCandidacy } from '../src/candidacy-review.ts';

const profile = parseProfile({ skills: ['n8n', 'llm'] });
const facts = parseCandidateFacts({
  schemaVersion: 2, name: 'Juan Sebastian Silva Medina', headline: 'AI & Automation Engineer',
  skills: ['n8n', 'llm'], highlights: ['Runs 30+ production n8n workflows.'],
  experience: [
    { company: 'Dynapro Pumps', role: 'Business Systems & AI Specialist', start: '2026-01',
      achievements: ['Run 30+ production n8n workflows integrating Odoo ERP.', 'Built an llm document pipeline.'] },
    { company: 'Teleperformance', role: 'Client Account Manager', start: '2020-06', end: '2022-08',
      achievements: ['Managed an operation of 1,200 people.'] },
  ],
  skillGroups: [{ name: 'AI & agents', skills: ['LLM integration', 'RAG'] }],
});
const opportunity = parseOpportunity({ title: 'AI Automation Engineer', company: 'Acme', skills: [],
  description: 'Build n8n workflows and llm integrations.' });
const matched = ['n8n', 'llm'];
const pack = () => {
  const selected = selectAchievements(facts, matched);
  return { facts, opportunity, matched, roleFamily: 'ai_automation',
    letter: renderCoverLetterDraft({ facts, opportunity, profile, matched, selected }),
    cv: renderTailoredCv({ facts, opportunity, profile, matched, selected }) };
};

test('el paquete que genera el proyecto pasa su propia revisión', () => {
  const findings = reviewCandidacy(pack());
  assert.deepEqual(findings.filter(f => f.severity === 'blocking'), [], 'nada que bloquee');
  assert.equal(deliverable(findings), true);
  // Los huecos se cuentan y se reportan como aviso: existen para llenarlos, no para ignorarlos.
  assert.ok(findings.some(f => f.code === 'pending_placeholders'));
});

test('una frase que nadie declaró bloquea la entrega', () => {
  // El caso real: alguien edita el borrador a mano —o enchufa un LLM— y añade una cifra que suena
  // bien. Contra los hechos no existe, así que no sale.
  const inventada = pack();
  inventada.letter = `${inventada.letter}\n- Led a team that reduced processing time by 98%.\n`;
  const findings = reviewCandidacy(inventada);
  assert.equal(deliverable(findings), false);
  assert.deepEqual(findings.filter(f => f.code === 'unsupported_claim').map(f => f.detail),
    ['Led a team that reduced processing time by 98%.']);
});

test('una habilidad fuera de los grupos declarados bloquea; un puesto borrado también', () => {
  const conInvento = pack();
  conInvento.cv = conInvento.cv.replace('- **AI & agents:**', '- **AI & agents:** kubernetes,');
  assert.deepEqual(reviewCandidacy(conInvento).filter(f => f.code === 'undeclared_skill').map(f => f.detail), ['kubernetes']);

  // Recortar un empleo para que el CV cuadre mejor falsea la cronología. Es la tentación fácil.
  const recortado = pack();
  recortado.cv = recortado.cv.replace(/Teleperformance/g, '');
  const findings = reviewCandidacy(recortado);
  assert.equal(deliverable(findings), false);
  assert.ok(findings.some(f => f.code === 'missing_role' && f.detail.includes('Teleperformance')));
});

test('el titular que no corresponde a la familia de la oferta avisa, y la falta de coincidencias también', () => {
  // Mandar el CV de robótica a un puesto de management es peor que no mandar nada.
  const otraFamilia = reviewCandidacy({ ...pack(), roleFamily: 'robotics' });
  assert.ok(otraFamilia.some(f => f.code === 'headline_family_mismatch'), 'el titular dice IA, la familia dice robótica');
  assert.equal(deliverable(otraFamilia), true, 'avisa, no bloquea: quien revisa decide');
  // Y la misma familia no avisa.
  assert.equal(reviewCandidacy(pack()).some(f => f.code === 'headline_family_mismatch'), false);

  // Un paquete cuyos logros no tocan nada de la oferta es el CV de siempre con otro encabezado.
  const generico = reviewCandidacy({ ...pack(), matched: ['kubernetes', 'terraform'] });
  assert.ok(generico.some(f => f.code === 'no_achievement_matches_posting'));
});
