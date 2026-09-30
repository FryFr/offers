import type { SponsorshipSignal, SponsorshipScope } from './contracts.ts';

/**
 * Señal de patrocinio de visado a partir del TEXTO que publica la fuente.
 *
 * Todo se sostiene en una cita literal: se guarda la ventana exacta que decidió y se comprueba
 * que la descripción la contenga. Es la misma invariante que exige el enriquecimiento con Claude,
 * y es lo que separa "la oferta dice que patrocina" de "creemos que patrocina".
 *
 * Dos decisiones de diseño, ambas nacidas de falsos positivos medidos el 2026-09-20 sobre 3.464
 * ofertas reales:
 *
 * 1. La mención debe ser INEQUÍVOCAMENTE migratoria. Las palabras "sponsor" y "sponsorship"
 *    sueltas no bastan: GitLab disparaba con "named executive sponsor", que es un rol interno.
 *
 * 2. La polaridad se decide en una VENTANA alrededor de la mención, no en la oración entera.
 *    Sin esto, "Develop deep, strategic (not transactional) relationships… executive sponsor"
 *    se leía como negativa, y una lista con viñetas mal delimitada contaminaba miles de
 *    caracteres con una sola negación lejana.
 */

/**
 * Términos que solo aparecen hablando del derecho a trabajar en un país. Deliberadamente NO
 * incluye "relocation": la ayuda para mudarse es dinero para el trasteo, no permiso de trabajo,
 * y confundirlos prometería algo que la oferta no dijo.
 */
const IMMIGRATION = /\b(visas?|work permits?|right to work|work authoriz\w*|employment authoriz\w*|authoriz\w* to work|legally authoriz\w*|blue card|skilled worker|immigration|h-?1b|green card)\b/i;
/** Negación dentro de la ventana. Amplia a propósito: ante la duda, no se afirma que patrocinan. */
const NEGATED = /\b(not|no|non|never|unable|cannot|can ?not|won'?t|will not|do(?:es)? not|don'?t|doesn'?t|isn'?t|aren'?t|without|ineligible|unfortunately|excluding)\b/i;
/**
 * Negación que recae SOBRE el patrocinio, no sobre cualquier palabra migratoria cercana.
 * Sin esta distinción, el boilerplate legal "this information is collected solely for immigration
 * compliance purposes and will be not used as a criterion in any hiring decision" se leía como
 * "esta empresa no patrocina" — medido en ofertas reales de Scale AI.
 */
const DENIED = new RegExp([
  `\\b(?:${NEGATED.source.slice(2, -2)})\\b[^.!?]{0,40}\\b(?:sponsor\\w*|visas?|work permits?)\\b`,
  '\\b(?:sponsor\\w*)\\b[^.!?]{0,25}\\b(?:not available|unavailable|not offered|not provided|is not|are not)\\b',
  '\\bwithout\\s+(?:a\\s+|visa\\s+|any\\s+)?sponsorship\\b',
].join('|'), 'i');
/** Afirmación explícita de que la empresa patrocina. */
const AFFIRMED = /\b(we (do )?sponsor|will sponsor|can sponsor|happy to sponsor|able to sponsor|offers? (visa )?sponsorship|provides? (visa )?sponsorship|sponsorship (is )?available|we (will )?provide .{0,30}(visa|sponsorship|work permit)|visa support|immigration support|sponsor(ing)? (work )?visas?|certificate of sponsorship|licensed sponsor)\b/i;
const SCOPE_MARKERS: [RegExp, SponsorshipScope][] = [
  [/skilled worker|certificate of sponsorship|home office|tier 2/i, 'uk_skilled_worker'],
  [/blue card|eu blue|schengen|european union/i, 'eu'],
  [/h-?1b|h1-b|green card|\bperm\b|united states|u\.s\./i, 'us_h1b'],
];
/** Contexto a cada lado de la mención. Suficiente para leer la frase, corto para no arrastrar ruido. */
const BEFORE = 120, AFTER = 160;
/**
 * Distancia a la que una negación todavía modifica lo que sigue. "We are NOT able to sponsor"
 * niega; un "not" a cien caracteres habla de otra cosa. Sin esta cota, "Develop deep, strategic
 * (not transactional) relationships… executive sponsors" se leía como negativa.
 */
const NEGATION_REACH = 40;
/**
 * Recorta la ventana a palabras enteras SIN dejar de ser subcadena de la descripción.
 *
 * La ventana es un corte por número de caracteres, así que empieza y acaba a mitad de palabra: leída
 * en el tablero decía «l staff to be in one of our offices at le», que parece un dato corrupto
 * aunque la detección fuera correcta. Recortar hasta el espacio más cercano lo vuelve legible y
 * mantiene el invariante que sostiene todo esto —`parseOpportunity` exige que la cita aparezca
 * LITERALMENTE en la descripción—, porque una subcadena de una subcadena sigue siéndolo.
 *
 * Se aplica SOLO a la cita que se guarda, nunca a la ventana con la que se decide. Recortar antes de
 * decidir destruía señales reales: «Applicants must be authorized to work in the United States
 * w[ithout sponsorship]» perdía la negación al cortar la última palabra y la oferta pasaba de
 * `stated_none` a sin señal. Detectar sobre el texto completo, presentar recortado.
 *
 * Si el recorte se comiera la mención que disparó la ventana, se devuelve la ventana entera: la
 * legibilidad no puede costar la evidencia.
 */
function toWholeWords(window: string, mention: string): string {
  const first = window.search(/\s/);
  const last = window.search(/\s\S*$/);
  const trimmed = window.slice(first === -1 ? 0 : first + 1, last === -1 ? window.length : last).trim();
  return trimmed.includes(mention) ? trimmed : window;
}
/** Menciones examinadas por descripción: más allá, el texto ya habló. */
const MAX_MENTIONS = 12;

const scopeOf = (window: string) => SCOPE_MARKERS.find(([pattern]) => pattern.test(window))?.[1] ?? 'unspecified';

/**
 * Lee la descripción. Devuelve `undefined` cuando no hay nada que afirmar: una mención sin verbo
 * ("Visa sponsorship:" como encabezado) no es promesa ni negativa. Una afirmación explícita manda
 * sobre los matices posteriores: "patrocinamos, pero no para todos los roles" sigue siendo una
 * empresa que patrocina.
 */
export function sponsorshipFromDescription(description: string | undefined, observedAt: string): SponsorshipSignal | undefined {
  if (!description) return undefined;
  let negative: { window: string; mention: string } | undefined;
  let seen = 0;
  const pattern = new RegExp(IMMIGRATION.source, 'gi');
  for (const match of description.matchAll(pattern)) {
    if (++seen > MAX_MENTIONS) break;
    const at = match.index;
    const start = Math.max(0, at - BEFORE);
    const window = description.slice(start, at + match[0].length + AFTER);
    // Una afirmación cuenta solo si nada la niega justo antes. Así "We do sponsor visas!" es
    // positiva aunque más adelante aclare "aren't able to sponsor for every role", y
    // "we aren't able to sponsor" no se cuela por contener "able to sponsor".
    const affirmed = AFFIRMED.exec(window);
    if (affirmed && !NEGATED.test(window.slice(Math.max(0, affirmed.index - NEGATION_REACH), affirmed.index))) {
      return { status: 'stated', scope: scopeOf(window), evidence: { kind: 'description_phrase', source: 'affirms_sponsorship_near_mention', quote: toWholeWords(window, match[0]), observedAt } };
    }
    if (DENIED.test(window)) negative ??= { window, mention: match[0] };
  }
  if (!negative) return undefined;
  return { status: 'stated_none', scope: scopeOf(negative.window), evidence: { kind: 'description_phrase', source: 'denies_sponsorship_near_mention', quote: toWholeWords(negative.window, negative.mention), observedAt } };
}
