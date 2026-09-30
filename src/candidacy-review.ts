/**
 * Revisa el paquete de candidatura contra los hechos declarados, antes de entregarlo.
 *
 * Es el bucle drafter-reviewer de `MadsLorentzen/ai-job-search`, invertido en lo único que importa:
 * **el revisor no redacta.** Allá el revisor es un segundo agente LLM que devuelve ediciones y hace
 * una "grounding audit" de tres fuentes... ejecutada por el mismo modelo que escribió el borrador.
 * Eso es confianza con buenos modales. Aquí el revisor es una función pura que compara texto contra
 * hechos y emite hallazgos; no propone una sola palabra.
 *
 * Si algún día se enchufa un revisor LLM, entra como SEGUNDO revisor cuyos hallazgos son sugerencias.
 * El determinista es el que bloquea.
 */
import type { CandidateFacts } from './candidacy.ts';
import type { Opportunity } from './contracts.ts';
import { canonical, contains } from './text.ts';

export interface Finding {
  /** `blocking` impide entregar el paquete; `warning` se reporta y se sigue. */
  severity: 'blocking' | 'warning';
  code: string;
  detail: string;
}
export interface ReviewInputs {
  facts: CandidateFacts;
  opportunity: Opportunity;
  /** El cuerpo Markdown de la carta, tal como se va a escribir. */
  letter: string;
  /** El CV adaptado, tal como se va a escribir. */
  cv: string;
  /** `relevance.roleFamily` de esta oferta, si la hubo. */
  roleFamily?: string;
  matched?: readonly string[];
}

/** Marcas de hueco que el generador deja a propósito; no son prosa que haya que respaldar. */
const PLACEHOLDER = /\[TO COMPLETE:[^\]]*\]/g;
/** Una línea es "sustantiva" si afirma algo sobre la persona. Las viñetas son el caso duro. */
const bullets = (markdown: string) => markdown.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).trim());

/**
 * Hallazgos contra los hechos. Vacío significa que se puede entregar.
 *
 * La primera comprobación es la misma garantía que prueba `application-draft.ts`, reutilizada aquí
 * como función para que valga también sobre un archivo ya escrito a disco: si alguien edita el
 * borrador a mano y añade una cifra, el revisor lo ve.
 */
export function reviewCandidacy(inputs: ReviewInputs): Finding[] {
  const { facts, letter, cv, roleFamily, matched = [] } = inputs;
  const findings: Finding[] = [];
  const declared = new Set([
    ...facts.highlights,
    ...(facts.experience ?? []).flatMap(e => e.achievements),
  ].map(value => value.trim()));

  // 1. Toda viñeta de la carta existe LITERAL en los hechos. Es la que impide que alguien meta prosa
  //    generada, a mano o con un modelo, sin que nada lo note.
  for (const bullet of bullets(letter.replace(PLACEHOLDER, ''))) {
    if (bullet && !declared.has(bullet)) findings.push({ severity: 'blocking', code: 'unsupported_claim', detail: bullet.slice(0, 160) });
  }

  // 2. Ninguna habilidad afirmada en el CV está fuera de los grupos declarados. Un grupo es el único
  //    sitio donde una habilidad puede nacer; si aparece en el CV y no en los hechos, se inventó.
  const groupSkills = new Set((facts.skillGroups ?? []).flatMap(g => g.skills.map(s => canonical(s))));
  const cvSkillLines = cv.split('\n').filter(line => /^- \*\*/.test(line));
  for (const line of cvSkillLines) {
    const listed = (line.split(':**')[1] ?? '').split(',').map(s => canonical(s)).filter(Boolean);
    for (const skill of listed) {
      if (!groupSkills.has(skill)) findings.push({ severity: 'blocking', code: 'undeclared_skill', detail: skill });
    }
  }

  // 3. La cronología está completa y ordenada, y ningún puesto desapareció del CV. Recortar un empleo
  //    para que el CV cuadre mejor falsea la línea de tiempo, y es la tentación más fácil de ceder.
  const experience = facts.experience ?? [];
  for (const entry of experience) {
    if (!cv.includes(entry.company)) findings.push({ severity: 'blocking', code: 'missing_role', detail: `${entry.role} — ${entry.company}` });
  }
  for (const [index, entry] of experience.entries()) {
    const next = experience[index + 1];
    if (next && next.start > entry.start) findings.push({ severity: 'blocking', code: 'chronology_out_of_order', detail: `${next.company} antes de ${entry.company}` });
    // Un puesto sin fin que no es el más reciente significa dos empleos vigentes a la vez. Puede ser
    // cierto, así que avisa en vez de bloquear: quien revisa sabe si fue simultáneo.
    if (entry.end === undefined && index > 0) findings.push({ severity: 'warning', code: 'overlapping_current_role', detail: entry.company });
  }

  // 4. El titular corresponde a la familia de rol de la oferta. Mandar el CV de robótica a un puesto
  //    de management es peor que no mandar nada, y es el fallo que la familia de rol existe para evitar.
  if (roleFamily && facts.headline) {
    const family = roleFamily.replace(/_/g, ' ');
    const words = family.split(' ').filter(word => word.length > 2);
    if (words.length && !words.some(word => contains(canonical(facts.headline!), word))) {
      findings.push({ severity: 'warning', code: 'headline_family_mismatch', detail: `titular "${facts.headline}" para la familia ${roleFamily}` });
    }
  }

  // 5. Hay al menos un logro que toca algo que la oferta pide. Sin eso el paquete es genérico, y un
  //    paquete genérico no es una candidatura adaptada: es el CV de siempre con otro encabezado.
  if (matched.length) {
    const needles = matched.map(skill => canonical(skill));
    const touches = [...declared].some(claim => needles.some(needle => contains(canonical(claim), needle)));
    if (!touches) findings.push({ severity: 'warning', code: 'no_achievement_matches_posting', detail: matched.join(', ') });
  }

  // 6. Los huecos sin completar se cuentan. No bloquean —existen para que la persona los llene— pero
  //    entregar un paquete sin mirarlos es enviar un borrador.
  const pending = (letter.match(PLACEHOLDER) ?? []).length + (cv.match(PLACEHOLDER) ?? []).length;
  if (pending) findings.push({ severity: 'warning', code: 'pending_placeholders', detail: String(pending) });

  return findings;
}
/** Un paquete se entrega cuando ningún hallazgo bloquea. Los avisos se leen, no detienen. */
export const deliverable = (findings: readonly Finding[]) => !findings.some(finding => finding.severity === 'blocking');
