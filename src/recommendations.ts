import type { Opportunity } from './contracts.ts';
import type { evaluate } from './evaluate.ts';

export interface EvaluatedRecord { id: string; opportunity: Opportunity; evaluation: ReturnType<typeof evaluate> }

/** Daily snapshot: reserve up to five places per known kind, then fill by priority. */
export function recommend(records: EvaluatedRecord[]) {
  const candidates = records.filter(r => r.evaluation.verification?.status === 'verified' && r.evaluation.screening.status !== 'discarded'
    && r.evaluation.expiration !== 'expired' && r.evaluation.screening.employment.status !== 'ineligible').map(r => {
    const e = r.evaluation;
    const reasons = [
      { points: e.scores.fit.value, reason: 'Compatibilidad: ver componentes del score de fit' },
      { points: e.scores.economic.value, reason: 'Economía: ver componentes del score económico' },
      { points: e.screening.employment.status === 'eligible' || e.freelanceReview.status === 'meets_floor' ? 30 : 0, reason: '30 puntos si cumple elegibilidad de empleo o piso freelance' },
      { points: e.screening.employment.target.status === 'eligible' ? 20 : 0, reason: '20 puntos si alcanza objetivo mensual de empleo' },
    ];
    return { id: r.id, kind: e.classification.kind, sameDay: e.verification.sameDay, priority: reasons.reduce((sum, r) => sum + r.points, 0), reasons };
  }).sort((a, b) => Number(b.sameDay) - Number(a.sameDay) || b.priority - a.priority || a.id.localeCompare(b.id));
  const reserved = new Set<string>();
  const selected = new Set<string>();
  for (const sameDay of [true, false]) {
    const group = candidates.filter(c => c.sameDay === sameDay);
    const balanced = new Set(['employment', 'freelance'].flatMap(kind => group.filter(c => c.kind === kind).slice(0, 5).map(c => c.id)));
    for (const c of [...group.filter(c => balanced.has(c.id)), ...group.filter(c => !balanced.has(c.id))]) {
      if (selected.size >= 20) break;
      selected.add(c.id);
      if (balanced.has(c.id)) reserved.add(c.id);
    }
  }
  return candidates.filter(c => selected.has(c.id)).map((c, index) => ({ ...c, rank: index + 1,
    selectionReason: `${c.sameDay ? 'Publicada hoy; prioridad de fecha. ' : ''}${reserved.has(c.id) ? 'Entre los primeros cinco de su tipo; reserva de balance' : 'Seleccionada por prioridad en plazas restantes'}` }));
}
