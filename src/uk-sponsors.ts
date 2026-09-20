import { safeRead, type SafeReadOptions } from './safe-http.ts';
import { canonical } from './text.ts';

/**
 * Registro oficial de patrocinadores con licencia del Reino Unido.
 *
 * Es la única fuente VERIFICABLE de patrocinio que encontramos: 143.169 filas publicadas por
 * gov.uk, de las cuales ~123.000 con ruta "Skilled Worker". Se cruza por nombre de empresa.
 *
 * ⚠️ Semántica honesta: un match significa "este empleador figura en el registro", NO "este
 * puesto patrocina". Vale bastante menos que una oferta que lo declara por escrito, y el modelo
 * los mantiene separados (`employer_registered` frente a `stated`).
 */
export const UK_REGISTER_PAGE = 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers';
/** El CSV ronda 11 MB y tarda más que un listado normal; los límites globales existen para feeds. */
const CSV_LIMITS = { maxBytes: 32_000_000, timeoutMs: 60_000, contentTypes: ['text/csv', 'application/csv', 'text/plain', 'application/octet-stream'] };
const ROUTE = 'skilled worker';
/** Sufijos societarios que no distinguen a una empresa de otra. */
const LEGAL_SUFFIXES = /\b(ltd|limited|llp|lp|plc|inc|incorporated|corp|corporation|co|company|group|holdings|uk|gmbh|bv|sa|sl|srl|ag|as|ab|oy|pte)\b/g;
/**
 * Nombres tan genéricos que un match diría más del diccionario que del empleador. Con 143.000
 * filas, "Apple" o "Global" aparecen por razones que nada tienen que ver con la oferta.
 */
const AMBIGUOUS = new Set(['global', 'international', 'technology', 'technologies', 'solutions', 'systems', 'services', 'consulting', 'digital', 'data', 'software', 'partners', 'ventures', 'labs', 'studio', 'agency']);
/** Un nombre más corto que esto produce coincidencias por azar. */
const MIN_NAME_LENGTH = 4;
/** Señales de que la vacante está en el Reino Unido; sin esto el registro no aplica. */
const UK_LOCATION = /\b(united kingdom|uk|england|scotland|wales|northern ireland|london|manchester|birmingham|edinburgh|glasgow|bristol|leeds|cambridge|oxford|belfast|cardiff)\b/i;

export interface SponsorRegister {
  version: 1;
  fetchedAt: string;
  sourceUrl: string;
  /** Solo nombres normalizados: las cinco columnas del CSV no aportan nada al cruce. */
  organisations: string[];
}

/** Divide una línea CSV respetando comillas dobles y sus escapes. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { fields.push(current); current = ''; }
    else current += char;
  }
  fields.push(current);
  return fields;
}

/** Normaliza para el cruce: sin diacríticos, sin puntuación, sin sufijos societarios. */
export function normalizeCompany(name: string): string {
  return canonical(name).replace(LEGAL_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
}

export function parseRegisterCsv(csv: string, fetchedAt: string, sourceUrl: string): SponsorRegister {
  const lines = csv.split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? '').map(h => h.trim().toLowerCase());
  const nameIndex = header.findIndex(h => h.includes('organisation') || h.includes('organization'));
  const routeIndex = header.findIndex(h => h.includes('route'));
  if (nameIndex < 0 || routeIndex < 0) throw new Error('register_header_unexpected');
  const organisations = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const fields = splitCsvLine(line);
    if (!fields[routeIndex]?.toLowerCase().includes(ROUTE)) continue;
    const normalized = normalizeCompany(fields[nameIndex] ?? '');
    if (normalized.length >= MIN_NAME_LENGTH && !AMBIGUOUS.has(normalized)) organisations.add(normalized);
  }
  if (!organisations.size) throw new Error('register_empty');
  return { version: 1, fetchedAt, sourceUrl, organisations: [...organisations].sort() };
}

/**
 * Descarga el registro en dos pasos: el enlace del CSV lleva un hash que cambia en cada edición,
 * así que se raspa de la página en vez de fijarlo en el código y descubrir el 404 semanas después.
 */
export async function fetchRegister(now: Date, options: SafeReadOptions = {}): Promise<SponsorRegister> {
  const page = await safeRead(UK_REGISTER_PAGE, { ...options, contentTypes: ['text/html'] });
  if (page.status !== 200) throw new Error('register_page_unavailable');
  const link = /href="(https:\/\/assets\.publishing\.service\.gov\.uk\/[^"]+\.csv)"/i.exec(page.body)?.[1];
  if (!link) throw new Error('register_link_not_found');
  const csv = await safeRead(link, { ...options, ...CSV_LIMITS });
  if (csv.status !== 200) throw new Error('register_download_failed');
  return parseRegisterCsv(csv.body, now.toISOString(), link);
}

/**
 * Cruce CONSERVADOR: coincidencia exacta del nombre normalizado y ubicación británica obligatoria.
 * Nunca difuso. Un falso positivo aquí no es un dato de más: es afirmarle a alguien que una
 * empresa puede patrocinarlo cuando no.
 */
export function matchesRegister(company: string, location: string | undefined, index: ReadonlySet<string>): boolean {
  if (!location || !UK_LOCATION.test(location)) return false;
  const normalized = normalizeCompany(company);
  if (normalized.length < MIN_NAME_LENGTH || AMBIGUOUS.has(normalized)) return false;
  return index.has(normalized);
}
/** El registro se persiste como lista ordenada, pero se cruza como conjunto: son ~100.000 nombres
 *  contra miles de ofertas por ciclo, y una búsqueda lineal por oferta no es una opción. */
export const registerIndex = (register: Pick<SponsorRegister, 'organisations'>): ReadonlySet<string> => new Set(register.organisations);
