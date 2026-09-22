import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { relevance } from '../src/relevance.ts';
import { canonical, contains, matchedTerms } from '../src/text.ts';
import { readFile } from 'node:fs/promises';

const profile = parseProfile({
  skills: ['typescript', 'node.js', 'postgresql'],
  relevance: {
    roleTerms: ['software engineer', 'backend engineer', 'developer'],
    roleExcludedTerms: ['account executive', 'sales', 'recruiter'],
    skillAliases: { 'node.js': ['node', 'nodejs'], postgresql: ['postgres'] },
    relocationTargets: ['germany', 'berlin', 'united states', 'new york'],
    dailyTarget: 10,
  },
});
const job = (overrides: Partial<Opportunity> = {}): Opportunity => parseOpportunity({ title: 'Software Engineer', company: 'Acme', skills: [], ...overrides });
const score = (overrides: Partial<Opportunity> = {}) => relevance(job(overrides), profile, 'employment');

test('normalización comparte una sola implementación y exige límites de palabra', () => {
  assert.equal(canonical('Señor Full-Stack Developer'), 'senor full stack developer');
  assert.equal(canonical('Node.js  /  TypeScript'), 'node js typescript');
  // Sin límites de palabra, "lead" coincidiría dentro de "leadership" y "go" dentro de "google".
  assert.equal(contains('leadership program', 'lead'), false);
  assert.equal(contains('google cloud', 'go'), false);
  assert.equal(contains('tech lead wanted', 'lead'), true);
  assert.equal(contains('anything', ''), false);
  assert.deepEqual(matchedTerms('senior backend engineer', ['backend engineer', 'sales', 'engineer']), ['backend engineer', 'engineer']);
});

test('rol: el título pesa más que la descripción y la exclusión solo aplica al título', () => {
  const soloTitulo = score({ title: 'Backend Engineer' });
  const soloDescripcion = score({ title: 'Builder', description: 'You will work as a software engineer on our team.' });
  assert.ok(soloTitulo.score > soloDescripcion.score, 'el título declara el puesto; la descripción solo lo menciona');
  assert.deepEqual(soloTitulo.roleMatched, ['backend engineer']);
  // Una vacante de backend puede mencionar al equipo de ventas sin dejar de ser de backend.
  const mencionaVentas = score({ title: 'Backend Engineer', description: 'Partner with the sales team on integrations.' });
  assert.deepEqual(mencionaVentas.blockers, []);
  const esVentas = score({ title: 'Enterprise Account Executive' });
  assert.deepEqual(esVentas.blockers, ['role_off_target']);
  assert.equal(esVentas.tier, 'off_target');
});

test('seniority: junior bloquea, senior puntúa y su ausencia es neutra, no baja', () => {
  for (const title of ['Software Engineer Intern', 'Junior Developer', 'Backend Engineer (Graduate)']) {
    assert.ok(relevance(job({ title }), profile, 'employment').blockers.includes('seniority_below_floor'), title);
  }
  const senior = score({ title: 'Staff Software Engineer' });
  const neutro = score({ title: 'Software Engineer' });
  assert.ok(senior.score > neutro.score);
  assert.equal(neutro.blockers.length, 0, 'muchas vacantes senior reales no llevan la palabra en el título');
  assert.ok(senior.signals.some(s => s.evidence?.includes('Staff Software Engineer')), 'la señal cita el texto literal');
});

test('habilidades: coinciden por alias contra el texto, no por igualdad exacta contra skills[]', () => {
  // Los adaptadores escriben skills: [] para todo lo ingestado: sin texto libre el puntaje sería 0.
  const conAlias = score({ description: 'We use Node and Postgres in production with TypeScript.' });
  assert.deepEqual(conAlias.skillsMatched.sort(), ['node', 'postgres', 'typescript']);
  const sinNada = score({ description: 'We use Java and Oracle.' });
  assert.deepEqual(sinNada.skillsMatched, []);
  assert.ok(conAlias.score > sinNada.score);
  // Un perfil sin habilidades declaradas recibe un valor neutro, no cero.
  const sinPerfil = relevance(job({ description: 'We use Java.' }), parseProfile({ relevance: { roleTerms: ['software engineer'] } }), 'employment');
  assert.ok(sinPerfil.signals.some(s => s.reason.includes('neutro')));
});

test('geografía: distingue remoto abierto, remoto restringido, presencial en destino y presencial fuera', () => {
  const casos: [Partial<Opportunity>, string | undefined][] = [
    [{ remote: true, location: 'Worldwide' }, undefined],
    [{ remote: true, location: 'Remote - Latin America' }, undefined],
    [{ remote: true, location: 'Remote' }, undefined],
    // Un remoto restringido a una región exige residir allá y no ofrece visado: inaplicable.
    [{ remote: true, location: 'Remote - United States' }, 'remote_region_excluded'],
    [{ location: 'Remote, Canada' }, 'remote_region_excluded'],
    // La restricción se detecta aunque la región NO sea un destino deseado.
    [{ location: 'Remote - India' }, 'remote_region_excluded'],
    // Presencial en destino de migración sigue vivo: ahí es donde vive el sponsorship.
    [{ location: 'Berlin, Germany' }, undefined],
    [{ location: 'New York, NY' }, undefined],
    [{ location: 'Bogotá, Colombia' }, 'onsite_outside_relocation_targets'],
    [{ location: 'Bengaluru, India' }, 'onsite_outside_relocation_targets'],
    // Híbrido es presencial: exige vivir en la ciudad.
    [{ remote: true, location: 'Hybrid - Bogotá' }, 'onsite_outside_relocation_targets'],
  ];
  for (const [overrides, expected] of casos) {
    const result = score(overrides);
    assert.equal(result.blockers.find(b => b.startsWith('remote_') || b.startsWith('onsite_')), expected, JSON.stringify(overrides));
  }
  // Sin ubicación ni modalidad no se infiere nada: puntaje neutro y ningún bloqueo.
  assert.deepEqual(score({}).blockers, []);
  // Un puesto remoto abierto vale más que uno presencial en destino de reubicación.
  assert.ok(score({ remote: true, location: 'Worldwide' }).score > score({ location: 'Berlin, Germany' }).score);
});

test('tiers: un bloqueo manda sobre el puntaje y la escala es monótona', () => {
  const fuerte = score({ title: 'Senior Software Engineer', description: 'TypeScript, Node and Postgres.', remote: true, location: 'Worldwide' });
  assert.equal(fuerte.tier, 'strong');
  assert.ok(fuerte.score >= 65);
  const posible = score({ title: 'Software Engineer', description: 'TypeScript codebase', remote: true, location: 'Remote' });
  assert.equal(posible.tier, 'possible');
  // Sin descripción, las habilidades no pueden coincidir y el techo baja: un board configurado
  // con `fetchContent:false` queda estructuralmente por debajo de uno que sí la entrega.
  const sinDescripcion = score({ title: 'Software Engineer', remote: true, location: 'Remote' });
  assert.equal(sinDescripcion.tier, 'weak');
  assert.ok(sinDescripcion.score < posible.score);
  const flojo = score({ title: 'Analyst', location: 'Berlin, Germany' });
  assert.equal(flojo.tier, 'weak');
  // Un puntaje alto no rescata una vacante bloqueada.
  const bloqueada = score({ title: 'Senior Software Engineer, Sales Platform', description: 'TypeScript, Node and Postgres.', remote: true, location: 'Worldwide' });
  assert.ok(bloqueada.score >= 65);
  assert.equal(bloqueada.tier, 'off_target');
});

test('los campos estructurados del proveedor mandan sobre lo que insinúa el texto', () => {
  // `remoteness` declarado gana al texto: un título que diga "Remote" no convierte en remoto
  // una vacante que el proveedor marcó híbrida.
  const hibrida = relevance(job({ title: 'Remote Software Engineer', remoteness: 'hybrid', location: 'Bogotá' }), profile, 'employment');
  assert.ok(hibrida.blockers.includes('onsite_outside_relocation_targets'));
  const remota = relevance(job({ remoteness: 'fully_remote' }), profile, 'employment');
  assert.deepEqual(remota.blockers, []);
  // `partially_remote` también exige vivir cerca: no es remoto.
  assert.ok(relevance(job({ remoteness: 'partially_remote', location: 'Bogotá' }), profile, 'employment').blockers.includes('onsite_outside_relocation_targets'));
  // Las restricciones declaradas se leen igual que si vinieran en el texto de ubicación.
  assert.ok(relevance(job({ remoteness: 'fully_remote', locationRestrictions: ['United States'] }), profile, 'employment').blockers.includes('remote_region_excluded'));
  // `seniority` declarada gana al regex del título.
  const declaradaJunior = relevance(job({ title: 'Senior Software Engineer', seniority: ['junior'] }), profile, 'employment');
  assert.ok(declaradaJunior.blockers.includes('seniority_below_floor'));
  const declaradaStaff = relevance(job({ title: 'Software Engineer', seniority: ['staff'] }), profile, 'employment');
  assert.ok(declaradaStaff.score > relevance(job({ title: 'Software Engineer' }), profile, 'employment').score);
});

test('relevance no muta la oportunidad ni el perfil', () => {
  const opportunity = job({ title: 'Senior Backend Engineer', description: 'Node and TypeScript', location: 'Berlin, Germany' });
  const before = JSON.stringify({ opportunity, profile });
  relevance(opportunity, profile, 'employment');
  assert.equal(JSON.stringify({ opportunity, profile }), before);
});

test('el perfil real no usa alias que sean palabras corrientes en inglés', async () => {
  // Medido el 2026-09-20 sobre 3.464 ofertas reales: el alias "go" coincidía en 1.138 (33%)
  // frente a 24 de "golang" — no era el lenguaje, era "go to", "go live", "let's go". Igual
  // "next" (756 vs 100 de "next.js"), "api" (343) y "rest" (129, por "rest of the team").
  // Un alias corriente infla el puntaje de habilidades de un tercio del pool y corrompe el orden.
  const real = parseProfile(JSON.parse(await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8')));
  // La regla cubre las DOS listas. Una palabra corriente entre las secundarias infla el bono en
  // medio pool exactamente igual que una entre las del núcleo infla el puntaje.
  const variants = new Set([...real.skills, ...real.secondarySkills, ...Object.values(real.relevance.skillAliases).flat()]);
  // `express` ("express interest", "express delivery") y `render` ("render services") entran por
  // la misma puerta que `go` y `next`: se declaran como `express.js` y `render.com`.
  for (const dangerous of ['go', 'next', 'api', 'rest', 'ts', 'ai', 'ml', 'it', 'express', 'render']) {
    assert.ok(!variants.has(dangerous), `"${dangerous}" es una palabra corriente: usar la forma inequívoca`);
  }
  // La forma inequívoca sí debe estar, o se perdería la señal por completo.
  assert.ok(variants.has('golang') && variants.has('next.js') && variants.has('restful'));
});

test('el perfil rechaza claves desconocidas y valores inválidos en relevance', () => {
  assert.throws(() => parseProfile({ relevance: { roleTerm: ['typo'] } }), /clave desconocida/);
  assert.throws(() => parseProfile({ relevance: { dailyTarget: 0 } }));
  assert.throws(() => parseProfile({ relevance: { dailyTarget: 2.5 } }));
  assert.throws(() => parseProfile({ relevance: { skillAliases: { node: 'not-a-list' } } }));
  assert.throws(() => parseProfile({ relevance: { roleTerms: 'not-a-list' } }));
  assert.throws(() => parseProfile({ relevance: { roleTerms: { robotics: [] } } }), /familia vacía/);
  // Sin sección relevance el perfil sigue siendo válido y no bloquea nada.
  const plain = parseProfile({});
  assert.deepEqual(plain.relevance.roleFamilies, {});
  assert.equal(relevance(job(), plain, 'employment').blockers.length, 0);
});

test('el rol se puntúa contra la familia que mejor coincide, no contra la unión', () => {
  // Tres familias en una sola bolsa hacían que casi cualquier título de ingeniería tocara el
  // techo de 40 y el componente dejara de separar una vacante de otra.
  const multi = parseProfile({
    skills: ['typescript'],
    relevance: {
      roleTerms: {
        ai_automation: ['ai engineer', 'automation engineer', 'llm engineer'],
        robotics: ['robotics engineer', 'control engineer'],
        management: ['engineering manager', 'tech lead'],
      },
    },
  });
  const familyOf = (title: string) => relevance(job({ title }), multi, 'employment').roleFamily;
  assert.equal(familyOf('Senior AI Engineer'), 'ai_automation');
  assert.equal(familyOf('Robotics Engineer'), 'robotics');
  assert.equal(familyOf('Engineering Manager'), 'management');
  // Sin coincidencia no se inventa familia: elegir una a ciegas mandaría el currículum equivocado.
  assert.equal(familyOf('Pastry Chef'), '');

  // Un título que toca DOS familias no suma los puntos de ambas: gana la mejor, y el techo sigue
  // siendo 40 por familia, no 40 por la unión.
  const mixed = relevance(job({ title: 'Robotics Engineer and Engineering Manager' }), multi, 'employment');
  const rolePoints = mixed.signals[0]!.points;
  assert.equal(rolePoints, 20);
  assert.ok(['robotics', 'management'].includes(mixed.roleFamily));
});

test('una lista plana de roleTerms sigue puntuando igual que antes de las familias', () => {
  // Retrocompatibilidad: la migración de contrato no debe mover ningún ranking existente.
  const flat = relevance(job({ title: 'Backend Engineer' }), profile, 'employment');
  assert.equal(flat.roleFamily, 'default');
  assert.ok(flat.score > 0);
  assert.deepEqual(parseProfile({ relevance: { roleTerms: ['a', 'b'] } }).relevance.roleFamilies, { default: ['a', 'b'] });
});

test('una habilidad secundaria suma cuando la oferta la pide y nunca resta cuando no', () => {
  const base = { skills: ['typescript'], relevance: { roleTerms: ['software engineer'] } };
  const sinSecundarias = parseProfile(base);
  const conSecundarias = parseProfile({ ...base, secondarySkills: ['kubernetes', 'terraform', 'golang'] });
  const ajena = job({ description: 'We build products with typescript.' });

  // LA ASIMETRÍA: sin rastro de lo secundario en el texto, el puntaje es IDÉNTICO. Sin esto,
  // declarar honestamente todo lo que uno sabe bajaba el puntaje de todas las ofertas.
  assert.equal(relevance(ajena, conSecundarias, 'employment').score, relevance(ajena, sinSecundarias, 'employment').score);

  const propia = job({ description: 'typescript, kubernetes, terraform and golang.' });
  assert.ok(relevance(propia, conSecundarias, 'employment').score > relevance(propia, sinSecundarias, 'employment').score);
  assert.deepEqual(relevance(propia, conSecundarias, 'employment').secondaryMatched, ['kubernetes', 'terraform', 'golang']);
});

test('el bono secundario es proporcional, no una constante que deja de discriminar', () => {
  // Con una lista secundaria larga, un bono min(5, coincidentes) se satura en casi toda oferta.
  const skills = Array.from({ length: 40 }, (_, i) => `skill${i}`);
  const p = parseProfile({ skills: ['typescript'], secondarySkills: skills, relevance: { roleTerms: ['software engineer'] } });
  const bonoDe = (n: number) => {
    const r = relevance(job({ description: `typescript ${skills.slice(0, n).join(' ')}` }), p, 'employment');
    return r.signals.find(s => s.reason.startsWith('Habilidades secundarias'))!.points;
  };
  assert.ok(bonoDe(2) < bonoDe(12), 'dos coincidencias no pueden valer lo mismo que doce');
  assert.equal(bonoDe(0), 0);
  assert.equal(bonoDe(30), 5, 'el bono está acotado y nunca compra un strong por sí solo');
});

test('cada alias declarado en el perfil real coincide de verdad con su habilidad', async () => {
  // Un alias con guiones, mayúsculas o espacios de más no coincide nunca y apaga la señal en
  // silencio: hoy nada lo detectaría hasta que alguien midiera por qué bajó el corte.
  const real = parseProfile(JSON.parse(await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8')));
  const declaradas = new Set([...real.skills, ...real.secondarySkills]);
  for (const [skill, aliases] of Object.entries(real.relevance.skillAliases)) {
    assert.ok(declaradas.has(skill), `alias huérfano: "${skill}" no está en skills ni en secondarySkills`);
    for (const alias of aliases) {
      const r = relevance(job({ description: `We use ${alias} every day.` }), real, 'employment');
      const hallado = [...r.skillsMatched, ...r.secondaryMatched];
      // Se comprueba que la habilidad SE DETECTE, no con qué etiqueta: skillHit devuelve el primer
      // variante que coincide, que a menudo es la forma canónica y no el alias que disparó.
      assert.ok(hallado.includes(alias) || hallado.includes(skill), `el alias "${alias}" de "${skill}" no detecta la habilidad`);
    }
  }
});

test('ningún término de rol del perfil real colisiona con una familia excluida', async () => {
  const real = parseProfile(JSON.parse(await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8')));
  for (const [family, terms] of Object.entries(real.relevance.roleFamilies)) {
    for (const term of terms) {
      assert.deepEqual(matchedTerms(canonical(term), real.relevance.roleExcludedTerms), [],
        `"${term}" (familia ${family}) cae en roleExcludedTerms: la familia entera quedaría off_target`);
    }
  }
});
