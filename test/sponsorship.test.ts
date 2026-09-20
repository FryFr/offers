import test from 'node:test';
import assert from 'node:assert/strict';
import { sponsorshipFromDescription } from '../src/sponsorship.ts';
import { normalizeCompany, parseRegisterCsv, matchesRegister, registerIndex, splitCsvLine } from '../src/uk-sponsors.ts';
import { parseOpportunity } from '../src/contracts.ts';

const observedAt = '2026-09-20T00:00:00Z';
const read = (description: string) => sponsorshipFromDescription(description, observedAt);

test('patrocinio: casos reales medidos en ofertas de producción', () => {
  // Todos estos textos provienen de descripciones reales capturadas el 2026-09-20. Una lista de
  // frases sueltas clasificaba mal la mitad: "visa sponsorship" aparece tanto en la promesa como
  // en la negativa, y "sponsor" a secas aparece en contextos que nada tienen que ver con visados.
  const casos: [string, string | undefined][] = [
    // Afirma y luego matiza: sigue siendo una empresa que patrocina.
    ['Visa sponsorship: We do sponsor visas! However, we aren\'t able to successfully sponsor visas for every role and every candidate.', 'stated'],
    // La misma frase "visa sponsorship", significado opuesto.
    ['Candidates must be authorized to work in the United States; visa sponsorship is not available for this role.', 'stated_none'],
    ['We are not able to sponsor visas for this position.', 'stated_none'],
    ['Applicants must be authorized to work in the United States without sponsorship.', 'stated_none'],
    ['We are a licensed sponsor and can sponsor a Skilled Worker visa for the right candidate.', 'stated'],
    // Un encabezado de sección no es ni promesa ni negativa.
    ['Visa sponsorship. About the team: we build things.', undefined],
    // "sponsor" en su acepción de negocios, no migratoria.
    ['Develop deep, strategic (not transactional) relationships with partners — joint business plans, QBRs, and named executive sponsors.', undefined],
    ['We are not a sponsor of this conference, but we do sponsor community meetups.', undefined],
    // Ayuda para mudarse no es permiso de trabajo: prometerlo sería inventar.
    ['We offer a generous relocation package for candidates moving to our office.', undefined],
    // Boilerplate legal con una negación que no recae sobre el patrocinio.
    ['This information is collected solely for immigration compliance purposes and will be not used as a criterion in any hiring decision.', undefined],
    ['We offer great benefits and a flexible schedule.', undefined],
  ];
  for (const [description, expected] of casos) {
    assert.equal(read(description)?.status, expected, description.slice(0, 60));
  }
});

test('patrocinio: la cita es literal, está centrada en la mención y fija el alcance', () => {
  const description = 'About us. '.repeat(30) + 'We can sponsor a Skilled Worker visa. ' + 'More text. '.repeat(30);
  const signal = read(description)!;
  assert.equal(signal.status, 'stated');
  assert.equal(signal.scope, 'uk_skilled_worker');
  assert.ok(description.includes(signal.evidence.quote), 'la cita debe existir literalmente en la descripción');
  assert.ok(signal.evidence.quote.includes('Skilled Worker visa'), 'la cita se centra en la mención, no en el inicio del texto');
  assert.ok(signal.evidence.quote.length < description.length, 'no se guarda la descripción entera');
  assert.equal(read('We will sponsor an H-1B for the right candidate.')?.scope, 'us_h1b');
  assert.equal(read('We will sponsor your EU Blue Card.')?.scope, 'eu');
  // Precisión sobre cobertura: "apoyar una solicitud" no es patrocinarla, y el módulo no
  // convierte una ayuda con el papeleo en una promesa de permiso de trabajo.
  assert.equal(read('We support Blue Card applications for candidates who relocate.'), undefined);
});

test('el contrato exige que la cita aparezca en la descripción', () => {
  const base = { title: 'Engineer', company: 'Acme', skills: [], description: 'We can sponsor a work permit.' };
  const evidence = { kind: 'description_phrase', source: 'affirms_sponsorship_near_mention', observedAt };
  assert.ok(parseOpportunity({ ...base, sponsorship: { status: 'stated', evidence: { ...evidence, quote: 'We can sponsor a work permit.' } } }).sponsorship);
  // Una cita inventada no puede entrar al store: la procedencia dejaría de significar nada.
  assert.throws(() => parseOpportunity({ ...base, sponsorship: { status: 'stated', evidence: { ...evidence, quote: 'We sponsor everyone always.' } } }), /no aparece en la descripción/);
  // Un match de registro no cita la descripción: su procedencia es otra.
  assert.ok(parseOpportunity({ ...base, sponsorship: { status: 'employer_registered', evidence: { kind: 'registry_match', source: 'uk_register_of_licensed_sponsors', quote: 'Acme', observedAt } } }).sponsorship);
  assert.throws(() => parseOpportunity({ ...base, sponsorship: { status: 'maybe', evidence: { ...evidence, quote: 'We can sponsor a work permit.' } } }));
});

test('registro UK: CSV con comillas, ruta filtrada y nombres normalizados', () => {
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('"he said ""hi""",x'), ['he said "hi"', 'x']);
  assert.equal(normalizeCompany('Acme Technologies Ltd.'), 'acme technologies');
  assert.equal(normalizeCompany('Fígma, Inc'), 'figma');
  const csv = [
    'Organisation Name,Town/City,County,Type & Rating,Route',
    'Acme Robotics Ltd,London,,Worker (A rating),Skilled Worker',
    '"Bolt, Systems Limited",Manchester,,Worker (A rating),Skilled Worker',
    'Temporary Only Co,Leeds,,Temporary Worker,Creative Worker',
    'ABC,London,,Worker (A rating),Skilled Worker',
  ].join('\n');
  const register = parseRegisterCsv(csv, observedAt, 'https://example.test/register.csv');
  // Solo la ruta Skilled Worker; "ABC" se descarta por corto: coincidiría por azar.
  assert.deepEqual(register.organisations, ['acme robotics', 'bolt systems']);
  assert.throws(() => parseRegisterCsv('Nombre,Otro\nx,y', observedAt, 'u'), /register_header_unexpected/);
  assert.throws(() => parseRegisterCsv('Organisation Name,Route\nx,Creative Worker', observedAt, 'u'), /register_empty/);
});

test('registro UK: el cruce exige ubicación británica y nombre exacto, nunca difuso', () => {
  const index = registerIndex({ organisations: ['acme robotics', 'figma'] });
  assert.equal(matchesRegister('Acme Robotics Ltd', 'London, England', index), true);
  assert.equal(matchesRegister('Figma', 'London', index), true);
  // Sin ubicación británica el registro no aplica: patrocinar en UK no habilita un puesto en Berlín.
  assert.equal(matchesRegister('Figma', 'Berlin, Germany', index), false);
  assert.equal(matchesRegister('Figma', undefined, index), false);
  // Nunca difuso: un prefijo o un nombre parecido no es la misma empresa.
  assert.equal(matchesRegister('Acme', 'London', index), false);
  assert.equal(matchesRegister('Acme Robotics Group International', 'London', index), false);
  // Nombres genéricos quedan fuera aunque estén en el registro: dirían más del diccionario.
  assert.equal(matchesRegister('Global', 'London', registerIndex({ organisations: ['global'] })), false);
});
