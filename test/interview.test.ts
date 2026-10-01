import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidateFacts } from '../src/candidacy.ts';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { interviewBrief, renderInterviewBrief } from '../src/interview.ts';

const profile = parseProfile({ skills: ['n8n', 'llm', 'python'], hoursPerMonth: 160 });
const facts = parseCandidateFacts({
  schemaVersion: 2, name: 'Juan Sebastian Silva Medina', headline: 'AI & Automation Engineer',
  skills: ['n8n', 'llm'], highlights: ['Runs 30+ production n8n workflows.'],
  experience: [{ company: 'Dynapro Pumps', role: 'AI Specialist', start: '2026-01',
    achievements: ['Built an llm document pipeline that cut processing from 90 to 2 minutes.'] }],
});
const job = (overrides: Partial<Opportunity> = {}) => parseOpportunity({
  title: 'Applied AI Engineer', company: 'Anthropic', skills: [],
  description: 'Build n8n workflows with llm and python.', ...overrides });

test('el brief es lo que afirmaste, literal, y de dónde salió', () => {
  // Contradecir tu propio CV es el fallo más barato de evitar y el más caro de cometer, y para
  // evitarlo basta releer lo que dice.
  const brief = interviewBrief({ facts, opportunity: job(), profile, matched: ['n8n', 'llm', 'python'] });
  assert.equal(brief.headline, 'AI & Automation Engineer');
  // Cada afirmación es texto LITERAL del material, con su procedencia para poder abrirla.
  assert.deepEqual(brief.claims.map(c => c.claim), [
    'Runs 30+ production n8n workflows.',
    'Built an llm document pipeline that cut processing from 90 to 2 minutes.',
  ]);
  assert.equal(brief.claims[0]!.source, 'highlights');
  assert.match(brief.claims[1]!.source, /Dynapro Pumps/);
  assert.deepEqual(interviewBrief({ facts, opportunity: job(), profile, matched: ['n8n'] }).claims, brief.claims, 'determinista');
});

test('separa lo que tu material respalda de lo que NO, sin esquivar la brecha', () => {
  const brief = interviewBrief({ facts, opportunity: job(), profile, matched: ['n8n', 'llm', 'python'] });
  assert.deepEqual(brief.supported, ['n8n', 'llm'], 'aparecen en frases que enviaste');
  assert.deepEqual(brief.gaps, ['python'], 'la oferta lo pide y tu material no lo nombra');
  // El Markdown lo dice sin rodeos y sin invitar a inventar.
  const markdown = renderInterviewBrief(brief);
  assert.match(markdown, /Reconocerlas y enlazar con experiencia adyacente\. Inventar una es otra cosa\./);
  // Y no hay una sola frase sobre la persona que no estuviera ya en los hechos.
  for (const line of markdown.split('\n').filter(l => l.startsWith('- ') && !l.startsWith('- ['))) {
    const claim = line.slice(2).trim();
    const declarada = brief.claims.some(c => c.claim === claim) || brief.supported.includes(claim)
      || brief.gaps.includes(claim) || brief.ask.some(a => claim.startsWith(a.item)) || claim.startsWith('Pago:')
      || claim.startsWith('Modalidad:') || claim.startsWith('Patrocinio:') || claim.startsWith('http');
    assert.ok(declarada, `frase no declarada en el brief: ${claim}`);
  }
});

test('una habilidad nombrada con un sinónimo SÍ está respaldada', () => {
  // Con comparación literal el brief decía que el material no respalda `llm` ni `rag` mientras las
  // frases decían "GPT-4" y "Pinecone". Una brecha falsa antes de una entrevista es peor que no
  // tener brief: te convence de que no puedes hablar de algo que sí hiciste. El matcher es el MISMO
  // del ranker, así que brief y puntaje nunca se contradicen sobre la misma oferta.
  const conAlias = parseProfile({ skills: ['llm', 'rag'], hoursPerMonth: 160,
    relevance: { skillAliases: { llm: ['gpt'], rag: ['pinecone'] } } });
  const porSinonimo = parseCandidateFacts({
    schemaVersion: 2, name: 'Juan Sebastian Silva Medina', skills: ['llm'],
    highlights: ['Built a ticket-resolution solution using Pinecone, GPT-4 and REST APIs.'],
  });
  const brief = interviewBrief({ facts: porSinonimo, opportunity: job(), profile: conAlias, matched: ['llm', 'rag', 'python'] });
  assert.deepEqual(brief.supported, ['llm', 'rag'], 'GPT-4 respalda llm; Pinecone respalda rag');
  assert.deepEqual(brief.gaps, ['python'], 'sin alias y sin rastro en el texto: brecha real');
});

test('las preguntas salen de los huecos del registro, no de una lista fija', () => {
  // Lo que había que confirmar ANTES de enviar sigue sin confirmarse si nadie preguntó: la misma
  // lista sirve para la llamada, y así no se mantienen dos listas que divergen.
  const sinDatos = interviewBrief({ facts, opportunity: job(), profile, matched: [] });
  assert.ok(sinDatos.ask.some(a => a.item === 'confirm compensation'));
  assert.ok(sinDatos.ask.some(a => a.item.startsWith('confirm work authorisation')));
  // "Sigue abierta" NO va: en una entrevista ya se sabe que lo estaba.
  assert.equal(sinDatos.ask.some(a => a.item === 'confirm the listing is still open'), false);

  const quote = 'We sponsor work visas for this role.';
  const completa = interviewBrief({ facts, profile, matched: [], opportunity: job({
    description: `Build n8n workflows. ${quote}`,
    payDisclosure: 'published', compensation: { currency: 'USD', period: 'month', min: 7000 },
    remoteness: 'fully_remote',
    sponsorship: { status: 'stated', scope: 'unspecified', evidence: { kind: 'description_phrase', source: 'test', quote, observedAt: '2026-10-01T00:00:00Z' } } }) });
  assert.deepEqual(completa.ask, [], 'la oferta lo declaraba todo');
  // Y los datos de la vacante los redactan las MISMAS funciones que el digest: no se contradicen.
  assert.match(completa.posting.pay, /7.?000 USD\/month/);
  assert.match(completa.posting.mode, /Remoto/);
  assert.match(completa.posting.sponsorship!, /Patrocinio declarado/);
});

test('un material vacío no inventa nada que contar', () => {
  const vacio = parseCandidateFacts({ schemaVersion: 2, name: 'X', skills: [], highlights: [] });
  const brief = interviewBrief({ facts: vacio, opportunity: job(), profile, matched: ['n8n'] });
  assert.deepEqual(brief.claims, []);
  assert.deepEqual(brief.supported, []);
  assert.deepEqual(brief.gaps, ['n8n']);
  assert.match(renderInterviewBrief(brief), /\[POR REVISAR: el paquete no afirmaba nada sobre ti\]/);
});
