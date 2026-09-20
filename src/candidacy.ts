import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Opportunity } from './contracts.ts';
import type { evaluate } from './evaluate.ts';

export interface CandidateFacts {
  schemaVersion: 1;
  name: string;
  headline?: string;
  location?: string;
  contact?: { email?: string; phone?: string; links?: string[] };
  skills: string[];
  highlights: string[];
}

export interface CandidacyRecord {
  id: string;
  opportunity: Opportunity;
  evaluation: ReturnType<typeof evaluate>;
}

export interface CandidacyBrief {
  schemaVersion: 1;
  opportunityId: string;
  candidate: CandidateFacts;
  opportunity: {
    title: string;
    company: string;
    skills: string[];
    url?: string;
  };
  match: {
    matched: string[];
    missing: string[];
    ratio: number | null;
  };
}

const candidateKeys = new Set(['schemaVersion', 'name', 'headline', 'location', 'contact', 'skills', 'highlights']);
const contactKeys = new Set(['email', 'phone', 'links']);
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: se esperaba un objeto`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort(compareText);
  if (unknown.length) throw new Error(`${name}: campo desconocido ${unknown[0]}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}: texto no vacío requerido`);
  return value.trim();
}

function textList(value: unknown, name: string, normalize = false): string[] {
  if (!Array.isArray(value)) throw new Error(`${name}: se esperaba una lista`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) throw new Error(`${name}[${index}]: elemento requerido`);
    const item = text(value[index], `${name}[${index}]`);
    const normalized = normalize ? item.toLowerCase() : item;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function httpUrl(value: unknown, name: string): string {
  const result = text(value, name);
  let url: URL;
  try { url = new URL(result); }
  catch { throw new Error(`${name}: URL HTTP/HTTPS requerida`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name}: URL HTTP/HTTPS requerida`);
  return result;
}

/** Parse a closed, versioned contract. Unknown fields are rejected, not ignored. */
export function parseCandidateFacts(value: unknown): CandidateFacts {
  const input = object(value, 'candidate');
  exactKeys(input, candidateKeys, 'candidate');
  if (input.schemaVersion !== 1) throw new Error('candidate.schemaVersion: versión no soportada');
  const result: CandidateFacts = {
    schemaVersion: 1,
    name: text(input.name, 'candidate.name'),
    skills: textList(input.skills, 'candidate.skills', true),
    highlights: textList(input.highlights, 'candidate.highlights'),
  };
  for (const key of ['headline', 'location'] as const) if (input[key] !== undefined) result[key] = text(input[key], `candidate.${key}`);
  if (input.contact !== undefined) {
    const contactInput = object(input.contact, 'candidate.contact');
    exactKeys(contactInput, contactKeys, 'candidate.contact');
    const contact: NonNullable<CandidateFacts['contact']> = {};
    if (contactInput.email !== undefined) {
      contact.email = text(contactInput.email, 'candidate.contact.email');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new Error('candidate.contact.email: email inválido');
    }
    if (contactInput.phone !== undefined) contact.phone = text(contactInput.phone, 'candidate.contact.phone');
    if (contactInput.links !== undefined) contact.links = textList(contactInput.links, 'candidate.contact.links').map((link, index) => httpUrl(link, `candidate.contact.links[${index}]`));
    result.contact = contact;
  }
  return result;
}

/** Build only for verified records that have not been discarded or found ineligible. */
export function buildCandidacyBrief(record: CandidacyRecord, candidate: CandidateFacts): CandidacyBrief | null {
  if (record.evaluation.verification.status !== 'verified'
    || record.evaluation.screening.status === 'discarded'
    || record.evaluation.screening.employment.status === 'ineligible') return null;
  const required = [...new Set(record.opportunity.skills)].sort(compareText);
  const candidateSkills = new Set(candidate.skills);
  const matched = required.filter(skill => candidateSkills.has(skill));
  const missing = required.filter(skill => !candidateSkills.has(skill));
  const opportunity = {
    title: record.opportunity.title,
    company: record.opportunity.company,
    skills: required,
    ...(record.opportunity.url ? { url: record.opportunity.url } : {}),
  };
  return {
    schemaVersion: 1,
    opportunityId: record.id,
    candidate: structuredClone(candidate),
    opportunity,
    match: { matched, missing, ratio: required.length ? matched.length / required.length : null },
  };
}

const inline = (value: string) => value.replace(/\s+/g, ' ').replace(/([\\`*_{}\[\]<>#+.!|\-])/g, '\\$1');
const list = (values: readonly string[], empty: string) => values.length ? values.map(value => `- ${inline(value)}`).join('\n') : `- [POR COMPLETAR: ${empty}]`;

/** Render a review scaffold; it never composes claims beyond the supplied facts. */
export function renderCandidacyMarkdown(brief: CandidacyBrief): string {
  const { candidate, opportunity, match } = brief;
  const ratio = match.ratio === null ? '[POR REVISAR: la vacante no declara habilidades]' : `${match.matched.length}/${opportunity.skills.length} (${(match.ratio * 100).toFixed(0)}%)`;
  const contact = [candidate.contact?.email, candidate.contact?.phone, ...(candidate.contact?.links ?? [])].filter((value): value is string => !!value);
  return `# Candidatura: ${inline(opportunity.title)} — ${inline(opportunity.company)}

> Borrador interno, revisar antes de enviar

## Referencia de la vacante

- ID: \`${brief.opportunityId}\`
- URL: ${opportunity.url ? inline(opportunity.url) : '[POR COMPLETAR: URL de la vacante]'}

## Coincidencia declarada

- Proporción: ${ratio}
- Coincidencias:
${list(match.matched, 'ninguna habilidad declarada coincide')}
- Sin respaldo en CandidateFacts:
${list(match.missing, 'ninguna habilidad declarada pendiente')}

La comparación anterior usa coincidencia exacta entre las habilidades declaradas; no demuestra dominio ni descarta habilidades equivalentes.

## Hechos del candidato

- Nombre: ${inline(candidate.name)}
- Titular: ${candidate.headline ? inline(candidate.headline) : '[POR COMPLETAR: titular profesional]'}
- Ubicación: ${candidate.location ? inline(candidate.location) : '[POR COMPLETAR: ubicación]'}
- Contacto:
${list(contact, 'datos de contacto')}
- Habilidades declaradas:
${list(candidate.skills, 'habilidades')}

## Evidencia reutilizable

${list(candidate.highlights, 'hechos o logros verificables')}

## Resumen adaptado

[POR COMPLETAR: redactar usando únicamente los hechos anteriores y la descripción verificada de la vacante]

## Carta de presentación

[POR COMPLETAR: redactar, comprobar requisitos y personalizar el destinatario sin añadir afirmaciones no verificadas]

## Revisión manual

- [ ] Confirmar que la vacante sigue abierta.
- [ ] Confirmar requisitos, modalidad, ubicación y compensación.
- [ ] Verificar cada afirmación y cifra contra su fuente.
- [ ] Aprobar el texto final antes de enviarlo.
`;
}

export interface WrittenCandidacy { opportunityId: string; path: string; changed: boolean }

/** Atomically write changed files only. Existing unrelated files are left untouched. */
export async function writeCandidacyBriefs(directory: string, briefs: readonly CandidacyBrief[]): Promise<WrittenCandidacy[]> {
  if (!briefs.length) return [];
  await mkdir(directory, { recursive: true });
  const results: WrittenCandidacy[] = [];
  for (const brief of [...briefs].sort((a, b) => compareText(a.opportunityId, b.opportunityId))) {
    if (!/^[a-f0-9]{64}$/.test(brief.opportunityId)) throw new Error('candidacy.opportunityId: SHA-256 inválido');
    const path = join(directory, `${brief.opportunityId}.md`);
    const contents = renderCandidacyMarkdown(brief);
    let previous: string | undefined;
    try { previous = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous === contents) {
      results.push({ opportunityId: brief.opportunityId, path, changed: false });
      continue;
    }
    const temporary = join(directory, `.${brief.opportunityId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, contents, { flag: 'wx' });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    results.push({ opportunityId: brief.opportunityId, path, changed: true });
  }
  return results;
}
