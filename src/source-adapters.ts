import { createHash } from 'node:crypto';
import { parseOpportunity, type Opportunity } from './contracts.ts';
import { ATS_ADAPTERS, type Adapter, type Source } from './source-registry.ts';
import { validatePublicUrl } from './safe-http.ts';
import { parseRss } from './rss.ts';
import { sponsorshipFromDescription } from './sponsorship.ts';

export interface Provenance { sourceId: string; adapter: Source['adapter']; externalId: string; endpoint: string; originalUrl: string; observedAt: string; payloadHash: string; publicationField?: string }
export interface CapturedJob { opportunity: Opportunity; provenance: Provenance[]; warnings: string[] }
export const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('malformed_record');
  return v as Record<string, unknown>;
};
function text(v: unknown, max = 100_000): string { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('malformed_text'); return v.trim(); }
const optional = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim().slice(0, 100_000) : undefined;
export function canonicalUrl(raw: string): string {
  const url = validatePublicUrl(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort(); url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}
/**
 * Epoch en segundos o milisegundos. Solo se acepta dentro de un rango de calendario razonable
 * para no confundir un identificador numérico con una fecha: un `id` de siete cifras sería un
 * epoch en segundos perfectamente válido de 1970.
 */
const EPOCH_FLOOR_MS = Date.parse('2000-01-01T00:00:00Z');
function epochDate(raw: unknown, now: Date): string | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  const ms = raw < 1e11 ? raw * 1000 : raw;
  if (!Number.isSafeInteger(Math.round(ms)) || ms < EPOCH_FLOOR_MS || ms > now.getTime()) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}
function publication(raw: unknown, now: Date, rss = false): string | undefined {
  if (typeof raw === 'number') return epochDate(raw, now);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  if (!rss && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(raw)) return undefined;
  if (rss) {
    const parts = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+\d{2}:\d{2}(?::\d{2})?\s+(?:GMT|UT|[+-]\d{4})$/i.exec(raw);
    if (!parts) return undefined;
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(parts[2]!.toLowerCase()) + 1;
    const day = `${parts[3]}-${String(month).padStart(2, '0')}-${parts[1]!.padStart(2, '0')}`;
    if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) return undefined;
  }
  const parsed = Date.parse(!rss && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw}Z` : raw);
  if (!Number.isFinite(parsed) || parsed > now.getTime()) return undefined;
  if (!rss) {
    const date = raw.slice(0, 10);
    if (new Date(Date.parse(date)).toISOString().slice(0, 10) !== date) return undefined;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}
/**
 * Cotas de credibilidad por periodo. Un proveedor puede publicar una cifra sin sentido y hay que
 * distinguirla de un dato real: medido el 2026-09-20, el board Ashby de Vanta declaraba
 * `{"interval":"1 YEAR","minValue":90,"maxValue":90}` — noventa dólares AL AÑO. Fuera de estas
 * cotas la oferta queda `unparsed`, que significa "la fuente publicó pago y no lo entendimos",
 * nunca se inventa ni se descarta la oferta.
 */
const PLAUSIBLE_PAY: Record<string, { min: number; max: number }> = {
  hour: { min: 3, max: 2_000 }, day: { min: 20, max: 10_000 }, week: { min: 100, max: 50_000 },
  month: { min: 400, max: 200_000 }, year: { min: 5_000, max: 2_000_000 },
};
const ASHBY_INTERVALS: Record<string, string> = { '1 HOUR': 'hour', '1 DAY': 'day', '1 WEEK': 'week', '1 MONTH': 'month', '1 YEAR': 'year' };
interface PayReading { compensation?: Opportunity['compensation']; disclosure: 'published' | 'not_published' | 'unparsed'; evidence?: Opportunity['payEvidence'] }
/** Lee el componente estructurado de salario de Ashby; ignora equity, bonos y comisiones. */
function ashbyPay(raw: Record<string, unknown>): PayReading {
  const compensation = raw.compensation && typeof raw.compensation === 'object' ? object(raw.compensation) : undefined;
  const summary = typeof compensation?.scrapeableCompensationSalarySummary === 'string' ? compensation.scrapeableCompensationSalarySummary : undefined;
  const components = Array.isArray(compensation?.summaryComponents) ? compensation.summaryComponents : [];
  const salary = components.map(object).find(c => c.compensationType === 'Salary' && typeof c.minValue === 'number');
  if (!salary) return { disclosure: summary ? 'unparsed' : 'not_published', ...(summary ? { evidence: { field: 'compensation.scrapeableCompensationSalarySummary', raw: summary.slice(0, 500) } } : {}) };
  const period = ASHBY_INTERVALS[String(salary.interval)];
  const currency = typeof salary.currencyCode === 'string' ? salary.currencyCode : undefined;
  const min = salary.minValue as number, max = typeof salary.maxValue === 'number' ? salary.maxValue : min;
  const bounds = period ? PLAUSIBLE_PAY[period] : undefined;
  const evidence = { field: 'compensation.summaryComponents[Salary]', raw: (summary ?? `${min}-${max} ${currency ?? '?'} ${salary.interval}`).slice(0, 500) };
  if (!period || !currency || !bounds || min < bounds.min || max > bounds.max || max < min) return { disclosure: 'unparsed', evidence };
  return { compensation: { currency, period: period as NonNullable<Opportunity['compensation']>['period'], min, ...(max > min ? { max } : {}) }, disclosure: 'published', evidence };
}
/** Normaliza el vocabulario de tipo de contrato de varios proveedores a un solo enum. */
const EMPLOYMENT_TYPES: Record<string, Opportunity['employmentType']> = {
  fulltime: 'full_time', 'full-time': 'full_time', full_time: 'full_time', 'tiempo completo': 'full_time',
  parttime: 'part_time', 'part-time': 'part_time', part_time: 'part_time', 'medio tiempo': 'part_time',
  contract: 'contract', contractor: 'contract', freelance: 'contract', temporary: 'temporary', temp: 'temporary',
  intern: 'internship', internship: 'internship', 'internship/co-op': 'internship',
};
/** Se normaliza quitando separadores: "Full Time", "full-time" y "FullTime" son lo mismo. */
const employmentType = (raw: unknown): Opportunity['employmentType'] => typeof raw === 'string'
  ? EMPLOYMENT_TYPES[raw.trim().toLowerCase()] ?? EMPLOYMENT_TYPES[raw.trim().toLowerCase().replace(/[\s_-]+/g, '')]
  : undefined;
/** Vocabulario de seniority de los proveedores → enum interno. */
const SENIORITY: Record<string, NonNullable<Opportunity['seniority']>[number]> = {
  internship: 'intern', intern: 'intern', entrylevel: 'junior', junior: 'junior', jr: 'junior',
  midlevel: 'mid', mid: 'mid', intermediate: 'mid', associate: 'mid',
  senior: 'senior', sr: 'senior', staff: 'staff', principal: 'principal', lead: 'lead',
  manager: 'lead', director: 'director', executive: 'executive', vp: 'executive', clevel: 'executive',
};
const seniorityList = (raw: unknown): Opportunity['seniority'] => {
  if (!Array.isArray(raw)) return undefined;
  const levels = [...new Set(raw.flatMap(v => typeof v === 'string' ? [SENIORITY[v.trim().toLowerCase().replace(/[\s_-]+/g, '')]] : []).filter(Boolean))];
  return levels.length ? levels as Opportunity['seniority'] : undefined;
};
/** Periodos de salario tal como los nombran los agregadores. */
const SALARY_PERIODS: Record<string, NonNullable<Opportunity['compensation']>['period']> = {
  annual: 'year', annually: 'year', yearly: 'year', year: 'year',
  monthly: 'month', month: 'month', weekly: 'week', week: 'week',
  daily: 'day', day: 'day', hourly: 'hour', hour: 'hour',
};
/**
 * Salario declarado por un agregador. Aplica las mismas cotas de credibilidad que Ashby y trata
 * el cero como ausencia: RemoteOK devuelve `salary_min: 0, salary_max: 0` cuando no hay dato,
 * y creerle significaría rankear una vacante como si pagara nada.
 */
function aggregatorPay(min: unknown, max: unknown, currency: unknown, period: unknown, field: string): PayReading {
  const low = typeof min === 'number' && Number.isFinite(min) && min > 0 ? min : undefined;
  if (low === undefined) return { disclosure: 'not_published' };
  const high = typeof max === 'number' && Number.isFinite(max) && max >= low ? max : low;
  const resolved = typeof period === 'string' ? SALARY_PERIODS[period.trim().toLowerCase()] : undefined;
  const code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency.trim()) ? currency.trim().toUpperCase() : undefined;
  const evidence = { field, raw: `${low}-${high} ${code ?? '?'} ${String(period ?? '?')}`.slice(0, 500) };
  const bounds = resolved ? PLAUSIBLE_PAY[resolved] : undefined;
  if (!resolved || !code || !bounds || low < bounds.min || high > bounds.max) return { disclosure: 'unparsed', evidence };
  return { compensation: { currency: code, period: resolved, min: low, ...(high > low ? { max: high } : {}) }, disclosure: 'published', evidence };
}
/** `remoteness` de seis niveles; `remote` booleano se deriva después en `parseOpportunity`. */
const REMOTENESS: Record<string, Opportunity['remoteness']> = {
  remote: 'fully_remote', 'fully remote': 'fully_remote', hybrid: 'hybrid', onsite: 'in_person',
  'on-site': 'in_person', 'in office': 'in_person', 'in-office': 'in_person',
};
const remoteness = (raw: unknown): Opportunity['remoteness'] => typeof raw === 'string' ? REMOTENESS[raw.trim().toLowerCase()] : undefined;
/** Descripción almacenada por oferta. Acota el store sin recortar una descripción real: medido
 *  el 2026-09-20, el `content` de Greenhouse ronda 5.600 caracteres. */
const DESCRIPTION_LIMIT = 20_000;
/**
 * Greenhouse entrega `content` como HTML escapado (`&lt;p&gt;…`). Se reduce a texto plano para
 * que el matcher no compita con etiquetas y para no guardar markup en el store. `&amp;` se
 * decodifica al final: hacerlo antes reintroduciría etiquetas desde `&amp;lt;`.
 */
const decodeEntities = (value: string) => value
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&#0?39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
/**
 * Etiquetas de bloque que separan ideas. Colapsarlas a un espacio convierte una lista con
 * viñetas en una sola oración de miles de caracteres, y cualquier análisis por oración —el de
 * patrocinio, por ejemplo— pasa a decidir sobre un texto donde "no patrocinamos" y "metas de
 * ventas" viven en la misma frase. Se traducen a salto de línea.
 */
const BLOCK_BOUNDARY = /<\/?(p|br|li|ul|ol|div|h[1-6]|tr|td|table|section|article|header|footer|blockquote|dd|dt)\b[^>]*>/gi;
const stripTags = (value: string) => value
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(BLOCK_BOUNDARY, '\n')
  .replace(/<[^>]*>/g, ' ');
function htmlToText(raw: string): string {
  // Dos pasadas, quitando etiquetas entre ambas: el contenido llega DOBLEMENTE escapado y una
  // sola pasada deja residuos (medido en boards/vercel: 480 `&nbsp;` y 48 `&amp;` supervivientes
  // provenientes de `&amp;nbsp;`). Quitar etiquetas entre pasadas evita que la segunda
  // decodificación reconstruya markup que ya nadie iba a revisar.
  return stripTags(decodeEntities(stripTags(decodeEntities(raw))))
    // Se colapsa el espacio horizontal pero se conservan los saltos: son el límite de oración.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, DESCRIPTION_LIMIT);
}

/**
 * Dónde vive el array de ofertas en la respuesta de cada proveedor. `null` = la raíz es el array.
 * Un descriptor explícito evita la lista de excepciones que crecía en cada adaptador nuevo.
 */
const ROWS_PATH: Record<Adapter, string | null> = {
  greenhouse: 'jobs', lever: null, ashby: 'jobs', rss: null,
  remotive: 'jobs', himalayas: 'jobs', jobicy: 'jobs', remoteok: null, arbeitnow: 'data', landingjobs: null,
};
export function adaptSource(source: Source, body: string, now: Date, endpoint = source.endpoint): { jobs: CapturedJob[]; rejected: number; nextCursor?: string } {
  const payload: unknown = source.adapter === 'rss' ? parseRss(body) : JSON.parse(body);
  const path = ROWS_PATH[source.adapter];
  const rows = path === null ? payload : (object(payload) as Record<string, unknown>)[path];
  if (!Array.isArray(rows) || rows.length > 10_000) throw new Error('malformed_feed');
  let rejected = 0; const jobs: CapturedJob[] = [];
  for (const raw of rows) {
    try {
      const r = object(raw);
      if (source.adapter === 'ashby' && r.isListed !== true) { rejected++; continue; }
      if (source.adapter === 'greenhouse' && r.internal_job_id === null) { rejected++; continue; }
      let title: unknown = r.title, company: unknown = source.company, url: unknown, id: unknown = r.id;
      let date: unknown, dateField: string | undefined, description: unknown, location: unknown, remote: boolean | undefined;
      let mode: Opportunity['remoteness'], contract: Opportunity['employmentType'], restrictions: string[] | undefined;
      let levels: Opportunity['seniority'], skills: string[] | undefined, expires: string | undefined;
      let pay: PayReading = { disclosure: 'not_published' };
      switch (source.adapter) {
        case 'remotive':
          company = r.company_name; url = r.url; date = r.publication_date; dateField = 'publication_date'; description = r.description; location = r.candidate_required_location; mode = 'fully_remote';
          contract = employmentType(r.job_type);
          if (typeof r.candidate_required_location === 'string' && r.candidate_required_location.trim()) restrictions = [r.candidate_required_location.trim()];
          // `salary` es texto libre sin estructura ("$50k - $80k", "competitive", ""): se marca
          // que la fuente publicó algo y no se interpreta, en vez de arriesgar una cifra inventada.
          if (typeof r.salary === 'string' && r.salary.trim()) pay = { disclosure: 'unparsed', evidence: { field: 'salary', raw: r.salary.trim().slice(0, 500) } };
          break;
        case 'greenhouse':
          // first_published, NOT updated_at: the board rewrites updated_at continuously, so it
          // reports every posting as fresh. Measured 2026-09-19 on boards/vercel/jobs (84 jobs):
          // updated_at <=3d for 84/84 (median 2d) while first_published <=3d for 4/84 (median 71d).
          // Using updated_at would let a 71-day-old posting clear the three-day freshness gate.
          url = r.absolute_url; date = r.first_published; dateField = 'first_published';
          // El board API de Greenhouse no expone tipo de contrato ni compensación estructurada.
          description = typeof r.content === 'string' ? htmlToText(r.content) : undefined;
          location = r.location && object(r.location).name;
          break;
        case 'lever': {
          // createdAt es epoch en milisegundos. Medido el 2026-09-20 en api.lever.co/v0/postings/
          // leverdemo: devuelve 1565990241800 (agosto 2019), es decir NO se reescribe como el
          // updated_at de Greenhouse. Por eso sí sirve como fecha de publicación.
          title = r.text; url = r.hostedUrl; description = r.descriptionPlain; date = r.createdAt; dateField = 'createdAt';
          const categories = r.categories && typeof r.categories === 'object' ? object(r.categories) : {};
          location = categories.location; contract = employmentType(categories.commitment);
          if (Array.isArray(categories.allLocations)) restrictions = categories.allLocations.filter((l): l is string => typeof l === 'string' && !!l.trim());
          mode = remoteness(r.workplaceType);
          break;
        }
        case 'ashby':
          url = r.jobUrl; id = r.id ?? r.jobUrl; date = r.publishedAt; dateField = 'publishedAt'; description = r.descriptionPlain; location = r.location;
          mode = remoteness(r.workplaceType) ?? (r.isRemote === true ? 'fully_remote' : r.isRemote === false ? 'in_person' : undefined);
          contract = employmentType(r.employmentType);
          if (Array.isArray(r.secondaryLocations)) restrictions = r.secondaryLocations.map(l => typeof l === 'string' ? l : typeof l === 'object' && l ? String(object(l).location ?? '') : '').filter(Boolean);
          pay = ashbyPay(r);
          break;
        case 'himalayas':
          // pubDate y expiryDate son epoch en SEGUNDOS, no ISO. Trae la señal más rica de todas
          // las fuentes: seniority, salario estructurado y restricciones de ubicación.
          company = r.companyName; url = r.applicationLink; id = r.guid ?? r.applicationLink;
          date = r.pubDate; dateField = 'pubDate'; description = r.description ?? r.excerpt;
          contract = employmentType(r.employmentType);
          levels = seniorityList(r.seniority);
          expires = epochDate(r.expiryDate, new Date(8.64e15)) ?? undefined;
          if (Array.isArray(r.locationRestrictions)) restrictions = r.locationRestrictions.filter((l): l is string => typeof l === 'string' && !!l.trim());
          location = restrictions?.length ? restrictions.join('; ') : 'Remote';
          mode = 'fully_remote';
          pay = aggregatorPay(r.minSalary, r.maxSalary, r.currency, r.salaryPeriod, 'minSalary/maxSalary');
          break;
        case 'jobicy':
          company = r.companyName; title = r.jobTitle; url = r.url; date = r.pubDate; dateField = 'pubDate';
          description = r.jobDescription ?? r.jobExcerpt;
          contract = employmentType(Array.isArray(r.jobType) ? r.jobType[0] : r.jobType);
          levels = seniorityList(Array.isArray(r.jobLevel) ? r.jobLevel : [r.jobLevel]);
          if (Array.isArray(r.jobGeo) || typeof r.jobGeo === 'string') restrictions = (Array.isArray(r.jobGeo) ? r.jobGeo : [r.jobGeo]).filter((l): l is string => typeof l === 'string' && !!l.trim());
          location = restrictions?.length ? restrictions.join('; ') : 'Remote';
          mode = 'fully_remote';
          pay = aggregatorPay(r.annualSalaryMin, r.annualSalaryMax, r.salaryCurrency, 'annual', 'annualSalaryMin/Max');
          break;
        case 'remoteok':
          // La primera fila del feed es un aviso legal documentado, no una vacante malformada:
          // se salta sin contarla como rechazo, que marcaría la fuente como `partial` cada ciclo.
          if (r.legal !== undefined || r.position === undefined) continue;
          company = r.company; title = r.position; url = r.url ?? r.apply_url; date = r.epoch; dateField = 'epoch';
          description = r.description; location = optional(r.location) ?? 'Remote'; mode = 'fully_remote';
          if (Array.isArray(r.tags)) skills = r.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 30);
          pay = aggregatorPay(r.salary_min, r.salary_max, 'USD', 'annual', 'salary_min/salary_max');
          break;
        case 'arbeitnow':
          // ⚠️ `visa_sponsorship` NO se lee: medido el 2026-09-20, el filtro devuelve 146 ofertas
          // que aparecen simultáneamente en ?visa_sponsorship=true y =false, y el objeto de cada
          // oferta no trae campo alguno de visado. Es una señal rota.
          company = r.company_name; url = r.url; id = r.slug ?? r.url; date = r.created_at; dateField = 'created_at';
          description = r.description; location = optional(r.location);
          contract = employmentType(Array.isArray(r.job_types) ? r.job_types[0] : r.job_types);
          if (r.remote === true) mode = 'fully_remote';
          if (Array.isArray(r.tags)) skills = r.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 30);
          break;
        case 'landingjobs':
          // `relocation_paid` es un campo de primera clase: la señal de reubicación más limpia
          // que publica cualquiera de las fuentes.
          url = r.url; date = r.published_at; dateField = 'published_at';
          description = r.role_description ?? r.main_requirements;
          // Landing.jobs NO publica campo de empresa: el slug va en la ruta de la URL, con forma
          // fija `/at/{empresa}/{puesto}`. Se deriva de ahí porque es determinista y verificable,
          // no se inventa: si la ruta no tiene esa forma, la fila se rechaza.
          company = optional(r.company_name) ?? (typeof r.company === 'object' && r.company ? optional(object(r.company).name) : undefined)
            ?? (typeof r.url === 'string' ? /\/at\/([^/]+)\//.exec(r.url)?.[1]?.replace(/[-_]+/g, ' ').trim() : undefined) ?? source.company;
          contract = employmentType(r.type);
          if (Array.isArray(r.locations)) restrictions = r.locations.filter((l): l is string => typeof l === 'string' && !!l.trim());
          location = r.remote === true ? (restrictions?.length ? `Remote; ${restrictions.join('; ')}` : 'Remote') : restrictions?.join('; ');
          if (r.remote === true) mode = 'fully_remote';
          if (Array.isArray(r.tags)) skills = r.tags.flatMap(t => typeof t === 'string' ? [t] : typeof t === 'object' && t ? [String(object(t).name ?? '')] : []).filter(Boolean).slice(0, 30);
          if (typeof r.expires_at === 'string') expires = r.expires_at.slice(0, 10);
          pay = aggregatorPay(r.gross_salary_low, r.gross_salary_high, r.currency_code, 'annual', 'gross_salary_low/high');
          break;
        case 'rss': {
          url = r.link; id = r.guid ?? r.link; date = r.pubDate; dateField = 'pubDate'; description = r.description;
          company = r.company ?? source.company;
          if (!company && typeof title === 'string') {
            const hostname = new URL(source.endpoint).hostname;
            // WWR's public RSS titles explicitly encode "Company: Role". Other feeds require company.
            if (hostname === 'weworkremotely.com') {
              const delimiter = title.indexOf(': ');
              if (delimiter > 0) { company = title.slice(0, delimiter); title = title.slice(delimiter + 2); }
            } else if (hostname === 'jobscollider.com' || hostname === 'remotefirstjobs.com') {
              const match = / at (.+)$/.exec(title);
              if (match) { company = match[1]; title = title.slice(0, match.index); }
            }
          }
          break;
        }
      }
      const originalUrl = text(url, 2000), normalizedUrl = canonicalUrl(originalUrl);
      const externalId = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? String(id) : text(id, 1024);
      const observedAt = now.toISOString();
      const publishedAt = publication(date, now, source.adapter === 'rss');
      // Lo decide el registro, no una lista incrustada aquí: un agregador nuevo nace `ambiguous`
      // por defecto y tiene que declararse autoritativo a propósito.
      const trustedAvailability = source.availabilityTrust === 'listing';
      /**
       * Qué hace que la presencia en el feed valga como evidencia de disponibilidad.
       *
       * Para un board ATS, el listado ES el tablero de la empresa. Para un agregador NO basta, y
       * comprobarlo por HTML tampoco funciona: medido el 2026-09-20, las 40 capturas de páginas
       * de agregadores dieron 33 `no_structured_job_posting_found` y 0 verificadas, porque esas
       * páginas no publican JSON-LD ligado a su propia URL.
       *
       * Lo que sí existe es una afirmación explícita del proveedor: Himalayas y Landing.jobs
       * publican fecha de expiración por oferta. Registrarla no es inferir — es citar lo que el
       * proveedor declara, y la evidencia lo dice con todas sus letras. Un agregador sin fecha de
       * expiración se queda `ambiguous`: no hay nada que citar.
       */
      const listingEvidence = !trustedAvailability ? undefined
        : ATS_ADAPTERS.includes(source.adapter as typeof ATS_ADAPTERS[number]) ? `public_ats_listing:${endpoint}#${externalId}`
        : expires && Date.parse(expires) > now.getTime() ? `provider_expiry_assertion:${endpoint}#${externalId}@${expires}`
        : undefined;
      /**
       * La descripción se acota UNA VEZ y esa única variable se reutiliza.
       *
       * `DESCRIPTION_LIMIT` solo se aplicaba dentro de `htmlToText`, que es el camino de Greenhouse;
       * los otros nueve adaptadores guardaban hasta 100.000 caracteres, cinco veces el tope.
       *
       * Y acotarla en dos sitios sería un error esperando ocurrir: el mismo texto alimenta al
       * detector de patrocinio y al campo almacenado, y `parseOpportunity` exige que la cita
       * aparezca LITERALMENTE en la descripción guardada. Si el detector viera más texto que el
       * campo, una cita del tramo cortado haría fallar el contrato. Calcularla una vez lo vuelve
       * estructuralmente imposible.
       */
      const descriptionText = optional(description)?.slice(0, DESCRIPTION_LIMIT);
      // Se lee en la captura, cuando la descripción ya está en memoria y no cuesta una petición.
      const sponsorship = sponsorshipFromDescription(descriptionText, observedAt);
      const opportunity = parseOpportunity({ title: text(title, 500), company: text(company, 200), url: normalizedUrl, source: source.id, skills: skills ?? [],
        ...(levels?.length ? { seniority: levels } : {}),
        ...(expires ? { expiresAt: expires } : {}),
        ...(descriptionText ? { description: descriptionText } : {}), ...(optional(location) ? { location: optional(location) } : {}),
        ...(mode !== undefined ? { remoteness: mode } : remote !== undefined ? { remote } : {}),
        ...(contract !== undefined ? { employmentType: contract } : {}),
        ...(restrictions?.length ? { locationRestrictions: restrictions } : {}),
        ...(pay.compensation ? { compensation: pay.compensation } : {}),
        payDisclosure: pay.disclosure,
        ...(pay.evidence ? { payEvidence: pay.evidence } : {}),
        ...(sponsorship ? { sponsorship } : {}),
        ...(publishedAt ? { publishedAt, publicationEvidence: { url: normalizedUrl, observedAt, excerpt: JSON.stringify({ endpoint, field: dateField, value: date }).slice(0, 1000) } } : {}),
        availability: { url: normalizedUrl, checkedAt: observedAt, outcome: listingEvidence ? 'open' : 'ambiguous', httpStatus: 200,
          evidence: listingEvidence ?? 'feed_presence_does_not_confirm_availability' },
      });
      jobs.push({ opportunity, provenance: [{ sourceId: source.id, adapter: source.adapter, externalId, endpoint, originalUrl, observedAt,
        payloadHash: createHash('sha256').update(JSON.stringify(raw)).digest('hex'), ...(publishedAt ? { publicationField: dateField } : {}) }],
        warnings: [...(!publishedAt ? ['publication_missing_or_invalid'] : []), ...(!trustedAvailability ? ['availability_requires_capture'] : [])] });
    } catch { rejected++; }
  }
  // Himalayas documenta el cursor como forma preferida de paginar y garantiza no repetir filas.
  const cursor = path !== null && typeof (payload as Record<string, unknown>).nextCursor === 'string' ? (payload as Record<string, string>).nextCursor : undefined;
  return { jobs, rejected, ...(cursor ? { nextCursor: cursor } : {}) };
}
