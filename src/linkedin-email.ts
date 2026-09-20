import type { ExternalAlert, ExternalAlertEnvelope } from './external-alerts.ts';

export interface MailContext { from?: string; subject?: string }
export interface ParsedMail { envelope: ExternalAlertEnvelope; status: 'parsed' | 'ignored' | 'unrecognized'; reason?: string }
const empty = (status: ParsedMail['status'], reason: string): ParsedMail => ({ envelope: { schemaVersion: 1, alerts: [] }, status, reason });

function quotedPrintable(text: string): Buffer {
  const unfolded = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    if (unfolded[i] === '=' && /^[a-f\d]{2}$/i.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16)); i += 2;
    } else bytes.push(...Buffer.from(unfolded[i]!));
  }
  return Buffer.from(bytes);
}
function decode(text: string, encoding: string, charset: string): string {
  if (!['base64', 'quoted-printable'].includes(encoding)) return text;
  if (encoding === 'base64' && !/^[A-Za-z\d+/\s]*={0,2}\s*$/.test(text)) throw new Error('MIME: base64 inválido');
  const bytes = encoding === 'base64' ? Buffer.from(text, 'base64') : quotedPrintable(text);
  try { return new TextDecoder(charset, { fatal: true }).decode(bytes); }
  catch { throw new Error('MIME: charset o contenido inválido'); }
}
function headerWords(text: string): string {
  return text.replace(/(\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_, charset: string, encoding: string, body: string) => decode(encoding.toLowerCase() === 'q' ? body.replace(/_/g, ' ') : body, encoding.toLowerCase() === 'b' ? 'base64' : 'quoted-printable', charset));
}
function splitMail(raw: string): { headers: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const head = split < 0 ? '' : normalized.slice(0, split);
  if (!/^(?:From|Subject|Date|MIME-Version|Content-Type|Return-Path|Received|To):/im.test(head)) return { headers: {}, body: normalized };
  const headers: Record<string, string> = Object.create(null);
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      const key = match[1]!.toLowerCase();
      if (headers[key] !== undefined && ['from', 'subject', 'content-type', 'content-transfer-encoding'].includes(key)) throw new Error('MIME: cabecera duplicada');
      headers[key] = headerWords(match[2]!);
    }
  }
  return { headers, body: normalized.slice(split + 2) };
}
function entity(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', bull: '•' };
  return text.replace(/&(#x[a-f\d]+|#\d+|[a-z]+);/gi, (raw, key: string) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? raw;
    const code = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
  });
}
function textLines(text: string): string[] {
  return entity(text).split('\n').map(line => line.replace(/[\t \u00a0]+/g, ' ').trim()).filter(Boolean);
}
// Exact localized digest count; arbitrary introductory text remains unsupported.
const globalLine = /^[1-9]\d* nuevos empleos coinciden con tus preferencias\.$|^(?:ver todos los empleos|view all jobs|gestionar alertas|editar alerta|nuevos empleos|tu alerta de empleo|empleos de)\b/i;
const decoration = /^(?:[-–—_]{3,}|esta empresa busca personal activamente|en busca de personal|solicitar con perfil y CV|1 contacto|(?:[2-9]|[1-9]\d+) contactos|1 persona estudió en la misma institución educativa que tú|[1-9]\d* personas estudiaron en la misma institución educativa que tú)$/i;
const salary = /^\d+(?:[.,]\d+)? US\$-\d+(?:[.,]\d+)? US\$ \/ hora$|(?:US\$|\$|€|£|USD|EUR).*(?:\/\s*(?:año|mes|year|month|hour)|\b(?:anuales|annually)\b)/i;
function validField(value: string): boolean {
  return !!value && !/(?:https?:\/\/|www\.)/i.test(value) && !globalLine.test(value)
    && !decoration.test(value) && !salary.test(value) && !action.test(value);
}
function htmlText(html: string): string {
  // Keep ancestor boundaries and anchor identity, including LinkedIn's nested anchors.
  // Unsupported layouts retain their job URL so the caller rejects the message.
  interface Node { tag: string; href?: string; parent?: Node; children: (Node | string)[] }
  const root: Node = { tag: '', children: [] };
  let current = root;
  const anchors: Node[] = [];
  const clean = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const token of clean.matchAll(/<[^>]*>|[^<]+/g)) {
    const value = token[0];
    if (!value.startsWith('<')) { current.children.push(value); continue; }
    const closing = value.match(/^<\/([\w-]+)/);
    if (closing) {
      let node: Node | undefined = current;
      while (node && node.tag !== closing[1]!.toLowerCase()) node = node.parent;
      if (node?.parent) current = node.parent;
      continue;
    }
    const tag = value.match(/^<([\w-]+)/)?.[1]?.toLowerCase();
    if (!tag) continue;
    if (tag === 'br') { current.children.push('\n'); continue; }
    const href = value.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const node: Node = { tag, parent: current, children: [], ...(href ? { href: entity(href[1] ?? href[2] ?? href[3]!) } : {}) };
    current.children.push(node);
    if (tag === 'a' && node.href && jobUrl(node.href)) anchors.push(node);
    if (!/^(?:img|meta|link|hr|input|wbr)$/.test(tag) && !/\/\s*>$/.test(value)) current = node;
  }
  const content = (node: Node): string => node.children.map(child => typeof child === 'string' ? child
    : `${/^(?:p|div|tr|td|li|h[1-6]|table)$/.test(child.tag) ? '\n' : ''}${content(child)}${/^(?:p|div|tr|td|li|h[1-6]|table)$/.test(child.tag) ? '\n' : ''}`).join('');
  const cards = new Map<string, Set<string>>();
  for (const anchor of anchors) {
    const link = jobUrl(anchor.href!)!;
    if (!cards.has(link.url)) cards.set(link.url, new Set());
    // A title anchor must contain text only (inline emphasis is fine).
    if (anchor.children.some(child => typeof child !== 'string' && /^(?:table|div|p|a|img)$/.test(child.tag))) continue;
    const title = textLines(content(anchor)).join(' ');
    if (!validField(title)) continue;
    for (let node = anchor.parent; node && node !== root; node = node.parent) {
      const lines = textLines(content(node)).filter(line => !action.test(line) && !decoration.test(line) && !salary.test(line));
      if (lines[0] !== title) break;
      const metadata = lines.length === 2 ? lines[1]!.split(/\s+·\s+/) : lines.slice(1);
      if (metadata.length === 2 && lines.length <= 3 && metadata.every(validField)) {
        cards.get(link.url)!.add(`Title: ${title}\nCompany: ${metadata[0]}\nLocation: ${metadata[1]}\n${link.url}`);
        break;
      }
      if (lines.length > 3) break;
    }
  }
  return [...cards].map(([url, candidates]) => candidates.size === 1 ? [...candidates][0] : url).join('\n---\n');
}
function mimeText(raw: string, depth = 0): string {
  if (depth > 12) throw new Error('MIME: profundidad excesiva');
  const { headers, body } = splitMail(raw);
  const type = headers['content-type'] ?? 'text/plain';
  if (/attachment/i.test(headers['content-disposition'] ?? '')) return '';
  if (/^multipart\//i.test(type)) {
    const boundary = type.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    const marker = boundary?.[1] ?? boundary?.[2];
    if (!marker) throw new Error('MIME: boundary ausente');
    const parts: string[] = []; let current: string[] | undefined; let closed = false;
    for (const line of body.split('\n')) {
      if (line.trimEnd() === `--${marker}` || line.trimEnd() === `--${marker}--`) {
        if (current) parts.push(current.join('\n'));
        if (line.trimEnd() === `--${marker}--`) { closed = true; break; }
        current = [];
      } else current?.push(line);
    }
    if (!closed) throw new Error('MIME: multipart incompleto');
    // Alternatives are representations of the same message, not separate jobs.
    if (/^multipart\/alternative/i.test(type)) {
      const plain = parts.find(part => /^text\/plain\b/i.test(splitMail(part).headers['content-type'] ?? ''));
      if (plain && mimeText(plain, depth + 1).trim()) return mimeText(plain, depth + 1);
    }
    return parts.map(part => mimeText(part, depth + 1)).filter(Boolean).join('\n\n');
  }
  if (!/^text\/(plain|html)\b/i.test(type)) return '';
  const charset = type.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1] ?? 'utf-8';
  const decoded = decode(body, (headers['content-transfer-encoding'] ?? '').toLowerCase(), charset);
  return /^text\/html/i.test(type) || /^\s*<(?:!doctype|html|div|table|p)\b/i.test(decoded) ? htmlText(decoded) : decoded;
}
const jobSignal = /\b(job alerts?|jobs? (?:for you|recommendations)|recommended jobs|new jobs|hiring|vacan(?:te|tes)|alertas? de empleo|empleos? (?:para ti|nuevos)|oportunidades laborales)\b/i;
const nonJob = /\b(newsletter|news digest|invitation|invitaci[oó]n|connect with|conectar|security|seguridad|verification code|c[oó]digo de verificaci[oó]n|password|contrase[nñ]a|sign.in|inicio de sesi[oó]n|extracto|bank statement|transferencia|payment receipt)\b/i;
export function isLinkedInJobAlert(from: string | undefined, subject: string, body = ''): boolean {
  if (from) {
    const addresses = from.match(/[A-Z\d.!#$%&'*+/=?^_`{|}~-]+@[A-Z\d.-]+/gi) ?? [];
    if (addresses.length !== 1 || !/@(?:[a-z\d-]+\.)*linkedin\.com$/i.test(addresses[0]!)) return false;
    // Newsletter copy can mention jobs without being a job alert.
    if (/^newsletters-noreply@linkedin\.com$/i.test(addresses[0]!)) return false;
  }
  return !nonJob.test(subject) && (jobSignal.test(subject) || jobSignal.test(body.slice(0, 600)));
}
function jobUrl(text: string): { url: string; externalId: string } | undefined {
  try {
    const url = new URL(entity(text).replace(/[)>.,]+$/, ''));
    if (url.protocol !== 'https:' || !/^(?:[a-z\d-]+\.)*linkedin\.com$/i.test(url.hostname) || url.username || url.password || url.port) return;
    const id = url.pathname.match(/^\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d+)\/?$/)?.[1];
    if (id) return { url: `https://www.linkedin.com/jobs/view/${id}`, externalId: id };
  } catch { /* Not a supported job URL. No redirects or network requests. */ }
}
const action = /^(?:view job|ver (?:empleo|oferta)|solicitar|apply(?: now)?|easy apply|solicitud sencilla|promoted|promocionado|save|guardar|\d+ (?:applicants|solicitantes))\b/i;
const field = (lines: string[], names: string) => lines.map(line => line.match(new RegExp(`^(?:${names})\\s*:\\s*(.+)$`, 'i'))?.[1]).find(Boolean);
function publication(lines: string[]): string | undefined {
  const value = field(lines, 'published(?: at| on)?|posted(?: on)?|publicad[oa](?: el)?|fecha de publicaci[oó]n');
  const iso = value?.match(/^(\d{4}-\d{2}-\d{2})(?:\s|$)/)?.[1];
  const local = value?.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s|$)/);
  const date = iso ?? (local ? `${local[3]}-${local[2]}-${local[1]}` : undefined);
  return date && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date ? date : undefined;
}

/** Bounded, deterministic email parser. No fetch, scraping, clock, or availability inference. */
export function parseLinkedInEmail(raw: string, context: MailContext = {}): ParsedMail {
  if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error('MIME: mensaje demasiado grande');
  const { headers } = splitMail(raw);
  const subject = headers.subject ?? context.subject ?? '';
  const from = headers.from ?? context.from;
  if (nonJob.test(subject)) return empty('ignored', 'non_job_subject');
  const body = mimeText(raw);
  if (!isLinkedInJobAlert(from, subject, body)) return empty('ignored', 'not_linkedin_job_alert');
  const lines = body.split('\n').map(line => line.replace(/[\t \u00a0]+/g, ' ').trim()).filter(Boolean);
  const links: { index: number; url: string; externalId: string }[] = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/https:\/\/[^\s<>"']+/g)) {
      const link = jobUrl(match[0]);
      if (link && !links.some(previous => previous.externalId === link.externalId)) links.push({ index, ...link });
    }
  });
  const alerts: ExternalAlert[] = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    const previous = links[i - 1]?.index ?? -1;
    const before = lines.slice(previous + 1, link.index);
    // Global controls and separators bound plain-text cards; known badges and salary
    // lines are metadata, never positional title/company/location candidates.
    const boundary = before.findLastIndex(line => globalLine.test(line) || /^[-–—_]{3,}$/.test(line));
    const card = before.slice(boundary + 1).filter(line => !action.test(line) && !decoration.test(line) && !salary.test(line));
    const fieldNames = ['title|t[ií]tulo|puesto', 'company|empresa', 'location|ubicaci[oó]n'];
    if (fieldNames.some(names => card.filter(line => new RegExp(`^(?:${names})\\s*:`, 'i').test(line)).length > 1)) continue;
    let title = field(card, 'title|t[ií]tulo|puesto');
    let company = field(card, 'company|empresa');
    let location = field(card, 'location|ubicaci[oó]n');
    if (!title && !company && !location && card.length === 3 && card.every(validField)) {
      [title, company, location] = card;
    }
    if (!title || !company || !validField(title) || !validField(company) || (location !== undefined && !validField(location))) continue;
    const description = field(card, 'description|descripci[oó]n');
    const mode = field(card, 'modalidad|workplace|work mode');
    if (mode) location = location ? `${location} (${mode})` : mode;
    if (location && !validField(location)) continue;
    const remote = location && /\b(remote|remot[oa]|en remoto)\b/i.test(location) && !/\b(hybrid|h[ií]brid[oa])\b/i.test(location) ? true
      : location && /\b(on.site|presencial|hybrid|h[ií]brid[oa])\b/i.test(location) ? false : undefined;
    const publishedAt = publication(card);
    alerts.push({ title, company, ...{ url: link.url, externalId: link.externalId }, source: 'linkedin', kind: 'employment',
      ...(location ? { location } : {}), ...(remote === undefined ? {} : { remote }),
      ...(description ? { description } : {}), ...(publishedAt ? { publishedAt } : {}) });
  }
  if (!alerts.length || alerts.length !== links.length) return empty('unrecognized', 'unsupported_job_card');
  return { status: 'parsed', envelope: { schemaVersion: 1, alerts } };
}
