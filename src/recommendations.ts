import type { Opportunity } from './contracts.ts';
import type { evaluate } from './evaluate.ts';

export interface EvaluatedRecord { id: string; opportunity: Opportunity; evaluation: ReturnType<typeof evaluate> }

/** Plazas reservadas por tipo conocido, para que freelance no desaparezca bajo el volumen de empleo. */
const RESERVED_PER_KIND = 5;
/** Plazas garantizadas para ofertas que declaran patrocinio de visado. */
const RESERVED_FOR_SPONSORSHIP = 3;
/**
 * Plazas por familia de rol, para que buscar varios perfiles a la vez no degenere en buscar solo
 * el que más volumen publica. Es también lo que vuelve medible la decisión de buscar varios: a las
 * dos semanas las métricas dicen qué familia produjo entrevistas, y la que no produzca se apaga
 * borrando su clave del perfil.
 */
const RESERVED_PER_FAMILY = 5;
/** Tope del bono de recencia. Acotado a propósito: inclina, no decide. */
const RECENCY_BONUS = 12;
/** Tiers admitidos en el corte diario. */
const DAILY_TIERS: readonly string[] = ['strong', 'possible'];

/**
 * Corte diario. `dailyTarget` viene del perfil; la relevancia manda y la recencia solo inclina.
 *
 * `sameDay` dejó de ser criterio dominante de orden: con una ventana de publicación de varios
 * días, ordenar todo lo de hoy primero hunde una coincidencia perfecta de ayer bajo una
 * mediocre de hoy. Se conserva en la salida como dato, no como prioridad.
 */
export function recommend(records: EvaluatedRecord[], options: { dailyTarget?: number; delivered?: ReadonlySet<string> } = {}) {
  const limit = options.dailyTarget ?? 20;
  const delivered = options.delivered ?? new Set<string>();
  const candidates = records.filter(r => r.evaluation.verification?.status === 'verified' && r.evaluation.screening.status !== 'discarded'
    && r.evaluation.expiration !== 'expired' && r.evaluation.screening.employment.status !== 'ineligible'
    // Solo `strong` y `possible` entran al corte. `weak` significa "no encaja, pero no está
    // descartada": rellenar hasta `dailyTarget` con esas es peor que entregar menos, porque
    // entrena a hojear el digest en vez de leerlo. Todo lo verificado sigue yendo a Notion.
    && DAILY_TIERS.includes(r.evaluation.relevance.tier)).map(r => {
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
      { points: e.relevance.sponsorshipBonus, reason: e.relevance.sponsorshipBonus ? `Patrocinio de visado declarado (${r.opportunity.sponsorship?.scope ?? 'sin alcance'})` : 'Sin señal de patrocinio' },
    ];
    return { id: r.id, kind: e.classification.kind, tier: e.relevance.tier, sameDay: e.verification.sameDay,
      repeated: delivered.has(r.id), roleFamily: e.relevance.roleFamily,
      sponsors: r.opportunity.sponsorship?.status === 'stated', priority: reasons.reduce((sum, x) => sum + x.points, 0), reasons };
  // Lo ya entregado se DEGRADA, no se elimina: si solo hay 6 nuevas, completar con repetidas
  // marcadas es mejor que entregar seis y dejar creer que no había más.
  }).sort((a, b) => Number(a.repeated) - Number(b.repeated) || b.priority - a.priority || a.id.localeCompare(b.id));

  // Reservas: por tipo, para que freelance no desaparezca bajo el volumen de empleo; por
  // patrocinio, porque migrar es objetivo propio y un bono no garantiza nada —con suficientes
  // vacantes locales bien puntuadas, las que patrocinan quedarían siempre fuera del corte—; y por
  // familia de rol, para que buscar tres perfiles a la vez no se convierta en buscar solo el que
  // más volumen publica.
  // Con una sola familia la reserva por familia no protege nada: sería proteger a un grupo de sí
  // mismo, y aun así gastaría plazas que le quitaría a las reservas que sí separan algo escaso.
  const present = [...new Set(candidates.map(c => c.roleFamily).filter(Boolean))];
  const families = present.length > 1 ? present : [];
  const groups = [
    ...['employment', 'freelance'].map(kind => ({ label: `entre los primeros ${RESERVED_PER_KIND} de su tipo; reserva de balance`, quota: RESERVED_PER_KIND, queue: candidates.filter(c => c.kind === kind) })),
    { label: 'reserva de patrocinio de visado', quota: RESERVED_FOR_SPONSORSHIP, queue: candidates.filter(c => c.sponsors) },
    ...families.map(family => ({ label: `reserva de la familia de rol ${family}`, quota: RESERVED_PER_FAMILY, queue: candidates.filter(c => c.roleFamily === family) })),
  ].map(g => ({ ...g, taken: 0, cursor: 0 }));

  // Las reservas se reparten POR RONDAS, no volcando la unión de todas al frente de la cola.
  // Volcarlas funcionaba mientras cupieran: con tres familias y un tope de quince, las reservas
  // suman más plazas que el corte entero, y entonces "primero todo lo reservado, ordenado por
  // prioridad" deja fuera a la familia que puntúa más bajo — que es exactamente a la que la
  // reserva existía para proteger. Por rondas, cada grupo cobra su primera plaza antes de que
  // ninguno cobre la segunda, así que un tope escaso se reparte en vez de adjudicarse.
  const selected = new Set<string>();
  const why = new Map<string, string>();
  for (let round = 0; round < Math.max(0, ...groups.map(g => g.quota)) && selected.size < limit; round += 1) {
    for (const g of groups) {
      if (selected.size >= limit || g.taken >= g.quota) continue;
      while (g.cursor < g.queue.length && selected.has(g.queue[g.cursor]!.id)) g.cursor += 1;
      if (g.cursor >= g.queue.length) continue;
      const c = g.queue[g.cursor]!;
      selected.add(c.id);
      why.set(c.id, g.label);
      g.taken += 1;
    }
  }
  // Las plazas que las reservas no llegaron a usar se adjudican por prioridad pura.
  for (const c of candidates) {
    if (selected.size >= limit) break;
    if (selected.has(c.id)) continue;
    selected.add(c.id);
    why.set(c.id, 'seleccionada por prioridad en plazas restantes');
  }
  return candidates.filter(c => selected.has(c.id)).map((c, index) => ({ ...c, rank: index + 1,
    selectionReason: `${c.repeated ? 'Repetida (ya entregada antes); ' : ''}${why.get(c.id)}` }));
}
