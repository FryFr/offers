/**
 * Normalización compartida por screening (exclusión) y relevance (inclusión).
 * Vive aparte a propósito: dos normalizadores distintos harían que un mismo término
 * excluyera en un módulo y no coincidiera en el otro, sin que ninguna prueba lo notara.
 */

/** NFD sin diacríticos, minúsculas, cualquier no alfanumérico colapsado a un espacio. */
export const canonical = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Coincidencia de frase completa con límites de espacio, nunca substring:
 * "lead" no debe coincidir dentro de "leadership", ni "go" dentro de "google".
 * Ambos argumentos deben venir ya canonicalizados.
 */
export const contains = (text: string, term: string) => term.length > 0 && ` ${text} `.includes(` ${term} `);

/** Los términos de `terms` presentes en `text`, en el orden en que se declararon y sin repetir. */
export function matchedTerms(text: string, terms: readonly string[]): string[] {
  const found: string[] = [];
  for (const term of terms) {
    const needle = canonical(term);
    if (contains(text, needle) && !found.includes(term)) found.push(term);
  }
  return found;
}
