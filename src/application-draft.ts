/**
 * Material de postulación a partir de hechos DECLARADOS. Puro, sin I/O.
 *
 * Y determinista a propósito, no por falta de ganas de usar un modelo. `claude-enrichment.ts` es un
 * precedente de extracción verificable: cada habilidad que Claude propone se comprueba con
 * `description.includes(skill.quote)`, así que una cita fabricada es imposible. **Una carta de
 * presentación no tiene contra qué verificarse.** Si un modelo escribe "led a team that reduced
 * processing time by 98%", no hay documento fuente contra el cual comprobarlo: lo único que la
 * respalda es el CV, y comparar prosa contra prosa es justo el problema que ese módulo evita.
 *
 * Por eso aquí solo se SELECCIONA y se REORDENA lo que la persona ya declaró, y los huecos se
 * marcan para que los complete a mano. La prueba central del módulo es que toda frase sustantiva
 * de la salida existe literalmente en `CandidateFacts`.
 */
import type { CandidateFacts } from './candidacy.ts';
import type { Opportunity, Profile } from './contracts.ts';
import { money, place, visa } from './digest.ts';
import { canonical, contains } from './text.ts';

/** Logros que se ofrecen para la carta, con el puesto del que salieron. */
export interface SelectedAchievement { company: string; role: string; achievement: string; matched: string[] }
/** Cuántos logros lleva el párrafo de evidencia. Tres es el máximo que caben sin volverse una lista. */
export const MAX_ACHIEVEMENTS = 3;

/**
 * Elige los logros que tocan lo que la oferta pide, sin reescribir ninguno.
 *
 * El orden sale de cuántas habilidades halladas en la oferta menciona cada logro, y los empates se
 * rompen por recencia del puesto —`experience` ya viene del presente al pasado—. Un logro que no
 * toca nada sigue siendo elegible cuando no hay mejores: es mejor ofrecer evidencia real floja que
 * dejar el párrafo vacío, y quien revisa decide.
 */
export function selectAchievements(facts: CandidateFacts, matched: readonly string[], limit = MAX_ACHIEVEMENTS): SelectedAchievement[] {
  // Se conservan los huecos en lugar de filtrarlos: `needles` tiene que quedar alineado índice a
  // índice con `matched`, y un `filter(Boolean)` desplazaba los índices y atribuía la coincidencia de
  // una habilidad a otra. `contains` ya devuelve false para una cadena vacía.
  const needles = matched.map(skill => canonical(skill));
  const scored = (facts.experience ?? []).flatMap((experience, position) => experience.achievements.map(achievement => {
    const haystack = canonical(achievement);
    const hits = matched.filter((_, index) => contains(haystack, needles[index]!));
    return { company: experience.company, role: experience.role, achievement, matched: hits, position };
  }));
  return scored
    .sort((a, b) => b.matched.length - a.matched.length || a.position - b.position)
    .slice(0, limit)
    .map(({ company, role, achievement, matched: hits }) => ({ company, role, achievement, matched: hits }));
}

/**
 * Lo que hay que confirmar antes de enviar, CALCULADO de los huecos del registro.
 *
 * Las cartas escritas a mano llevaban esta lista fija, y por eso repetía cosas ya confirmadas y
 * omitía las que faltaban. Aquí sale de lo que el propio registro no pudo verificar, reusando las
 * mismas funciones que redactan el digest para que los dos no puedan contradecirse.
 */
export function beforeSending(opportunity: Opportunity, profile: Profile): string[] {
  const items: string[] = [];
  if (opportunity.payDisclosure !== 'published') items.push(`confirm compensation (${money(opportunity, profile)})`);
  if (opportunity.sponsorship?.status !== 'stated') items.push(`confirm work authorisation and sponsorship (${visa(opportunity) ?? 'the listing says nothing'})`);
  if ((opportunity.remoteness ?? 'unknown') === 'unknown') items.push(`confirm location and working model (${place(opportunity)})`);
  // Siempre, sin excepción: la evidencia de disponibilidad tiene un TTL de 24 h y una oferta puede
  // cerrarse entre el ciclo y el envío. Ninguna comprobación previa sustituye mirar la página.
  items.push('confirm the listing is still open');
  return items;
}

export interface DraftInputs {
  facts: CandidateFacts;
  opportunity: Opportunity;
  profile: Profile;
  matched: readonly string[];
  selected: readonly SelectedAchievement[];
}
const PENDING = '[TO COMPLETE: join into prose; do not add figures or claims that are not above]';

/**
 * Borrador de carta con la estructura de las cartas escritas a mano: inglés, saludo genérico, tres
 * párrafos y firma con el nombre completo.
 *
 * El párrafo de evidencia son los logros elegidos **verbatim** como viñetas, más una marca de lo que
 * falta. No se unen en prosa aquí porque unirlos es exactamente donde se cuela una afirmación nueva.
 */
export function renderCoverLetterDraft(inputs: DraftInputs): string {
  const { facts, opportunity, profile, matched, selected } = inputs;
  const headline = facts.headline ?? facts.name;
  const current = (facts.experience ?? [])[0];
  return `# ${opportunity.title} — ${opportunity.company}

Dear Hiring Team,

I am writing about the ${opportunity.title} role at ${opportunity.company}. I work as ${headline}${current ? ` at ${current.company}` : ''}. ${PENDING}

${selected.length ? selected.map(item => `- ${item.achievement}`).join('\n') : '- [TO COMPLETE: no declared achievement matches this posting]'}

${PENDING}

I would welcome a conversation about the role.${facts.contact?.links?.length ? ` My work is at ${facts.contact.links[0]}.` : ''}

Kind regards,
${facts.name}

**Before sending:** ${beforeSending(opportunity, profile).join('; ')}.

> Internal draft. No application or message has been sent.
${matched.length ? `>\n> Skills found in this posting: ${matched.join(', ')}.` : ''}
`;
}

/**
 * CV adaptado: los grupos de habilidades se reordenan por coincidencias, y dentro de cada uno las
 * coincidentes van primero.
 *
 * **`experience` NO se reordena ni se recorta.** La cronología es un hecho y borrar un puesto falsea
 * la línea de tiempo; lo único que se reordena son los logros DENTRO de cada puesto. Eso es adaptar
 * un CV. Quitar un empleo para que cuadre mejor sería otra cosa, y el contrato no lo permite.
 */
export function renderTailoredCv(inputs: DraftInputs): string {
  // Toda la plantilla se mantiene en ASCII: ni raya larga ni punto medio. El mismo importador de ATS
  // que convierte "2019\u20132026" en "20192026" descarta cualquier otro carácter fuera de ASCII, y
  // predicar la regla para las fechas mientras la estructura la incumple no tiene sentido.
  const { facts, matched } = inputs;
  const needles = matched.map(skill => canonical(skill));
  const hits = (text: string) => needles.filter(needle => contains(canonical(text), needle)).length;
  const groups = [...(facts.skillGroups ?? [])]
    .map(group => ({ ...group, score: group.skills.reduce((sum, skill) => sum + (hits(skill) ? 1 : 0), 0),
      skills: [...group.skills].sort((a, b) => hits(b) - hits(a)) }))
    .sort((a, b) => b.score - a.score);
  const period = (start: string, end?: string) => `${start} - ${end ?? 'present'}`;
  const experience = (facts.experience ?? []).map(entry => {
    const ordered = [...entry.achievements].sort((a, b) => hits(b) - hits(a));
    return `### ${entry.role} - ${entry.company}\n${period(entry.start, entry.end)}${entry.location ? ` | ${entry.location}` : ''}\n${ordered.map(a => `- ${a}`).join('\n')}`;
  });
  return `# ${facts.name}

${facts.headline ?? ''}${facts.location ? `\n${facts.location}` : ''}${facts.contact?.links?.length ? `\n${facts.contact.links.join(' | ')}` : ''}

## Skills

${groups.length ? groups.map(group => `- **${group.name}:** ${group.skills.join(', ')}`).join('\n') : '- [TO COMPLETE: declare skillGroups in CandidateFacts]'}

## Experience

${experience.length ? experience.join('\n\n') : '[TO COMPLETE: declare experience in CandidateFacts]'}

## Education

${(facts.education ?? []).map(e => `- **${e.degree}**, ${e.institution} | ${period(e.start, e.end)}`).join('\n') || '[TO COMPLETE: declare education in CandidateFacts]'}

## Languages

${(facts.languages ?? []).map(l => `- ${l.name}: ${l.level}${l.evidence ? ` (${l.evidence})` : ''}`).join('\n') || '[TO COMPLETE: declare languages in CandidateFacts]'}

> Internal draft. Verify role-specific claims, sponsorship and salary before use.
`;
}
