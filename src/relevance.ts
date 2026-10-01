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
  /**
   * Familia de rol que mejor coincidió, o `''` si ninguna. Viaja en la salida porque decide qué
   * currículum se adapta a esta oferta y qué plaza reservada ocupa en el corte diario.
   */
  roleFamily: string;
  skillsMatched: string[];
  /** Habilidades secundarias halladas en el texto. Informan el bono; no entran al denominador. */
  secondaryMatched: string[];
  blockers: string[];
  /**
   * Bonificación por patrocinio de visado, FUERA de los 100 puntos del score. Se suma en el
   * ranking para que no desplace al ajuste de rol: migrar es valiosísimo, pero una vacante que
   * patrocina y no encaja con el perfil sigue sin servir.
   */
  sponsorshipBonus: number;
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

/** Techo del componente de habilidades completo: núcleo más bono. No cambió al separar las dos
 *  listas, así que los umbrales 65/40 siguen significando lo mismo. */
export const SKILL_POINTS = 25;
/**
 * Lo que puede aportar el NÚCLEO por sí solo.
 *
 * Es 20 y no 25 a propósito. Si el núcleo pudiera llegar al techo, el bono quedaría
 * matemáticamente inalcanzable justo en las ofertas que mejor encajan —las de núcleo saturado—
 * que son precisamente las únicas que importan. Un bono que no puede sumar no es un bono.
 * El precio es que un perfil que coincidía al 100% baja de 25 a 20 puntos; es uniforme para
 * todas las ofertas, así que reordena nada y solo desplaza la escala.
 */
export const CORE_POINTS = 20;
/** Cuánto puede añadir el bono secundario por encima del núcleo. Acotado para que ampliar la lista
 *  secundaria nunca compre un `strong` por sí solo: inclina, no decide. */
export const SECONDARY_BONUS_CAP = 5;
/**
 * Cuántas habilidades secundarias coincidentes valen el bono completo.
 *
 * NO es 1. Con una lista secundaria larga —lo normal cuando alguien declara todo lo que sabe—
 * un bono `min(5, coincidentes)` se satura en casi toda oferta, se vuelve una constante y deja de
 * discriminar, que es justo lo contrario de para lo que existe. Ocho es el punto de partida;
 * se calibra comparando cortes con `--digest-preview` sobre el mismo store, no a ojo.
 */
export const SECONDARY_BONUS_FULL = 8;

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const quote = (field: string, value: string) => `${field}:"${value.length > 120 ? `${value.slice(0, 117)}...` : value}"`;

/**
 * Coincidencia de una habilidad contra el texto de la oferta, contemplando alias.
 * Reemplaza la igualdad exacta contra `opportunity.skills`, que da 0 para todo lo ingestado
 * automáticamente porque los adaptadores escriben `skills: []`.
 */
export function skillHit(haystack: string, skill: string, aliases: Record<string, string[]>): string | undefined {
  for (const variant of [skill, ...(aliases[skill] ?? [])]) {
    const needle = canonical(variant);
    if (contains(haystack, needle)) return variant;
  }
  return undefined;
}

function geography(o: Opportunity, relocationTargets: readonly string[]): { points: number; signal: RelevanceSignal; blocker?: string } {
  // Las restricciones declaradas por el proveedor entran al mismo texto: son la forma explícita
  // de lo que la ubicación libre solo insinúa ("Remote" + locationRestrictions:["United States"]).
  const locationText = canonical([o.location, ...(o.locationRestrictions ?? [])].filter(Boolean).join(' '));
  // `remoteness` declarado manda sobre el texto. `partially_remote` e `hybrid` cuentan como
  // presencial: ambos exigen vivir cerca de la oficina.
  const declaredRemote = o.remoteness === 'fully_remote';
  const declaredOnsite = o.remoteness !== undefined && o.remoteness !== 'unknown' && !declaredRemote;
  const saysRemote = declaredRemote || (!declaredOnsite && (o.remote === true || contains(locationText, 'remote') || contains(locationText, 'remoto')));
  const saysOnsite = declaredOnsite || (o.remoteness === undefined && (o.remote === false || ONSITE_TERMS.some(term => contains(locationText, canonical(term)))));

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
  if (target.length) {
    // Un presencial en destino solo sirve por la vía de reubicación. Si la propia oferta dice
    // que NO patrocina, esa vía está cerrada y la vacante es inaplicable desde Colombia.
    if (o.sponsorship?.status === 'stated_none') {
      return { points: 0, blocker: 'onsite_target_without_sponsorship', signal: { points: 0, reason: 'Presencial en destino, pero la oferta declara que no patrocina visado', evidence: quote('sponsorship', o.sponsorship.evidence.quote) } };
    }
    const stated = o.sponsorship?.status === 'stated';
    const points = stated ? 12 : 6;
    return { points, signal: { points, reason: `Presencial en destino de reubicación (${target.join(', ')})${stated ? ' con patrocinio declarado' : '; patrocinio sin confirmar'}`, evidence: quote('location', o.location ?? '') } };
  }
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
  //
  // Se puntúa contra la familia que MEJOR coincide, no contra la unión de todas. Con la unión,
  // buscar tres perfiles a la vez hacía que casi cualquier título de ingeniería tocara el techo de
  // 40 y el componente dejaba de separar una vacante de otra. Empatar a favor de la primera
  // familia declarada es deliberado: el orden del perfil expresa la preferencia de la persona.
  const scoreFamily = (terms: string[]) => {
    const title = matchedTerms(titleText, terms);
    const description = matchedTerms(descriptionText, terms).filter(term => !title.includes(term));
    return { title, description, points: Math.min(40, title.length * 20 + description.length * 4) };
  };
  const families = Object.entries(config.roleFamilies);
  const scored = families.map(([family, terms]) => ({ family, ...scoreFamily(terms) }));
  const best = scored.reduce<{ family: string; title: string[]; description: string[]; points: number }>(
    (a, b) => (b.points > a.points ? b : a), { family: '', title: [], description: [], points: 0 });
  const roleFamily = best.family;
  const rolePoints = best.points;
  const roleMatched = [...best.title, ...best.description];
  signals.push({ points: rolePoints, reason: roleMatched.length ? `Rol (${roleFamily}): ${roleMatched.join(', ')}` : 'Ningún término de rol coincide', ...(best.title.length ? { evidence: quote('title', o.title) } : {}) });
  // La exclusión de rol solo aplica al TÍTULO: una vacante de backend puede mencionar al
  // equipo de ventas en su descripción sin dejar de ser de backend.
  const excludedRole = matchedTerms(titleText, config.roleExcludedTerms);
  if (excludedRole.length) {
    blockers.push('role_off_target');
    signals.push({ points: 0, reason: `Familia de rol excluida: ${excludedRole.join(', ')}`, evidence: quote('title', o.title) });
  }

  // Seniority (0-20). Sin declaración explícita se asume neutro, no bajo: muchas vacantes
  // senior reales no llevan la palabra en el título.
  // Un nivel declarado por el proveedor manda sobre lo que insinúe el título.
  const declaredLevels = o.seniority ?? [];
  const declaredBelow = declaredLevels.filter(level => ['intern', 'junior'].includes(level));
  const declaredSenior = declaredLevels.filter(level => ['senior', 'staff', 'principal', 'lead', 'director', 'executive'].includes(level));
  const belowFloor = declaredLevels.length ? declaredBelow : matchedTerms(titleText, BELOW_FLOOR_TERMS);
  const senior = declaredLevels.length ? declaredSenior : matchedTerms(titleText, SENIOR_TERMS);
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
  // El NÚCLEO manda en el denominador y aporta hasta 20; lo secundario solo suma hasta 5 y nunca
  // entra al denominador. Con una sola lista, declarar honestamente todo lo que uno sabe diluía el
  // promedio y bajaba el puntaje de TODAS las ofertas, castigando por saber de más.
  const match = (list: readonly string[]) => list.flatMap(skill => {
    const hit = skillHit(haystack, skill, config.skillAliases);
    return hit ? [hit] : [];
  });
  const skillsMatched = match(p.skills);
  const secondaryMatched = match(p.secondarySkills);
  // Los 25 puntos se REPARTEN: 20 al núcleo, 5 al bono. La alternativa —dejar que el núcleo
  // llegue a 25 y que el bono solo rellene el hueco— preservaba los puntajes anteriores, pero
  // hacía el bono inalcanzable en toda oferta de núcleo saturado, que son justo las que mejor
  // encajan. Repartiendo, declarar una habilidad secundaria solo puede subir el puntaje, nunca
  // bajarlo, y el techo del componente sigue siendo 25: los umbrales 65/40 no se mueven.
  const corePoints = p.skills.length ? Math.round(CORE_POINTS * (skillsMatched.length / p.skills.length)) : CORE_POINTS / 2;
  const bonusPoints = Math.min(SECONDARY_BONUS_CAP, Math.round(SECONDARY_BONUS_CAP * (secondaryMatched.length / SECONDARY_BONUS_FULL)));
  const skillPoints = Math.min(SKILL_POINTS, corePoints + bonusPoints);
  signals.push({ points: corePoints, reason: p.skills.length ? `Habilidades: ${skillsMatched.length}/${p.skills.length}${skillsMatched.length ? ` (${skillsMatched.join(', ')})` : ''}` : 'Perfil sin habilidades declaradas; puntaje neutro' });
  // La señal se emite aunque el bono sea 0: un "no coincidió ninguna" es una lectura del ranker,
  // y omitirla obligaría a quien inspecciona a distinguir "no hay secundarias" de "no coincidieron".
  if (p.secondarySkills.length) signals.push({ points: bonusPoints, reason: `Habilidades secundarias: ${secondaryMatched.length}/${SECONDARY_BONUS_FULL} para el bono completo${secondaryMatched.length ? ` (${secondaryMatched.join(', ')})` : ''}` });

  // Geografía (0-15).
  const geo = geography(o, config.relocationTargets);
  signals.push(geo.signal);
  if (geo.blocker) blockers.push(geo.blocker);

  // Un tipo explícitamente fuera de los preferidos no bloquea, pero tampoco se premia.
  if (kind !== 'unknown' && !p.preferredKinds.includes(kind)) signals.push({ points: 0, reason: `Tipo ${kind} fuera de los preferidos` });

  // `employer_registered` vale mucho menos que `stated`: dice que el empleador figura en un
  // registro oficial, no que ESTE puesto patrocine. Nunca se equiparan.
  const sponsorshipBonus = o.sponsorship?.status === 'stated' ? 25 : o.sponsorship?.status === 'employer_registered' ? 8 : 0;
  if (sponsorshipBonus) signals.push({ points: 0, reason: `Patrocinio ${o.sponsorship!.status} (${o.sponsorship!.scope ?? 'sin alcance'}); bono de ranking ${sponsorshipBonus}`, evidence: quote('sponsorship', o.sponsorship!.evidence.quote) });

  const score = clamp(rolePoints + seniorityPoints + skillPoints + geo.points);
  const tier: RelevanceTier = blockers.length ? 'off_target' : score >= 65 ? 'strong' : score >= 40 ? 'possible' : 'weak';
  return { score, tier, signals, roleMatched, roleFamily, skillsMatched, secondaryMatched, blockers, sponsorshipBonus };
}
