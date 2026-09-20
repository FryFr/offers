import { parseOpportunity, type Opportunity } from './contracts.ts';

/**
 * Provider-neutral input contract. It is deliberately an Opportunity-shaped
 * transport envelope, not a parser for email, HTML, webhooks or vendor payloads.
 */
export type ExternalAlert = Omit<Opportunity, 'skills'> & { skills?: string[] };

export interface ExternalAlertEnvelope {
  schemaVersion: 1;
  alerts: ExternalAlert[];
}

const envelopeKeys = ['alerts', 'schemaVersion'] as const;
const alertKeys = [
  'availability', 'company', 'compensation', 'description', 'expiresAt',
  'externalId', 'growthPotential', 'industry', 'kind', 'location',
  'publicationEvidence', 'publishedAt', 'recurring', 'relocationRequired',
  'remote', 'skills', 'source', 'title', 'url',
] as const;
const compensationKeys = ['currency', 'estimatedHours', 'hoursPerMonth', 'max', 'min', 'period'] as const;
const publicationEvidenceKeys = ['excerpt', 'observedAt', 'url'] as const;
const availabilityKeys = ['checkedAt', 'evidence', 'httpStatus', 'outcome', 'url'] as const;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: se esperaba un objeto`);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (unknown.length) throw new Error(`${path}: campos desconocidos: ${unknown.join(', ')}`);
}

function validateShape(value: unknown, index: number): Record<string, unknown> {
  const path = `externalAlerts.alerts[${index}]`;
  const alert = record(value, path);
  rejectUnknownKeys(alert, alertKeys, path);
  if (alert.compensation !== undefined) rejectUnknownKeys(record(alert.compensation, `${path}.compensation`), compensationKeys, `${path}.compensation`);
  if (alert.publicationEvidence !== undefined) rejectUnknownKeys(record(alert.publicationEvidence, `${path}.publicationEvidence`), publicationEvidenceKeys, `${path}.publicationEvidence`);
  if (alert.availability !== undefined) rejectUnknownKeys(record(alert.availability, `${path}.availability`), availabilityKeys, `${path}.availability`);
  return alert;
}

/**
 * Validates and converts a complete batch transactionally. The adapter performs
 * no I/O, inference or deduplication; pipeline.ingest owns the existing identity
 * and upsert rules.
 */
export function adaptExternalAlertEnvelope(value: unknown): Opportunity[] {
  const envelope = record(value, 'externalAlerts');
  rejectUnknownKeys(envelope, envelopeKeys, 'externalAlerts');
  if (envelope.schemaVersion !== 1) throw new Error('externalAlerts.schemaVersion: versión 1 requerida');
  if (!Array.isArray(envelope.alerts)) throw new Error('externalAlerts.alerts: se esperaba una lista');

  // Array.from visits holes as undefined so every position is validated.
  return Array.from(envelope.alerts, (value, index) => {
    const alert = validateShape(value, index);
    try {
      return parseOpportunity(alert);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'entrada inválida';
      throw new Error(`externalAlerts.alerts[${index}]: ${detail}`);
    }
  });
}
