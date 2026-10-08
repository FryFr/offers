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
/**
 * Bloques que la descripción publicada puede ocupar, y por qué son pocos.
 *
 * Eran 40 de los 100, y eso era el presupuesto mal repartido. La descripción está a un clic en la
 * URL de la oferta; la carta y el CV adaptado no están en ninguna otra parte. El cuerpo existe para
 * que Juan copie y pegue, no para republicar lo que la fuente ya publica.
 */
export const DESCRIPTION_BLOCKS = 12;
/** Tope de caracteres por fragmento de texto enriquecido que impone Notion. */
const RICH_TEXT_LIMIT = 2000;

const text = (content: string) => ({ object: 'block' as const, type: 'paragraph' as const, paragraph: { rich_text: notionRichText([content]) } });
const heading = (content: string) => ({ object: 'block' as const, type: 'heading_2' as const, heading_2: { rich_text: notionRichText([content]) } });
const subheading = (content: string) => ({ object: 'block' as const, type: 'heading_3' as const, heading_3: { rich_text: notionRichText([content]) } });
const bullet = (content: string) => ({ object: 'block' as const, type: 'bulleted_list_item' as const, bulleted_list_item: { rich_text: notionRichText([content]) } });
const quote = (content: string) => ({ object: 'block' as const, type: 'quote' as const, quote: { rich_text: notionRichText([content]) } });
const todo = (content: string) => ({ object: 'block' as const, type: 'to_do' as const, to_do: { rich_text: notionRichText([content]), checked: false } });

/**
 * Convierte a bloques el MISMO Markdown que ya produce `application-draft.ts`.
 *
 * No se construyen los bloques aparte a propósito. Dos renderizaciones del mismo contenido divergen
 * —esta sesión lo demostró cinco veces: el matcher de habilidades, el quórum de salud, el código de
 * salida—, y aquí divergir significaría que el CV que Juan copia de Notion no es el que el revisor
 * verificó contra los hechos. Una sola fuente: la función que ya existe y ya tiene pruebas.
 *
 * El subconjunto soportado es exactamente lo que esas plantillas emiten: `#`/`##`/`###`, viñetas,
 * citas y párrafos. El énfasis `**` se quita del texto en vez de traducirse a negrita, porque el
 * destino es un formulario web donde se pega texto plano: dejar los asteriscos los pegaría literales.
 */
export function markdownBlocks(markdown: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const plain = (s: string) => s.replace(/\*\*/g, '').trim();
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // El título `#` de la plantilla se omite: la página de Notion ya se llama como la oferta, y
    // repetirlo dentro gasta un bloque en decir lo que el encabezado de la página ya dice.
    if (line.startsWith('# ')) continue;
    if (line.startsWith('### ')) { blocks.push(subheading(plain(line.slice(4)))); continue; }
    if (line.startsWith('## ')) { blocks.push(heading(plain(line.slice(3)))); continue; }
    if (line.startsWith('- ')) { blocks.push(bullet(plain(line.slice(2)))); continue; }
    if (line.startsWith('> ')) { blocks.push(quote(plain(line.slice(2)))); continue; }
    // Un párrafo más largo que el tope de Notion se trocea en vez de perderse.
    const body = plain(line);
    for (let start = 0; start < body.length; start += RICH_TEXT_LIMIT) blocks.push(text(body.slice(start, start + RICH_TEXT_LIMIT)));
  }
  return blocks;
}

export interface BodyInputs {
  opportunity: Opportunity;
  evaluation: ReturnType<typeof evaluate>;
  profile: Profile;
  selectionReason?: string;
  /**
   * El material de postulación, ya renderizado por `application-draft.ts`.
   *
   * Opcional porque sin un `data/candidate-facts-<familia>.json` no hay hechos que citar, y una
   * carta inventada es exactamente lo que este proyecto existe para no hacer. Si falta, el cuerpo
   * sale como antes y lo dice.
   */
  material?: { coverLetter: string; cv: string };
}
/**
 * Los bloques del cuerpo. Puro, y acotado al tope de Notion.
 *
 * La descripción se trocea a párrafos de 2000 caracteres y se corta en `DESCRIPTION_BLOCKS`, con una
 * nota de que se cortó: una oferta de 20.000 caracteres son diez párrafos, y dejar el corte sin
 * declarar haría creer que la oferta dice menos de lo que dice.
 */
export function pageBody(inputs: BodyInputs): Record<string, unknown>[] {
  const { opportunity, evaluation, profile, selectionReason, material } = inputs;
  const relevance = evaluation.relevance;
  /**
   * EL MATERIAL VA PRIMERO, y ese es el cambio que importa.
   *
   * Antes el cuerpo abría con la relevancia y la descripción publicada, y la carta y el CV no
   * estaban en ninguna parte: se escribían en `output/candidacy/<id>/` como archivos locales que
   * nadie abre. Juan pidió verlos EN la oferta para copiar y pegar, y tenía razón: el tablero es
   * donde decide a qué postularse, así que es donde tiene que estar lo que va a enviar.
   */
  const blocks: Record<string, unknown>[] = material
    // Los encabezados van AQUÍ y no en las plantillas: el `#` del Markdown es el título de la
    // oferta, que la página ya tiene, y sin estas dos secciones la carta y el CV quedan pegados en
    // un solo muro donde no se ve dónde termina lo que hay que copiar.
    ? [heading('Carta de presentación'), ...markdownBlocks(material.coverLetter),
       heading('CV adaptado'), ...markdownBlocks(material.cv),
       heading('Contexto de la oferta')]
    : [text('[Sin material: falta data/candidate-facts-<familia>.json para esta familia de rol. '
        + 'No se inventa una carta sin hechos declarados.]')];
  blocks.push(
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
    ...(visa(opportunity) ? [bullet(visa(opportunity)!)] : []));
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

/**
 * Subida de un archivo a Notion, en los dos pasos que exige su API.
 *
 * El CV y la carta viajan como PDF porque a una postulación se SUBE un archivo; el texto del cuerpo
 * sirve para leer y decidir, no para adjuntar a un formulario.
 */
export const createUploadRequest = (filename: string): HttpRequest =>
  ({ method: 'POST', url: 'https://api.notion.com/v1/file_uploads', headers: { 'Notion-Version': '2022-06-28' },
    body: { filename, content_type: 'application/pdf' } });
export const sendUploadRequest = (uploadId: string, form: FormData): HttpRequest =>
  ({ method: 'POST', url: `https://api.notion.com/v1/file_uploads/${encodeURIComponent(uploadId)}/send`,
    headers: { 'Notion-Version': '2022-06-28' }, body: {}, form });
/** El bloque que enseña el PDF dentro de la página, con su nombre visible. */
export const fileBlock = (uploadId: string, name: string) =>
  ({ object: 'block' as const, type: 'file' as const, file: { type: 'file_upload' as const, file_upload: { id: uploadId }, name } });

const blocksUrl = (pageId: string) => `https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children`;
export const readChildrenRequest = (pageId: string): HttpRequest => ({ method: 'GET', url: blocksUrl(pageId), headers: {}, body: {} });
export const appendChildrenRequest = (pageId: string, children: readonly Record<string, unknown>[]): HttpRequest =>
  ({ method: 'PATCH', url: blocksUrl(pageId), headers: {}, body: { children } });
