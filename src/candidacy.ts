import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Opportunity } from './contracts.ts';
import type { evaluate } from './evaluate.ts';

/** Un puesto tal como ocurrió. Los logros son texto LITERAL: nadie los reescribe aguas abajo. */
export interface Experience {
  company: string;
  role: string;
  /** `YYYY-MM`. Un día concreto no aporta nada y obliga a inventarlo. */
  start: string;
  end?: string;
  location?: string;
  achievements: string[];
}
export interface Education {
  institution: string;
  degree: string;
  start: string;
  end?: string;
}
/**
 * Un idioma con su nivel y, si existe, la EVIDENCIA que lo respalda.
 *
 * `evidence` no es decorativo: "inglés C1" sin más es una afirmación, y "IELTS del British Council,
 * válido 07/2025-07/2028" es un hecho comprobable. El mismo criterio que la cita de patrocinio.
 */
export interface Language {
  name: string;
  level: string;
  evidence?: string;
}
/** Una categoría de habilidades del CV, para poder reordenarlas sin tocar el texto. */
export interface SkillGroup {
  name: string;
  skills: string[];
}
export interface CandidateFacts {
  /** `1` es el contrato plano original y RECHAZA los campos nuevos. Solo `2` los admite. */
  schemaVersion: 1 | 2;
  name: string;
  headline?: string;
  location?: string;
  contact?: { email?: string; phone?: string; links?: string[] };
  skills: string[];
  highlights: string[];
  /** Ordenada por `start` DESCENDENTE al parsear: el orden es un hecho, no una preferencia. */
  experience?: Experience[];
  education?: Education[];
  languages?: Language[];
  skillGroups?: SkillGroup[];
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
    /** Halladas en el TEXTO de la oferta con alias, vía `relevance.skillsMatched`. */
    matched: string[];
    /** Habilidades del perfil sin rastro en el texto de la oferta. */
    absent: string[];
    /** Las que la oferta SÍ declaró en un campo estructurado y el candidato no tiene. */
    declaredMissing: string[];
    ratio: number | null;
    /** De dónde salió el cruce. Explícito para que nadie lo confunda con `opportunity.skills`. */
    basis: 'offer_text';
  };
}

const candidateKeys = new Set(['schemaVersion', 'name', 'headline', 'location', 'contact', 'skills', 'highlights']);
/** La v2 añade el CV como datos. La v1 sigue rechazando estas claves, a propósito. */
const candidateKeysV2 = new Set([...candidateKeys, 'experience', 'education', 'languages', 'skillGroups']);
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

/** `YYYY-MM`. Un día concreto no aporta nada a un CV y obliga a inventarlo. */
function month(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(result)) throw new Error(`${name}: se esperaba YYYY-MM`);
  return result;
}
/** Un periodo con su orden comprobado: un `end` anterior al `start` es un dato imposible. */
function period(input: Record<string, unknown>, name: string): { start: string; end?: string } {
  const start = month(input.start, `${name}.start`);
  if (input.end === undefined) return { start };
  const end = month(input.end, `${name}.end`);
  if (end < start) throw new Error(`${name}.end: anterior a start`);
  return { start, end };
}
const experienceKeys = new Set(['company', 'role', 'start', 'end', 'location', 'achievements']);
const educationKeys = new Set(['institution', 'degree', 'start', 'end']);
const languageKeys = new Set(['name', 'level', 'evidence']);
const skillGroupKeys = new Set(['name', 'skills']);
function entries<T>(value: unknown, name: string, parse: (input: Record<string, unknown>, at: string) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${name}: se esperaba una lista`);
  return value.map((item, index) => {
    if (!(index in value)) throw new Error(`${name}[${index}]: hueco en la lista`);
    return parse(object(item, `${name}[${index}]`), `${name}[${index}]`);
  });
}
/**
 * Parse a closed, versioned contract. Unknown fields are rejected, not ignored.
 *
 * `schemaVersion: 1` sigue siendo el contrato plano y **rechaza** los campos nuevos: un archivo
 * escrito antes de la v2 no puede empezar a aceptar experiencia en silencio, porque entonces un
 * typo en `experence` pasaría por un campo desconocido válido en vez de fallar.
 */
export function parseCandidateFacts(value: unknown): CandidateFacts {
  const input = object(value, 'candidate');
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) throw new Error('candidate.schemaVersion: versión no soportada');
  const version = input.schemaVersion;
  exactKeys(input, version === 2 ? candidateKeysV2 : candidateKeys, 'candidate');
  const result: CandidateFacts = {
    schemaVersion: version,
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
  if (input.experience !== undefined) {
    result.experience = entries(input.experience, 'candidate.experience', (item, at) => {
      exactKeys(item, experienceKeys, at);
      return { company: text(item.company, `${at}.company`), role: text(item.role, `${at}.role`), ...period(item, at),
        ...(item.location !== undefined ? { location: text(item.location, `${at}.location`) } : {}),
        // Los logros son texto LITERAL del CV. No se normalizan a minúsculas ni se deduplican:
        // son las frases que la carta va a citar verbatim, y alterarlas aquí es alterar el hecho.
        achievements: textList(item.achievements, `${at}.achievements`) };
      // Se ordena por `start` descendente: un CV va del presente al pasado, y eso es un hecho de la
      // cronología, no una preferencia de presentación que cada renderizador deba recordar.
    }).sort((a, b) => b.start.localeCompare(a.start) || a.company.localeCompare(b.company));
  }
  if (input.education !== undefined) {
    result.education = entries(input.education, 'candidate.education', (item, at) => {
      exactKeys(item, educationKeys, at);
      return { institution: text(item.institution, `${at}.institution`), degree: text(item.degree, `${at}.degree`), ...period(item, at) };
    }).sort((a, b) => b.start.localeCompare(a.start) || a.institution.localeCompare(b.institution));
  }
  if (input.languages !== undefined) {
    result.languages = entries(input.languages, 'candidate.languages', (item, at) => {
      exactKeys(item, languageKeys, at);
      return { name: text(item.name, `${at}.name`), level: text(item.level, `${at}.level`),
        ...(item.evidence !== undefined ? { evidence: text(item.evidence, `${at}.evidence`) } : {}) };
    });
  }
  if (input.skillGroups !== undefined) {
    result.skillGroups = entries(input.skillGroups, 'candidate.skillGroups', (item, at) => {
      exactKeys(item, skillGroupKeys, at);
      return { name: text(item.name, `${at}.name`), skills: textList(item.skills, `${at}.skills`, true) };
    });
  }
  return result;
}

/** Tiers de relevancia que producen material de postulación. Los mismos que llegan al tablero. */
export const CANDIDACY_TIERS: readonly string[] = ['strong', 'possible'];
/**
 * Construye el brief solo para lo que de verdad vale una candidatura.
 *
 * El cruce de habilidades se hace contra el TEXTO de la oferta, reutilizando el
 * `relevance.skillsMatched` que el pipeline ya calculó con alias. Antes se cruzaba por igualdad
 * exacta contra `record.opportunity.skills`, y siete de los diez adaptadores dejan ese campo vacío
 * —incluidos los TRES ATS, que son las fuentes de mayor confianza—, así que para cualquier oferta
 * de un board la proporción salía `null` y la ficha de coincidencia quedaba muerta justo en las
 * mejores ofertas. `evaluate.ts` documentó esta misma lección y la arregló para el score; este
 * módulo nunca recibió el arreglo.
 *
 * El gate añade el tier: sin él, esto genera una carpeta por cada registro verificado del histórico.
 */
export function buildCandidacyBrief(record: CandidacyRecord, candidate: CandidateFacts, options: { tiers?: readonly string[] } = {}): CandidacyBrief | null {
  if (record.evaluation.verification.status !== 'verified'
    || record.evaluation.screening.status === 'discarded'
    || record.evaluation.screening.employment.status === 'ineligible'
    || !(options.tiers ?? CANDIDACY_TIERS).includes(record.evaluation.relevance.tier)) return null;
  const relevance = record.evaluation.relevance;
  const candidateSkills = new Set(candidate.skills);
  // Lo hallado en el texto: núcleo y secundarias juntas, porque para una carta las dos son evidencia.
  const matched = [...new Set([...relevance.skillsMatched, ...relevance.secondaryMatched])].sort(compareText);
  const found = new Set(matched);
  const absent = [...candidateSkills].filter(skill => !found.has(skill)).sort(compareText);
  // Lo que la oferta declaró en un campo estructurado y el candidato no tiene. Casi siempre vacío
  // porque casi ningún adaptador puebla `skills`, y por eso ya no manda en la proporción.
  const declared = [...new Set(record.opportunity.skills)].sort(compareText);
  const declaredMissing = declared.filter(skill => !candidateSkills.has(skill));
  const opportunity = {
    title: record.opportunity.title,
    company: record.opportunity.company,
    skills: declared,
    ...(record.opportunity.url ? { url: record.opportunity.url } : {}),
  };
  return {
    schemaVersion: 1,
    opportunityId: record.id,
    candidate: structuredClone(candidate),
    opportunity,
    // La proporción es sobre las habilidades DEL CANDIDATO: cuánto de lo que sabe pide esta oferta.
    // Sobre las declaradas por la oferta daba `null` en el 70% del pool.
    match: { matched, absent, declaredMissing, basis: 'offer_text',
      ratio: candidateSkills.size ? matched.length / candidateSkills.size : null },
  };
}

const inline = (value: string) => value.replace(/\s+/g, ' ').replace(/([\\`*_{}\[\]<>#+.!|\-])/g, '\\$1');
const list = (values: readonly string[], empty: string) => values.length ? values.map(value => `- ${inline(value)}`).join('\n') : `- [POR COMPLETAR: ${empty}]`;

/** Render a review scaffold; it never composes claims beyond the supplied facts. */
export function renderCandidacyMarkdown(brief: CandidacyBrief): string {
  const { candidate, opportunity, match } = brief;
  // El denominador son las habilidades DEL CANDIDATO, no las que la oferta declare: esas están
  // vacías en el 70% del pool y hacían que la proporción saliera `null` justo en las mejores ofertas.
  const ratio = match.ratio === null ? '[POR REVISAR: no hay habilidades declaradas en tus hechos]'
    : `${match.matched.length}/${match.matched.length + match.absent.length} (${(match.ratio * 100).toFixed(0)}%)`;
  const contact = [candidate.contact?.email, candidate.contact?.phone, ...(candidate.contact?.links ?? [])].filter((value): value is string => !!value);
  return `# Candidatura: ${inline(opportunity.title)} — ${inline(opportunity.company)}

> Borrador interno, revisar antes de enviar

## Referencia de la vacante

- ID: \`${brief.opportunityId}\`
- URL: ${opportunity.url ? inline(opportunity.url) : '[POR COMPLETAR: URL de la vacante]'}

## Coincidencia con el texto de la oferta

- Proporción de tus habilidades que esta oferta pide: ${ratio}
- Halladas en el texto de la oferta:
${list(match.matched, 'ninguna de tus habilidades aparece en el texto')}
- Tuyas sin rastro en esta oferta:
${list(match.absent, 'todas tus habilidades aparecen')}
- Declaradas por la oferta y sin respaldo en tus hechos:
${list(match.declaredMissing, 'la oferta no declara habilidades estructuradas')}

El cruce se hace sobre el texto publicado, con alias, y prueba que el término APARECE; no demuestra dominio ni descarta habilidades equivalentes que la oferta nombre de otra forma.

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
