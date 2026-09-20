import type { Kind, Opportunity, Profile } from './contracts.ts';
import { canonical, contains, matchedTerms } from './text.ts';

/**
 * Señal POSITIVA de relevancia. Deliberadamente fuera de `screening.ts`: aquel decide qué
 * descartar y su ausencia de coincidencias significa "retenido"; este decide qué encaja y su
 * ausencia significa "no encaja". Mezclarlos invertiría el significado de ambos.
 *
 * Es determinista y no consume tokens: corre sobre TODAS las capturas antes de que el
 * enriquecimiento con Claude toque una sola oferta.
 */
export type RelevanceTier = 'strong' | 'possible' | 'weak' | 'off_target';
export interface RelevanceSignal { points: number; reason: string; evidence?: string }
export interface Relevance {
  score: number;
  tier: RelevanceTier;
  signals: RelevanceSignal[];
  roleMatched: string[];
  skillsMatched: string[];
  blockers: string[];
}

/** Vocabulario de seniority: es del mercado, no de la persona, por eso no se configura. */
const SENIOR_TERMS = ['senior', 'sr', 'staff', 'principal', 'lead', 'head of', 'architect', 'director', 'vp'];
const BELOW_FLOOR_TERMS = ['junior', 'jr', 'intern', 'internship', 'trainee', 'apprentice', 'graduate', 'entry level', 'becario', 'practicante', 'aprendiz'];
/** Restricciones de un puesto remoto que NO excluyen a alguien residente en LATAM. */
const REMOTE_COMPATIBLE = ['worldwide', 'anywhere', 'global', 'international', 'latam', 'latin america', 'americas', 'south america', 'colombia'];
/** Señales de presencialidad. `hybrid` cuenta como presencial: exige vivir en la ciudad. */
const ONSITE_TERMS = ['on site', 'onsite', 'in office', 'in person', 'hybrid', 'presencial', 'hibrido'];
/** Palabras que un campo de ubicación remota trae sin nombrar región alguna. */
const REMOTE_NOISE = ['remote', 'remoto', 'fully', 'full', 'time', 'work', 'from', 'home', 'anywhere', 'only', 'based', 'or', 'and', 'in', 'the', 'optional', 'first'];

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const quote = (field: string, value: string) => `${field}:"${value.length > 120 ? `${value.slice(0, 117)}...` : value}"`;

/**
 * Coincidencia de una habilidad contra el texto de la oferta, contemplando alias.
 * Reemplaza la igualdad exacta contra `opportunity.skills`, que da 0 para todo lo ingestado
 * automáticamente porque los adaptadores escriben `skills: []`.
 */
function skillHit(haystack: string, skill: string, aliases: Record<string, string[]>): string | undefined {
  for (const variant of [skill, ...(aliases[skill] ?? [])]) {
    const needle = canonical(variant);
    if (contains(haystack, needle)) return variant;
  }
  return undefined;
}

function geography(o: Opportunity, relocationTargets: readonly string[]): { points: number; signal: RelevanceSignal; blocker?: string } {
  const locationText = canonical(o.location ?? '');
  const saysRemote = o.remote === true || contains(locationText, 'remote') || contains(locationText, 'remoto');
  const saysOnsite = o.remote === false || ONSITE_TERMS.some(term => contains(locationText, canonical(term)));

  if (saysRemote && !saysOnsite) {
    const compatible = matchedTerms(locationText, REMOTE_COMPATIBLE);
    if (compatible.length) return { points: 15, signal: { points: 15, reason: `Remoto abierto a la región (${compatible.join(', ')})`, evidence: quote('location', o.location ?? 'remote') } };
    // Cualquier región nombrada que no sea compatible es una restricción, no solo las deseadas:
    // "Remote - India" excluye igual que "Remote - United States". Se detecta por lo que queda
    // del texto al quitar el ruido, para no depender de un catálogo de países.
    const restriction = locationText.split(' ').filter(word => word && !REMOTE_NOISE.includes(word));
    // Un remoto restringido a una región NO es una ruta de reubicación: exige residir allá y
    // no ofrece visado. Desde Colombia es inaplicable, sea cual sea la región.
    if (restriction.length) return { points: 0, blocker: 'remote_region_excluded', signal: { points: 0, reason: `Remoto restringido a ${restriction.join(' ')}; no habilita reubicación`, evidence: quote('location', o.location ?? '') } };
    return { points: 10, signal: { points: 10, reason: 'Remoto sin restricción declarada', evidence: quote('location', o.location ?? 'remote') } };
  }
  if (!locationText && o.remote === undefined) return { points: 7, signal: { points: 7, reason: 'Modalidad no declarada; no se infiere' } };
  const target = matchedTerms(locationText, relocationTargets);
  // Presencial en destino de migración sigue vivo: es exactamente donde vive el sponsorship.
  if (target.length) return { points: 6, signal: { points: 6, reason: `Presencial en destino de reubicación (${target.join(', ')})`, evidence: quote('location', o.location ?? '') } };
  return { points: 0, blocker: 'onsite_outside_relocation_targets', signal: { points: 0, reason: 'Presencial fuera de los destinos de reubicación', evidence: quote('location', o.location ?? '') } };
}

export function relevance(o: Opportunity, p: Profile, kind: Kind): Relevance {
  const config = p.relevance;
  const titleText = canonical(o.title);
  const descriptionText = canonical(o.description ?? '');
  const haystack = canonical([o.title, o.description, ...o.skills].filter(Boolean).join(' '));
  const signals: RelevanceSignal[] = [];
  const blockers: string[] = [];

  // Rol (0-40). Una coincidencia en el título pesa cinco veces más que una en la descripción:
  // el título declara el puesto, la descripción solo lo menciona.
  const titleRole = matchedTerms(titleText, config.roleTerms);
  const descriptionRole = matchedTerms(descriptionText, config.roleTerms).filter(term => !titleRole.includes(term));
  const rolePoints = Math.min(40, titleRole.length * 20 + descriptionRole.length * 4);
  const roleMatched = [...titleRole, ...descriptionRole];
  signals.push({ points: rolePoints, reason: roleMatched.length ? `Rol: ${roleMatched.join(', ')}` : 'Ningún término de rol coincide', ...(titleRole.length ? { evidence: quote('title', o.title) } : {}) });
  // La exclusión de rol solo aplica al TÍTULO: una vacante de backend puede mencionar al
  // equipo de ventas en su descripción sin dejar de ser de backend.
  const excludedRole = matchedTerms(titleText, config.roleExcludedTerms);
  if (excludedRole.length) {
    blockers.push('role_off_target');
    signals.push({ points: 0, reason: `Familia de rol excluida: ${excludedRole.join(', ')}`, evidence: quote('title', o.title) });
  }

  // Seniority (0-20). Sin declaración explícita se asume neutro, no bajo: muchas vacantes
  // senior reales no llevan la palabra en el título.
  const belowFloor = matchedTerms(titleText, BELOW_FLOOR_TERMS);
  const senior = matchedTerms(titleText, SENIOR_TERMS);
  let seniorityPoints = 8;
  if (belowFloor.length) {
    seniorityPoints = 0;
    blockers.push('seniority_below_floor');
    signals.push({ points: 0, reason: `Por debajo del piso de seniority: ${belowFloor.join(', ')}`, evidence: quote('title', o.title) });
  } else if (senior.length) {
    seniorityPoints = 20;
    signals.push({ points: 20, reason: `Seniority declarada: ${senior.join(', ')}`, evidence: quote('title', o.title) });
  } else {
    signals.push({ points: 8, reason: 'Seniority no declarada en el título' });
  }

  // Habilidades (0-25) por texto libre con alias, no por igualdad exacta contra un array vacío.
  const skillsMatched: string[] = [];
  for (const skill of p.skills) {
    const hit = skillHit(haystack, skill, config.skillAliases);
    if (hit) skillsMatched.push(hit);
  }
  const skillPoints = p.skills.length ? Math.round(25 * (skillsMatched.length / p.skills.length)) : 12;
  signals.push({ points: skillPoints, reason: p.skills.length ? `Habilidades: ${skillsMatched.length}/${p.skills.length}${skillsMatched.length ? ` (${skillsMatched.join(', ')})` : ''}` : 'Perfil sin habilidades declaradas; puntaje neutro' });

  // Geografía (0-15).
  const geo = geography(o, config.relocationTargets);
  signals.push(geo.signal);
  if (geo.blocker) blockers.push(geo.blocker);

  // Un tipo explícitamente fuera de los preferidos no bloquea, pero tampoco se premia.
  if (kind !== 'unknown' && !p.preferredKinds.includes(kind)) signals.push({ points: 0, reason: `Tipo ${kind} fuera de los preferidos` });

  const score = clamp(rolePoints + seniorityPoints + skillPoints + geo.points);
  const tier: RelevanceTier = blockers.length ? 'off_target' : score >= 65 ? 'strong' : score >= 40 ? 'possible' : 'weak';
  return { score, tier, signals, roleMatched, skillsMatched, blockers };
}
