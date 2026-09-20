import type { Opportunity } from './contracts.ts';
import type { evaluate } from './evaluate.ts';

export interface EvaluatedRecord { id: string; opportunity: Opportunity; evaluation: ReturnType<typeof evaluate> }

/** Plazas reservadas por tipo conocido, para que freelance no desaparezca bajo el volumen de empleo. */
const RESERVED_PER_KIND = 5;
/** Tope del bono de recencia. Acotado a propósito: inclina, no decide. */
const RECENCY_BONUS = 12;

/**
 * Corte diario. `dailyTarget` viene del perfil; la relevancia manda y la recencia solo inclina.
 *
 * `sameDay` dejó de ser criterio dominante de orden: con una ventana de publicación de varios
 * días, ordenar todo lo de hoy primero hunde una coincidencia perfecta de ayer bajo una
 * mediocre de hoy. Se conserva en la salida como dato, no como prioridad.
 */
export function recommend(records: EvaluatedRecord[], options: { dailyTarget?: number } = {}) {
  const limit = options.dailyTarget ?? 20;
  const candidates = records.filter(r => r.evaluation.verification?.status === 'verified' && r.evaluation.screening.status !== 'discarded'
    && r.evaluation.expiration !== 'expired' && r.evaluation.screening.employment.status !== 'ineligible'
    && r.evaluation.relevance.tier !== 'off_target').map(r => {
    const e = r.evaluation;
    const { ageDays, windowDays } = e.verification;
    // Decae linealmente hasta el fin de la ventana. Sin fecha no se premia ni se castiga.
    const recency = ageDays === null ? 0 : Math.max(0, Math.round(RECENCY_BONUS * (1 - ageDays / Math.max(1, windowDays))));
    const reasons = [
      { points: e.relevance.score * 2, reason: `Relevancia ${e.relevance.tier} (${e.relevance.score}/100)${e.relevance.roleMatched.length ? `: ${e.relevance.roleMatched.join(', ')}` : ''}` },
      { points: e.scores.fit.value, reason: 'Compatibilidad: ver componentes del score de fit' },
      { points: e.scores.economic.value, reason: 'Economía: ver componentes del score económico' },
      { points: e.screening.employment.status === 'eligible' || e.freelanceReview.status === 'meets_floor' ? 30 : 0, reason: '30 puntos si cumple elegibilidad de empleo o piso freelance' },
      { points: e.screening.employment.target.status === 'eligible' ? 20 : 0, reason: '20 puntos si alcanza objetivo mensual de empleo' },
      { points: recency, reason: ageDays === null ? 'Sin fecha de publicación: sin bono de recencia' : `Recencia: publicada hace ${ageDays} día(s) dentro de una ventana de ${windowDays}` },
    ];
    return { id: r.id, kind: e.classification.kind, tier: e.relevance.tier, sameDay: e.verification.sameDay, priority: reasons.reduce((sum, x) => sum + x.points, 0), reasons };
  }).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const reserved = new Set(['employment', 'freelance'].flatMap(kind => candidates.filter(c => c.kind === kind).slice(0, RESERVED_PER_KIND).map(c => c.id)));
  const selected = new Set<string>();
  for (const c of [...candidates.filter(c => reserved.has(c.id)), ...candidates.filter(c => !reserved.has(c.id))]) {
    if (selected.size >= limit) break;
    selected.add(c.id);
  }
  return candidates.filter(c => selected.has(c.id)).map((c, index) => ({ ...c, rank: index + 1,
    selectionReason: reserved.has(c.id) ? `Entre los primeros ${RESERVED_PER_KIND} de su tipo; reserva de balance` : 'Seleccionada por prioridad en plazas restantes' }));
}
