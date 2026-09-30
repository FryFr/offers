/** Registros compartidos por las pruebas de Notion, para no reconstruirlos en cada archivo. */
import { parseProfile } from '../src/contracts.ts';
import { ingest, report } from '../src/pipeline.ts';

const now = new Date('2026-09-16T12:00:00Z');
const evidence = { url: 'https://example.com/job', publishedAt: '2026-09-16',
  publicationEvidence: { url: 'https://example.com/job', excerpt: 'Published', observedAt: now.toISOString() },
  availability: { url: 'https://example.com/job', checkedAt: now.toISOString(), outcome: 'open' as const, httpStatus: 200, evidence: 'form' } };
export const records = report(ingest({ version: 1, records: [] },
  [{ ...evidence, source: 'test', externalId: '1', title: 'Developer', company: 'Acme' }]), parseProfile({}), now).notion.records;
