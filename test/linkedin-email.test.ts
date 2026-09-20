import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLinkedInJobAlert, parseLinkedInEmail } from '../src/linkedin-email.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/linkedin/${name}`, import.meta.url), 'utf8');
const htmlMail = (body: string) => `From: jobs@linkedin.com\nSubject: Job alert\nContent-Type: text/html; charset=utf-8\n\n${body}`;
const fields = (raw: string) => {
  const result = parseLinkedInEmail(raw);
  assert.equal(result.status, 'parsed');
  return result.envelope.alerts.map(({ title, company, location }) => ({ title, company, location }));
};

test('newsletter de LinkedIn con palabras de empleo se ignora (regresión 123923)', () => {
  const raw = fixture('newsletter.eml');
  const result = parseLinkedInEmail(raw);
  assert.equal(result.status, 'ignored');
  assert.deepEqual(result.envelope.alerts, []);
  assert.equal(isLinkedInJobAlert('LinkedIn <NEWSLETTERS-NOREPLY@LINKEDIN.COM>', 'Job alert', 'hiring'), false);
  assert.equal(parseLinkedInEmail('hiring', { from: 'newsletters-noreply@linkedin.com' }).status, 'ignored');
  // The same unsupported content from the job sender must still fail parsing.
  assert.equal(parseLinkedInEmail(raw.replace('newsletters-noreply@', 'jobs-noreply@')).status, 'unrecognized');
});

test('correo real reducido: MIME plain no hereda heurísticas HTML, separadores ni salario', () => {
  assert.deepEqual(fields(fixture('real-reduced.eml')), [
    { title: 'Robotics Engineer Intern - Test & Validation', company: 'Contoro Robotics', location: 'Austin, TX' },
    { title: 'Robotics Engineer', company: 'CTDI', location: 'West Chester, PA' },
    { title: 'Senior Fullstack AI Developer (Python + React)', company: 'Devsu', location: 'Perú' },
  ]);
});

test('tarjeta HTML: título enlazado seguido de compañía y ubicación', () => {
  assert.deepEqual(fields(htmlMail(fixture('card.html'))), [
    { title: 'Automation Engineer', company: 'Example Robotics', location: 'Bogotá (Remoto)' },
  ]);
});

test('badge de contactos en digest MIME quoted-printable (regresión 123862)', () => {
  const raw = fixture('contact-badge.eml');
  const expected = [
    { title: 'TÉCNICO/A MECATRÓNICO', company: 'Example Robotics', location: 'Madrid',
      url: 'https://www.linkedin.com/jobs/view/4001', externalId: '4001', source: 'linkedin', kind: 'employment' },
    { title: 'Robotics Engineer', company: 'Example Engineering', location: 'Polonia',
      url: 'https://www.linkedin.com/jobs/view/4002', externalId: '4002', source: 'linkedin', kind: 'employment' },
  ];
  for (const badge of ['1 contacto', '2 contactos', '10 contactos']) {
    const result = parseLinkedInEmail(raw.replace('1 contacto', badge));
    assert.equal(result.status, 'parsed');
    assert.deepEqual(result.envelope.alerts, expected);
  }
  for (const invalid of [
    raw.replace('1 contacto', '1 contacto y otro dato'),
    raw.replace('1 contacto', '2 contactos adicionales'),
    raw.replace('1 contacto', '1 contacto\nUnknown extra field'),
    raw.replace('Example Robotics\n', ''),
    raw.replace('Madrid\n', ''),
    raw.replace('Polonia\n', ''),
  ]) {
    const result = parseLinkedInEmail(invalid);
    assert.equal(result.status, 'unrecognized');
    assert.deepEqual(result.envelope.alerts, []);
  }
});

test('alerta con badge de institución educativa (regresión 123902)', () => {
  const raw = fixture('alumni-badge.eml');
  const result = parseLinkedInEmail(raw);
  assert.equal(result.status, 'parsed');
  assert.deepEqual(result.envelope.alerts, [
    { title: 'Automation Engineer', company: 'Example Robotics', location: 'Madrid',
      url: 'https://www.linkedin.com/jobs/view/3001', externalId: '3001', source: 'linkedin', kind: 'employment' },
    { title: 'AI Engineer', company: 'Example Software', location: 'España',
      url: 'https://www.linkedin.com/jobs/view/3002', externalId: '3002', source: 'linkedin', kind: 'employment' },
  ]);
  for (const invalid of [
    raw.replace('3 personas estudiaron en la misma institución educativa que tú', '3 personas estudiaron en otra institución educativa'),
    raw.replace('que tú\n', 'que tú y otro dato\n'),
    raw.replace('que tú\n', 'que tú\nUnknown extra field\n'),
    raw.replace('Example Software\n', ''),
    raw.replace('España\n', ''),
  ]) {
    const rejected = parseLinkedInEmail(invalid);
    assert.equal(rejected.status, 'unrecognized');
    assert.deepEqual(rejected.envelope.alerts, []);
  }
});

test('HTML real reducido: anchors anidados, logo duplicado y enlace global', () => {
  assert.deepEqual(fields(htmlMail(fixture('global-link.html'))), [
    { title: 'Robotics Engineer', company: 'Example Robotics', location: 'Austin, TX (Presencial)' },
  ]);
});

test('rechaza tarjetas ambiguas e incompletas y URLs de búsqueda como campos', () => {
  const bodies = [
    '<div><a href="https://www.linkedin.com/jobs/view/1">Engineer</a><p>Company</p><a href="https://www.linkedin.com/jobs/search/">Ver todos los empleos</a></div>',
    '<div><a href="https://www.linkedin.com/jobs/view/1">Engineer</a><p>Company</p><p>https://www.linkedin.com/jobs/search/</p></div>',
    '<div><a href="https://www.linkedin.com/jobs/view/1">Engineer</a><p>Company</p><p>City</p><p>Unknown extra field</p></div>',
    '<div><a href="https://www.linkedin.com/jobs/view/1">Engineer</a><p>-----</p><p>City</p></div>',
  ];
  for (const body of bodies) {
    const result = parseLinkedInEmail(htmlMail(body));
    assert.equal(result.status, 'unrecognized');
    assert.deepEqual(result.envelope.alerts, []);
  }
  for (const key of ['Title', 'Company', 'Location']) {
    const raw = `Subject: Job alert\n\nTitle: Engineer\nCompany: Example\nLocation: City\nhttps://www.linkedin.com/jobs/view/1`
      .replace(new RegExp(`${key}: [^\\n]+`), `${key}: https://www.linkedin.com/jobs/search/`);
    assert.equal(parseLinkedInEmail(raw).status, 'unrecognized');
  }
});

test('varias tarjetas HTML no mezclan campos y canonicalizan URLs', () => {
  const first = fixture('card.html').replaceAll('/2001', '/2001?tracking=synthetic');
  const second = fixture('card.html').replaceAll('/2001', '/2002').replace('Automation Engineer', 'Test Engineer');
  const result = parseLinkedInEmail(htmlMail(first + second));
  assert.equal(result.status, 'parsed');
  assert.deepEqual(result.envelope.alerts.map(a => a.title), ['Automation Engineer', 'Test Engineer']);
  assert.deepEqual(result.envelope.alerts.map(a => a.url), ['https://www.linkedin.com/jobs/view/2001', 'https://www.linkedin.com/jobs/view/2002']);
});

test('texto plano ambiguo o campos explícitos contradictorios se rechazan', () => {
  for (const body of [
    'Engineer\nCompany\nCity\nUnknown extra field',
    'Title: Engineer\nCompany: Example\nLocation: City\nUbicación: Elsewhere',
    'Title: Engineer\nCompany: Example\nEmpresa: Other\nLocation: City',
  ]) {
    const result = parseLinkedInEmail(`Subject: Job alert\n\n${body}\nhttps://www.linkedin.com/jobs/view/1`);
    assert.equal(result.status, 'unrecognized');
    assert.deepEqual(result.envelope.alerts, []);
  }
});

// Reduced from local samples: retain the failing plain-text cards and MIME
// encoding, omit recipient headers/footer/HTML, and replace IDs and tracking.
test('digest con salario por hora (regresión 123709)', () => {
  const raw = fixture('sample-123709.eml');
  assert.deepEqual(fields(raw), [
    { title: 'Robotics Mechanical Engineer', company: 'Unitec SpA', location: 'Lugo' },
    { title: 'Automation Intern', company: 'Link Snacks', location: 'Minong, WI' },
  ]);
  for (const changed of [
    raw.replace('/ hora', '/ hora y otro dato'),
    raw.replace('/ hora', '/ hora\nUnknown extra field'),
    raw.replace('Link Snacks\n', ''),
    raw.replace('Minong, WI\n', ''),
  ]) {
    const result = parseLinkedInEmail(changed);
    assert.equal(result.status, 'unrecognized');
    assert.deepEqual(result.envelope.alerts, []);
  }
});

test('digest con badge singular de institución (regresión 123635)', () => {
  const raw = fixture('sample-123635.eml');
  assert.deepEqual(fields(raw), [
    { title: 'Co-Op/Intern - Mechanical Engineer', company: 'AutoStore™', location: 'Atlanta, GA' },
    { title: 'Intern - Engineering', company: 'Tarkett', location: 'Dalton, GA' },
  ]);
  for (const changed of [
    raw.replace('1 persona', '2 persona'),
    raw.replace('1 persona', '1 persona adicional'),
    raw.replace('1 persona', 'Unknown extra field\n1 persona'),
    raw.replace('Tarkett\n', ''),
    raw.replace('Dalton, GA\n', ''),
  ]) {
    const result = parseLinkedInEmail(changed);
    assert.equal(result.status, 'unrecognized');
    assert.deepEqual(result.envelope.alerts, []);
  }
});

test('digest con recuento introductorio (regresión 123365)', () => {
  const raw = fixture('sample-123365.eml');
  const result = parseLinkedInEmail(raw);
  assert.equal(result.status, 'parsed');
  assert.deepEqual(result.envelope.alerts, [{
    title: 'Automation & Intralogistics Solutions Specialist', company: 'KION Group EMEA', location: 'Barcelona',
    url: 'https://www.linkedin.com/jobs/view/5050', externalId: '5050', source: 'linkedin', kind: 'employment',
  }]); // Neither the count nor the subject's ambiguous date supplies job metadata.
  for (const changed of [
    raw.replace('preferencias.', 'preferencias. Otro dato'),
    raw.replace('preferencias.', 'preferencias.\nUnknown extra field'),
    raw.replace('KION Group EMEA\n', ''),
    raw.replace('Barcelona\n', ''),
  ]) {
    const rejected = parseLinkedInEmail(changed);
    assert.equal(rejected.status, 'unrecognized');
    assert.deepEqual(rejected.envelope.alerts, []);
  }
});

test('nuevas variantes mantienen las restricciones de remitente y asunto', () => {
  for (const id of ['123709', '123635', '123365']) {
    const raw = fixture(`sample-${id}.eml`);
    for (const changed of [
      raw.replace('jobalerts-noreply@linkedin.com', 'jobs@example.com'),
      raw.replace('jobalerts-noreply@linkedin.com', 'newsletters-noreply@linkedin.com'),
      raw.replace(/^Subject:.*$/m, 'Subject: Security verification code'),
    ]) {
      const result = parseLinkedInEmail(changed);
      assert.equal(result.status, 'ignored');
      assert.deepEqual(result.envelope.alerts, []);
    }
  }
});
