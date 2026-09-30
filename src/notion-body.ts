/**
 * El cuerpo de la página de Notion: por qué está aquí, cuánto paga, y la descripción publicada.
 *
 * Las 1.258 páginas ya creadas están VACÍAS. Una fila con veinticuatro columnas obliga a abrir la
 * oferta en el navegador para leer de qué va, que es justo el trabajo que este proyecto existe para
 * quitar. El cuerpo se escribe UNA VEZ, cuando la página no tiene hijos, y nunca se reescribe: lo
 * que Juan añada dentro es suyo, y el transporte no admite DELETE sobre bloques para que esa
 * promesa no dependa de recordarla.
 *
 * Reutiliza `money`, `place` y `visa` de `digest.ts` para que el cuerpo y el digest no puedan decir
 * cosas distintas sobre la misma oferta.
 */
import type { Opportunity, Profile } from './contracts.ts';
import { money, place, visa } from './digest.ts';
import { notionRichText } from './pipeline.ts';
import type { evaluate } from './evaluate.ts';
import type { HttpRequest } from './notion-sync.ts';

/** Tope de hijos por petición que impone Notion. */
export const MAX_CHILDREN = 100;
/** Bloques reservados para la descripción. El resto del cuerpo ocupa unos pocos. */
export const DESCRIPTION_BLOCKS = 40;

const text = (content: string) => ({ object: 'block' as const, type: 'paragraph' as const, paragraph: { rich_text: notionRichText([content]) } });
const heading = (content: string) => ({ object: 'block' as const, type: 'heading_2' as const, heading_2: { rich_text: notionRichText([content]) } });
const bullet = (content: string) => ({ object: 'block' as const, type: 'bulleted_list_item' as const, bulleted_list_item: { rich_text: notionRichText([content]) } });
const todo = (content: string) => ({ object: 'block' as const, type: 'to_do' as const, to_do: { rich_text: notionRichText([content]), checked: false } });

export interface BodyInputs {
  opportunity: Opportunity;
  evaluation: ReturnType<typeof evaluate>;
  profile: Profile;
  selectionReason?: string;
}
/**
 * Los bloques del cuerpo. Puro, y acotado al tope de Notion.
 *
 * La descripción se trocea a párrafos de 2000 caracteres y se corta en `DESCRIPTION_BLOCKS`, con una
 * nota de que se cortó: una oferta de 20.000 caracteres son diez párrafos, y dejar el corte sin
 * declarar haría creer que la oferta dice menos de lo que dice.
 */
export function pageBody(inputs: BodyInputs): Record<string, unknown>[] {
  const { opportunity, evaluation, profile, selectionReason } = inputs;
  const relevance = evaluation.relevance;
  const blocks: Record<string, unknown>[] = [
    heading('Por qué está aquí'),
    text(`Relevancia ${relevance.tier} (${relevance.score}/100)${relevance.roleFamily ? ` · familia ${relevance.roleFamily}` : ''}`),
    ...(selectionReason ? [text(selectionReason)] : []),
    ...(relevance.roleMatched.length ? [bullet(`Rol: ${relevance.roleMatched.join(', ')}`)] : []),
    ...(relevance.skillsMatched.length ? [bullet(`Habilidades: ${relevance.skillsMatched.join(', ')}`)] : []),
    ...(relevance.secondaryMatched.length ? [bullet(`Secundarias: ${relevance.secondaryMatched.join(', ')}`)] : []),
    ...(relevance.blockers.length ? [bullet(`Bloqueos: ${relevance.blockers.join(', ')}`)] : []),
    heading('Compensación y modalidad'),
    bullet(money(opportunity, profile)),
    bullet(place(opportunity)),
    ...(visa(opportunity) ? [bullet(visa(opportunity)!)] : []),
  ];
  if (opportunity.description) {
    const paragraphs: string[] = [];
    for (let start = 0; start < opportunity.description.length; start += 2000) paragraphs.push(opportunity.description.slice(start, start + 2000));
    const shown = paragraphs.slice(0, DESCRIPTION_BLOCKS);
    blocks.push(heading('Descripción publicada'), ...shown.map(text));
    if (shown.length < paragraphs.length) blocks.push(text(`[Recortada: ${paragraphs.length - shown.length} bloque(s) más en la oferta original.]`));
  }
  /**
   * La checklist se DERIVA de lo que el registro no pudo confirmar, igual que el bloque de la carta.
   * Una lista fija repite lo ya verificado y calla lo que falta.
   */
  blocks.push(heading('Antes de postularse'),
    ...(opportunity.payDisclosure !== 'published' ? [todo('Confirmar la compensación con la fuente')] : []),
    ...(opportunity.sponsorship?.status !== 'stated' ? [todo('Confirmar autorización de trabajo y patrocinio')] : []),
    ...((opportunity.remoteness ?? 'unknown') === 'unknown' ? [todo('Confirmar modalidad y ubicación')] : []),
    todo('Confirmar que la vacante sigue abierta'));
  return blocks.slice(0, MAX_CHILDREN);
}

const blocksUrl = (pageId: string) => `https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children`;
export const readChildrenRequest = (pageId: string): HttpRequest => ({ method: 'GET', url: blocksUrl(pageId), headers: {}, body: {} });
export const appendChildrenRequest = (pageId: string, children: readonly Record<string, unknown>[]): HttpRequest =>
  ({ method: 'PATCH', url: blocksUrl(pageId), headers: {}, body: { children } });
