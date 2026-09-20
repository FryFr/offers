import { recommend } from './recommendations.ts';
import { createHash } from 'node:crypto';
import { parseOpportunity, type Opportunity, type Profile } from './contracts.ts';
import { evaluate } from './evaluate.ts';

export interface RecordEntry { id: string; opportunity: Opportunity; history?: Opportunity[] }
export interface Store { version: 1; records: RecordEntry[] }
/** Revisiones anteriores conservadas por registro. Lecturas antiguas no se reconstruyen desde el store. */
export const MAX_HISTORY = 5;
const canonicalText = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const notionRichText = (values: readonly string[]) => values.flatMap(value => {
  const chunks: { text: { content: string } }[] = [];
  for (let start = 0; start < value.length; start += 2000) chunks.push({ text: { content: value.slice(start, start + 2000) } });
  return chunks;
});
export function identity(o: Opportunity): string {
  let key: string;
  if (o.source && o.externalId) key = JSON.stringify(['source', canonicalText(o.source), o.externalId]);
  else if (o.url) {
    const url = new URL(o.url);
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(name)) url.searchParams.delete(name);
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    key = JSON.stringify(['url', url.toString()]);
  } else key = JSON.stringify(['manual', canonicalText(o.company), canonicalText(o.title)]);
  return createHash('sha256').update(key).digest('hex');
}
export function parseStore(value: unknown): Store {
  const v = value as Partial<Store> | null;
  if (!v || v.version !== 1 || !Array.isArray(v.records)) throw new Error('Estado inválido o versión no soportada');
  const ids = new Set<string>();
  const records = v.records.map(r => {
    if (!r || typeof r !== 'object') throw new Error('Registro de estado inválido');
    const opportunity = parseOpportunity(r.opportunity);
    const id = identity(opportunity);
    if (r.id !== id || ids.has(id)) throw new Error('Identidad de estado inválida o duplicada');
    ids.add(id);
    if (r.history !== undefined && !Array.isArray(r.history)) throw new Error('Historial inválido');
    const history = r.history?.map(parseOpportunity);
    if (history?.some(o => identity(o) !== id)) throw new Error('Identidad histórica inválida');
    return { id, opportunity, ...(history?.length ? { history } : {}) };
  });
  return { version: 1, records };
}
/**
 * La oferta sin sus sellos de re-comprobación. `availability.checkedAt` y
 * `publicationEvidence.observedAt` avanzan en CADA ciclo aunque nada de la vacante cambie:
 * medido, 3.460 de 3.462 registros diferían solo en esos dos campos tras una corrida horaria.
 * Tratarlos como revisión duplicaba el store cada hora para no registrar ninguna información.
 */
const withoutRecheckStamps = (o: Opportunity) => JSON.stringify({
  ...o,
  ...(o.availability ? { availability: { ...o.availability, checkedAt: '' } } : {}),
  ...(o.publicationEvidence ? { publicationEvidence: { ...o.publicationEvidence, observedAt: '' } } : {}),
});
export function ingest(store: Store, input: unknown): Store {
  const opportunities = (Array.isArray(input) ? input : [input]).map(parseOpportunity);
  const records = new Map(store.records.map(r => [r.id, r]));
  for (const opportunity of opportunities) {
    const id = identity(opportunity);
    const previous = records.get(id);
    if (previous && JSON.stringify(previous.opportunity) === JSON.stringify(opportunity)) continue;
    // Una re-comprobación que solo mueve timestamps actualiza la oferta pero no genera revisión:
    // el TTL necesita el `checkedAt` fresco, el historial no gana nada guardando el anterior.
    const recheckOnly = previous !== undefined && withoutRecheckStamps(previous.opportunity) === withoutRecheckStamps(opportunity);
    const history = previous && !recheckOnly ? [...(previous.history ?? []), previous.opportunity] : previous?.history ?? [];
    // El historial se acota por registro: sin tope, un cambio real de contrato reescribe miles de
    // registros a la vez y el store crece sin techo. Se conservan las revisiones más recientes.
    records.set(id, { id, opportunity, ...(history.length ? { history: history.slice(-MAX_HISTORY) } : {}) });
  }
  return { version: 1, records: [...records.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
export function report(store: Store, profile: Profile, now: Date) {
  const records = store.records.map(r => ({ ...r, evaluation: evaluate(r.opportunity, profile, now),
    historicalEvaluations: (r.history ?? []).map(opportunity => ({ opportunity, evaluation: evaluate(opportunity, profile, now) })) }));
  const recommendations = recommend(records, { dailyTarget: profile.relevance.dailyTarget });
  const ranks = new Map(recommendations.map(r => [r.id, r]));
  return {
    schemaVersion: 1,
    recommendations,
    generatedAt: now.toISOString(),
    records,
    notion: {
      schemaVersion: 1,
      recommendations,
      records: records.map(r => ({
        externalKey: r.id,
        opportunity: r.opportunity,
        properties: {
          Name: { title: [{ text: { content: r.opportunity.title } }] },
          Company: { rich_text: [{ text: { content: r.opportunity.company } }] },
          URL: { url: r.opportunity.url ?? null },
          Type: { select: { name: r.evaluation.classification.kind } },
          Expiration: { select: { name: r.evaluation.expiration } },
          Verification: { select: { name: r.evaluation.verification.status } },
          'Verification reasons': { rich_text: notionRichText(r.evaluation.verification.reasons) },
          Published: { date: r.opportunity.publishedAt ? { start: r.opportunity.publishedAt } : null },
          Deadline: { date: r.opportunity.expiresAt ? { start: r.opportunity.expiresAt } : null },
          Screening: { select: { name: r.evaluation.screening.status } },
          'Screening reasons': { rich_text: r.evaluation.screening.reasons.map(content => ({ text: { content } })) },
          'Employment eligibility': { select: { name: r.evaluation.screening.employment.status } },
          Location: { rich_text: r.opportunity.location ? [{ text: { content: r.opportunity.location } }] : [] },
          Relocation: { select: { name: r.opportunity.relocationRequired === undefined ? 'unknown' : r.opportunity.relocationRequired ? 'required' : 'not_required' } },
          'Recommendation rank': { number: ranks.get(r.id)?.rank ?? null },
          'Recommendation priority': { number: ranks.get(r.id)?.priority ?? null },
          // Se envía para TODO lo verificado, no solo lo recomendado: un ranker que se equivoca
          // debe poder inspeccionarse con un filtro de vista, no quedar invisible.
          Relevance: { number: r.evaluation.relevance.score },
          'Relevance tier': { select: { name: r.evaluation.relevance.tier } },
          'Fit score': { number: r.evaluation.scores.fit.value },
          'Economic score': { number: r.evaluation.scores.economic.value },
          'Hourly USD': { number: r.evaluation.normalized.hourlyUsd?.min ?? null },
          'Freelance review': { select: { name: r.evaluation.freelanceReview.status } },
          Origin: { rich_text: notionRichText(r.opportunity.source ? [r.opportunity.source] : []) },
          'Calculation assumptions': { rich_text: notionRichText(r.evaluation.normalized.assumptions) },
          Explanation: { rich_text: notionRichText([JSON.stringify(r.evaluation)]) },
        },
        explanation: r.evaluation,
      })),
    },
  };
}
