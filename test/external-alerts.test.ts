import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAvailability, parseOpportunity, parseProfile } from '../src/contracts.ts';
import { adaptExternalAlertEnvelope, type ExternalAlertEnvelope } from '../src/external-alerts.ts';
import { ingest, type Store } from '../src/pipeline.ts';

const empty = (): Store => ({ version: 1, records: [] });

test('adapta el envelope canónico y conserva todos los campos provistos', () => {
  const envelope: ExternalAlertEnvelope = {
    schemaVersion: 1,
    alerts: [{
      title: '  Senior Developer  ', company: ' Acme ', description: 'Build systems',
      source: 'Board', externalId: 'job-1', url: 'https://example.com/jobs/1',
      kind: 'employment', skills: ['TypeScript', 'NODE'], remote: true,
      relocationRequired: false, location: 'Bogotá', industry: 'Software',
      compensation: { currency: 'usd', period: 'month', min: 4000, max: 5000, hoursPerMonth: 160 },
      expiresAt: '2026-09-30', publishedAt: '2026-09-16',
      publicationEvidence: { url: 'https://example.com/jobs/1', excerpt: 'Published 2026-09-16', observedAt: '2026-09-16T12:00:00Z' },
      availability: { url: 'https://example.com/jobs/1', checkedAt: '2026-09-16T12:00:00Z', outcome: 'open', httpStatus: 200, evidence: 'Application open' },
      recurring: true, growthPotential: false,
    }],
  };

  assert.deepEqual(adaptExternalAlertEnvelope(envelope), [{
    title: 'Senior Developer', company: 'Acme', description: 'Build systems',
    source: 'Board', externalId: 'job-1', url: 'https://example.com/jobs/1',
    kind: 'employment', skills: ['typescript', 'node'], remote: true,
    relocationRequired: false, location: 'Bogotá', industry: 'Software',
    compensation: { currency: 'USD', period: 'month', min: 4000, max: 5000, hoursPerMonth: 160 },
    expiresAt: '2026-09-30', publishedAt: '2026-09-16',
    publicationEvidence: { url: 'https://example.com/jobs/1', excerpt: 'Published 2026-09-16', observedAt: '2026-09-16T12:00:00Z' },
    availability: { url: 'https://example.com/jobs/1', checkedAt: '2026-09-16T12:00:00Z', outcome: 'open', httpStatus: 200, evidence: 'Application open' },
    recurring: true, growthPotential: false,
  }]);
});

test('no inventa fechas, evidencia, disponibilidad ni compensación', () => {
  const [opportunity] = adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: [{ title: 'Developer', company: 'Acme' }] });
  for (const key of ['publishedAt', 'publicationEvidence', 'availability', 'compensation', 'expiresAt'] as const) assert.equal(opportunity?.[key], undefined);
  assert.deepEqual(opportunity, { title: 'Developer', company: 'Acme', skills: [] });
});

test('rechaza lotes inválidos con ruta determinista y sin conversión parcial', () => {
  for (const [input, message] of [
    [{ schemaVersion: 2, alerts: [] }, 'externalAlerts.schemaVersion: versión 1 requerida'],
    [{ schemaVersion: 1, alerts: [{ title: 'Ok', company: 'Acme' }, { title: ' ', company: 'Acme' }] }, 'externalAlerts.alerts[1]: title: texto no vacío requerido'],
    [{ schemaVersion: 1, alerts: [{ title: 'Ok', company: 'Acme', salary: 5000, vendor: 'x' }] }, 'externalAlerts.alerts[0]: campos desconocidos: salary, vendor'],
    [{ schemaVersion: 1, alerts: [{ title: 'Ok', company: 'Acme', compensation: { currency: 'USD', period: 'month', min: 1, gross: true } }] }, 'externalAlerts.alerts[0].compensation: campos desconocidos: gross'],
  ] as const) assert.throws(() => adaptExternalAlertEnvelope(input), { message });
});

test('el adaptador conserva duplicados y solo ingest aplica la identidad existente', () => {
  const converted = adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: [
    { title: 'Developer', company: 'Acme', source: 'Board', externalId: '1' },
    { title: 'Renamed developer', company: 'Acme', source: 'board', externalId: '1' },
  ] });
  assert.equal(converted.length, 2);
  const store = ingest(empty(), converted);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0]?.opportunity.title, 'Renamed developer');
  assert.equal(store.records[0]?.history?.[0]?.title, 'Developer');
});

test('rechaza arrays y objetos en enums tanto en el contrato como en el envelope', () => {
  const base = { title: 'Developer', company: 'Acme' };
  const availability = { url: 'https://example.com/jobs/1', checkedAt: '2026-09-16T12:00:00Z' };
  for (const wrap of [
    (value: string) => [value],
    (value: string) => ({ toString: () => value }),
    (value: string) => new String(value),
  ]) {
    for (const [extra, message] of [
      [{ kind: wrap('employment') }, 'kind inválido'],
      [{ compensation: { currency: 'USD', period: wrap('month'), min: 4000 } }, 'compensation.period inválido'],
      [{ availability: { ...availability, outcome: wrap('open') } }, 'availability.outcome inválido'],
    ] as const) {
      const alert = { ...base, ...extra };
      assert.throws(() => parseOpportunity(alert), { message });
      assert.throws(() => adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: [base, alert] }), {
        message: `externalAlerts.alerts[1]: ${message}`,
      });
    }
    assert.throws(() => parseAvailability({ ...availability, outcome: wrap('open') }), {
      message: 'availability.outcome inválido',
    });
  }
});

test('rechaza alerts ausente, null o no-array y acepta el lote vacío', () => {
  for (const alerts of [undefined, null, {}, 'alerts', 1, true, { 0: { title: 'Job', company: 'Acme' }, length: 1 }]) {
    assert.throws(() => adaptExternalAlertEnvelope({ schemaVersion: 1, alerts }), {
      message: 'externalAlerts.alerts: se esperaba una lista',
    });
  }
  assert.throws(() => adaptExternalAlertEnvelope({ schemaVersion: 1 }), {
    message: 'externalAlerts.alerts: se esperaba una lista',
  });
  assert.deepEqual(adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: [] }), []);
});

test('rechaza el primer hueco o elemento null de alerts con su índice exacto', () => {
  const base = { title: 'Developer', company: 'Acme' };
  for (const index of [0, 1, 2]) {
    const sparse: unknown[] = [base, base, base];
    delete sparse[index];
    for (const alerts of [sparse, [base, base, base].map((alert, i) => i === index ? null : alert)]) {
      assert.throws(() => adaptExternalAlertEnvelope({ schemaVersion: 1, alerts }), {
        message: `externalAlerts.alerts[${index}]: se esperaba un objeto`,
      });
    }
  }
  assert.throws(() => adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: new Array(3) }), {
    message: 'externalAlerts.alerts[0]: se esperaba un objeto',
  });
});

test('skills omitido o undefined conserva el default, pero null se rechaza también en el perfil', () => {
  const base = { title: 'Developer', company: 'Acme' };
  for (const extra of [{}, { skills: undefined }, { skills: [] }]) {
    assert.deepEqual(parseOpportunity({ ...base, ...extra }).skills, []);
    assert.deepEqual(parseProfile(extra).skills, []);
    assert.deepEqual(adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: [{ ...base, ...extra }] }), [{ ...base, skills: [] }]);
  }
  for (const skills of [null, {}, 'TypeScript']) {
    assert.throws(() => parseOpportunity({ ...base, skills }), { message: 'skills: se esperaba una lista' });
    assert.throws(() => parseProfile({ skills }), { message: 'skills: se esperaba una lista' });
    assert.throws(() => adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: [{ ...base, skills }] }), {
      message: 'externalAlerts.alerts[0]: skills: se esperaba una lista',
    });
  }
});

test('las listas de textos rechazan huecos sin conservar undefined como habilidad', () => {
  const skills = new Array(1);
  const alert = { title: 'Developer', company: 'Acme', skills };
  assert.throws(() => parseOpportunity(alert), { message: 'skills: texto no vacío requerido' });
  assert.throws(() => parseProfile({ skills }), { message: 'skills: texto no vacío requerido' });
  assert.throws(() => adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: [alert] }), {
    message: 'externalAlerts.alerts[0]: skills: texto no vacío requerido',
  });
});

test('rechaza claves desconocidas en envelope y evidencias con rutas y orden estables', () => {
  const base = { title: 'Developer', company: 'Acme' };
  assert.throws(() => adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: [base], vendor: 'x', metadata: {} }), {
    message: 'externalAlerts: campos desconocidos: metadata, vendor',
  });
  for (const [key, evidence] of [
    ['publicationEvidence', { url: 'https://example.com/jobs/1', excerpt: 'Published today', observedAt: '2026-09-16T12:00:00Z' }],
    ['availability', { url: 'https://example.com/jobs/1', checkedAt: '2026-09-16T12:00:00Z', outcome: 'open' }],
  ] as const) {
    const alert = { ...base, [key]: { ...evidence, vendor: 'x', metadata: {} } };
    assert.throws(() => adaptExternalAlertEnvelope({ schemaVersion: 1, alerts: [base, alert] }), {
      message: `externalAlerts.alerts[1].${key}: campos desconocidos: metadata, vendor`,
    });
  }
});
