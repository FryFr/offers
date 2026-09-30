import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidateFacts } from '../src/candidacy.ts';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { beforeSending, renderCoverLetterDraft, renderTailoredCv, selectAchievements, MAX_ACHIEVEMENTS } from '../src/application-draft.ts';

const profile = parseProfile({ skills: ['n8n', 'llm', 'python'], hoursPerMonth: 160 });
const facts = parseCandidateFacts({
  schemaVersion: 2,
  name: 'Juan Sebastian Silva Medina',
  headline: 'AI & Automation Engineer',
  location: 'Bogotá, Colombia',
  contact: { email: 'juan@example.com', links: ['https://example.com/portfolio'] },
  skills: ['n8n', 'llm', 'python'],
  highlights: ['Runs 30+ production n8n workflows.'],
  experience: [
    { company: 'Dynapro Pumps', role: 'Business Systems & AI Specialist', start: '2026-01', location: 'Bogotá, Colombia (remote)',
      achievements: [
        'Built an AI document-processing pipeline that reduced order processing from ~90 minutes to ~2 minutes.',
        'Run 30+ production n8n workflows integrating Odoo ERP and HubSpot CRM.',
        'Delivered scheduled commission ETLs for 50+ accounts.',
      ] },
    { company: 'Teleperformance', role: 'Client Account Manager', start: '2020-06', end: '2022-08', location: 'Bogotá, Colombia',
      achievements: ['Managed an operation of 1,200 people and achieved +30% in sales.'] },
  ],
  education: [{ institution: 'Universidad EAN', degree: 'B.Eng. Mechatronics Engineering', start: '2021-02', end: '2025-11' }],
  languages: [{ name: 'English', level: 'C1', evidence: 'IELTS, British Council; valid 07/2025-07/2028' }],
  skillGroups: [
    { name: 'Robotics', skills: ['ROS', 'Gazebo'] },
    { name: 'AI & agents', skills: ['LLM integration', 'RAG', 'MCP'] },
  ],
});
const job = (overrides: Partial<Opportunity> = {}) => parseOpportunity({
  title: 'AI Automation Engineer', company: 'Acme', skills: [],
  description: 'You will build n8n workflows and LLM integrations in python.', ...overrides,
});

test('la carta solo contiene frases declaradas: ninguna prosa nueva sobre la persona', () => {
  // ESTA es la prueba que impide que alguien enchufe un LLM redactor más adelante. Un modelo puede
  // escribir "led a team that reduced processing time by 98%" y no hay documento fuente contra el
  // cual comprobarlo: lo único que lo respalda es el CV, y comparar prosa contra prosa es el
  // problema que `claude-enrichment.ts` evita verificando cada cita con `includes`.
  const matched = ['n8n', 'llm', 'python'];
  const selected = selectAchievements(facts, matched);
  const letter = renderCoverLetterDraft({ facts, opportunity: job(), profile, matched, selected });

  // Todo lo declarado: los logros literales, el nombre, el titular y los datos de la oferta.
  const declared = [
    ...facts.experience!.flatMap(e => [...e.achievements, e.company, e.role]),
    ...facts.highlights, facts.name, facts.headline!, facts.location!,
    ...(facts.contact?.links ?? []), 'AI Automation Engineer', 'Acme',
  ];
  // Cada viñeta de evidencia tiene que existir LITERAL en los hechos. Sin tolerancia.
  const bullets = letter.split('\n').filter(line => line.startsWith('- '));
  assert.ok(bullets.length > 0);
  for (const bullet of bullets) {
    assert.ok(declared.includes(bullet.slice(2)), `viñeta no declarada: ${bullet}`);
  }
  // Y los huecos se marcan en vez de rellenarse.
  assert.match(letter, /\[TO COMPLETE: join into prose; do not add figures or claims that are not above\]/);
  assert.match(letter, /No application or message has been sent/);
  // La carta entera está en inglés: ni el bloque de confirmaciones mete español.
  assert.equal(/[áéíóúÁÉÍÓÚñ]/.test(letter.replace(/Bogotá/g, 'Bogota')), false, 'la carta no mezcla idiomas');
  assert.equal(letter, renderCoverLetterDraft({ facts, opportunity: job(), profile, matched, selected }), 'determinista');
});

test('los logros se eligen por lo que la oferta pide y se copian sin reescribir', () => {
  const selected = selectAchievements(facts, ['n8n', 'llm', 'python']);
  assert.ok(selected.length <= MAX_ACHIEVEMENTS);
  // El que menciona n8n gana al que no menciona nada de la oferta.
  assert.match(selected[0]!.achievement, /n8n/);
  assert.deepEqual(selected[0]!.matched, ['n8n']);
  // Literal, carácter por carácter.
  for (const item of selected) {
    assert.ok(facts.experience!.some(e => e.achievements.includes(item.achievement)), 'el logro es texto del CV');
  }
  // Sin nada que coincida sigue ofreciendo evidencia real: mejor floja que un párrafo vacío.
  const sinCoincidencias = selectAchievements(facts, ['kubernetes']);
  assert.ok(sinCoincidencias.length > 0);
  assert.deepEqual(sinCoincidencias[0]!.matched, []);
  // Y un perfil sin experiencia declarada no inventa ninguna.
  assert.deepEqual(selectAchievements(parseCandidateFacts({ schemaVersion: 2, name: 'X', skills: [], highlights: [] }), ['n8n']), []);
});

test('el bloque "Before sending" se calcula de los huecos del registro, no se escribe a mano', () => {
  // Las cartas escritas a mano llevaban una lista fija, así que repetía lo ya confirmado y omitía
  // lo que faltaba. Y reutiliza las mismas funciones que redactan el digest, para que los dos no
  // puedan contradecirse sobre la misma oferta.
  const sinNada = beforeSending(job(), profile);
  assert.deepEqual(sinNada.map(c => c.item), ['confirm compensation', 'confirm work authorisation and sponsorship',
    'confirm location and working model', 'confirm the listing is still open']);
  // El `item` va en INGLÉS, como la carta. El detalle —que es la redacción del digest, en español—
  // se queda en el informe: mezclar idiomas dentro del documento que se envía es un accidente fácil.
  assert.equal(/[áéíóúñ]/i.test(sinNada.map(c => c.item).join(' ')), false, 'ni una palabra en español en la carta');
  assert.match(sinNada[0]!.detail!, /Salario no publicado/, 'el detalle sí conserva la redacción del digest');

  // Con los tres datos publicados, solo queda el que NINGUNA comprobación previa sustituye.
  const quote = 'We sponsor work visas for this role.';
  const completa = job({
    description: `Build n8n workflows. ${quote}`,
    payDisclosure: 'published', compensation: { currency: 'USD', period: 'month', min: 7000 },
    remoteness: 'fully_remote',
    sponsorship: { status: 'stated', scope: 'unspecified', evidence: { kind: 'description_phrase', source: 'test', quote, observedAt: '2026-09-30T00:00:00Z' } },
  });
  assert.deepEqual(beforeSending(completa, profile).map(c => c.item), ['confirm the listing is still open'],
    'la evidencia de disponibilidad vence en 24 h: siempre hay que mirar la página');
});

test('el CV reordena habilidades y logros, pero NUNCA la cronología ni los puestos', () => {
  const matched = ['llm', 'rag', 'mcp'];
  const cv = renderTailoredCv({ facts, opportunity: job(), profile, matched, selected: selectAchievements(facts, matched) });
  // El grupo con más coincidencias va primero, aunque en los hechos esté declarado después.
  assert.ok(cv.indexOf('AI & agents') < cv.indexOf('Robotics'), 'el grupo que la oferta pide va arriba');
  // La cronología NO se toca: borrar o mover un puesto falsea la línea de tiempo.
  assert.ok(cv.indexOf('Dynapro Pumps') < cv.indexOf('Teleperformance'), 'del presente al pasado, siempre');
  for (const entry of facts.experience!) assert.ok(cv.includes(entry.company), `${entry.company} no puede desaparecer`);
  for (const entry of facts.experience!) for (const a of entry.achievements) assert.ok(cv.includes(a), 'ningún logro se recorta');
  // Las fechas usan guión SIMPLE, nunca `--`: LaTeX convierte `--` en guión largo U+2013, y un ATS
  // que descarta no-ASCII transforma "2019–2026" en "20192026". Medido el 2026-09-30.
  assert.match(cv, /2026-01 - present/);
  assert.equal(/[–—]/.test(cv), false, 'ni un guión largo en todo el documento');
  // Y la evidencia del idioma viaja: "C1" es una afirmación, el IELTS con vigencia es un hecho.
  assert.match(cv, /IELTS, British Council; valid 07\/2025-07\/2028/);
  assert.equal(cv, renderTailoredCv({ facts, opportunity: job(), profile, matched, selected: [] }), 'el CV no depende de los logros elegidos, solo de lo hallado');
});
