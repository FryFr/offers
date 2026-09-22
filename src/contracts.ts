export type Kind = 'employment' | 'freelance' | 'unknown';
export type VerificationStatus = 'verified' | 'stale' | 'unavailable' | 'unknown';
export interface PublicationEvidence { url: string; excerpt: string; observedAt: string }
export interface AvailabilityEvidence {
  url: string;
  checkedAt: string;
  outcome: 'open' | 'closed' | 'missing' | 'ambiguous' | 'timeout' | 'error';
  httpStatus?: number;
  evidence?: string;
}
/** Intervalos que declaran los proveedores. Sin `year` y `week`, una banda anual no entra. */
export const COMPENSATION_PERIODS = ['hour', 'day', 'week', 'month', 'year', 'project'] as const;
export type CompensationPeriod = typeof COMPENSATION_PERIODS[number];
export interface Compensation {
  currency: string;
  period: CompensationPeriod;
  min: number;
  max?: number;
  hoursPerMonth?: number;
  estimatedHours?: number;
}
/**
 * Seis niveles, no un booleano. Un booleano colapsa híbrido en "no remoto" o "remoto" y las dos
 * lecturas son falsas: híbrido exige vivir en la ciudad, igual que presencial.
 */
export const REMOTENESS_LEVELS = ['unknown', 'in_person', 'hybrid', 'partially_remote', 'fully_remote'] as const;
export type Remoteness = typeof REMOTENESS_LEVELS[number];
export const SENIORITY_LEVELS = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'director', 'executive'] as const;
export type Seniority = typeof SENIORITY_LEVELS[number];
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship', 'temporary', 'other'] as const;
export type EmploymentType = typeof EMPLOYMENT_TYPES[number];
/**
 * Distingue tres cosas que antes se confundían en "sin compensación": el proveedor no publica
 * salario, lo publica y no supimos leerlo, o lo publica y lo leímos. Lo fija el adaptador con
 * lo que vio; nunca se infiere aguas abajo.
 */
export const PAY_DISCLOSURES = ['published', 'not_published', 'unparsed'] as const;
export type PayDisclosure = typeof PAY_DISCLOSURES[number];
export interface PayEvidence { field: string; raw: string; converted?: boolean }
export const SPONSORSHIP_SCOPES = ['uk_skilled_worker', 'eu', 'us_h1b', 'unspecified'] as const;
export type SponsorshipScope = typeof SPONSORSHIP_SCOPES[number];
/**
 * `stated` es la oferta afirmando que patrocina. `employer_registered` es OTRA cosa y vale
 * bastante menos: significa "este empleador figura en un registro oficial de patrocinadores",
 * no "este puesto patrocina". Confundirlos convertiría un dato administrativo en una promesa.
 */
export const SPONSORSHIP_STATUSES = ['stated', 'employer_registered', 'stated_none', 'unknown'] as const;
export type SponsorshipStatus = typeof SPONSORSHIP_STATUSES[number];
export const SPONSORSHIP_EVIDENCE_KINDS = ['description_phrase', 'registry_match', 'provider_field'] as const;
export interface SponsorshipSignal {
  status: SponsorshipStatus;
  scope?: SponsorshipScope;
  /** `quote` es texto literal de la fuente; el parser comprueba que la descripción lo contenga. */
  evidence: { kind: typeof SPONSORSHIP_EVIDENCE_KINDS[number]; source: string; quote: string; observedAt: string };
}
export interface Opportunity {
  title: string;
  company: string;
  description?: string;
  source?: string;
  externalId?: string;
  url?: string;
  kind?: Kind;
  skills: string[];
  remote?: boolean;
  remoteness?: Remoteness;
  seniority?: Seniority[];
  employmentType?: EmploymentType;
  locationRestrictions?: string[];
  relocationRequired?: boolean;
  location?: string;
  industry?: string;
  compensation?: Compensation;
  payDisclosure?: PayDisclosure;
  payEvidence?: PayEvidence;
  sponsorship?: SponsorshipSignal;
  expiresAt?: string;
  publishedAt?: string;
  publicationEvidence?: PublicationEvidence;
  availability?: AvailabilityEvidence;
  recurring?: boolean;
  growthPotential?: boolean;
}
/**
 * Configuración de la señal POSITIVA de relevancia. Vive aparte de `excludedTerms`
 * porque responde otra pregunta: screening decide qué descartar, relevance decide qué encaja.
 */
export interface RelevanceConfig {
  /**
   * Términos del rol objetivo AGRUPADOS POR FAMILIA, cotejados contra título y descripción.
   *
   * Es un mapa y no una lista porque una persona puede buscar varios perfiles a la vez (ingeniería
   * de IA, robótica, management) y el puntaje de rol satura en 40: con todos los términos en una
   * sola bolsa, casi cualquier título de ingeniería toca el techo y el componente deja de separar
   * una vacante de otra. Se puntúa contra la familia que MEJOR coincide, y cuál ganó viaja en la
   * salida porque decide qué currículum se adapta — uno que dice ser las tres cosas no gana ninguna.
   *
   * En el JSON, `roleTerms` admite tanto una lista plana (se normaliza a la familia `default`)
   * como un objeto de familias. Los perfiles anteriores siguen puntuando exactamente igual.
   */
  roleFamilies: Record<string, string[]>;
  /** Familias de rol que descartan de plano (ventas, nómina, legal…), no términos sueltos. */
  roleExcludedTerms: string[];
  /** Variantes por habilidad: `node.js` no coincide con `nodejs` ni con `node` sin esto. */
  skillAliases: Record<string, string[]>;
  /** Ubicaciones donde un puesto presencial sigue siendo interesante por la vía de reubicación. */
  relocationTargets: string[];
  /** Cuántas oportunidades entrega un corte diario. */
  dailyTarget: number;
}
export interface Profile {
  /**
   * Habilidades NÚCLEO: las que definen el encaje y las que el currículum vende. Son el
   * denominador del puntaje de habilidades, así que declarar aquí algo que casi nunca aparece
   * baja el puntaje de TODAS las ofertas por igual.
   */
  skills: string[];
  /**
   * Habilidades que la persona también tiene pero no son su venta. Suman un bono acotado cuando
   * la oferta las pide y NO entran al denominador, de modo que saber de más nunca castiga.
   * Esa asimetría es deliberada: sin ella, declarar honestamente todo lo que uno sabe empeoraba
   * el ranking de las ofertas que mejor encajan.
   */
  secondarySkills: string[];
  relevance: RelevanceConfig;
  preferredKinds: Exclude<Kind, 'unknown'>[];
  remoteOnly: boolean;
  targetHourlyUsd: number;
  freelanceFloorHourlyUsd: number;
  attractiveProjectBudgetUsd: number;
  hoursPerMonth: number;
  employmentMinimumMonthlyUsd: number;
  employmentTargetMonthlyUsd: number;
  relocationThresholdMonthlyUsd: number;
  excludedTerms: string[];
  excludedIndustries: string[];
}
export const defaultRelevance: RelevanceConfig = {
  roleFamilies: {}, roleExcludedTerms: [], skillAliases: {}, relocationTargets: [], dailyTarget: 10,
};
export const defaultProfile: Profile = {
  skills: [], secondarySkills: [], relevance: defaultRelevance, preferredKinds: ['employment', 'freelance'], remoteOnly: false,
  targetHourlyUsd: 25, freelanceFloorHourlyUsd: 25,
  attractiveProjectBudgetUsd: 2000, hoursPerMonth: 160,
  employmentMinimumMonthlyUsd: 3000, employmentTargetMonthlyUsd: 4500,
  relocationThresholdMonthlyUsd: 6000,
  excludedTerms: ['bombas para minería', 'mining pumps'], excludedIndustries: [],
};

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: se esperaba un objeto`);
  return value as Record<string, unknown>;
}
function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}: texto no vacío requerido`);
  return value.trim();
}
function positive(value: unknown, name: string, zero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0)) throw new Error(`${name}: número ${zero ? 'no negativo' : 'positivo'} requerido`);
  return value;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name}: se esperaba una lista`);
  return [...new Set(Array.from(value, v => str(v, name).toLowerCase()))];
}
function oneOf<T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${name}: uno de ${allowed.join(', ')}`);
  return value as T[number];
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name}: booleano requerido`);
  return value;
}
function httpUrl(value: unknown, name: string): string {
  const text = str(value, name);
  if (!['http:', 'https:'].includes(new URL(text).protocol)) throw new Error(`${name}: solo HTTP/HTTPS`);
  return text;
}
function dateOnly(value: unknown, name: string): string {
  const date = str(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error(`${name}: fecha válida YYYY-MM-DD requerida`);
  return date;
}
function timestamp(value: unknown, name: string): string {
  const text = str(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().replace('.000Z', 'Z') !== text.replace('.000Z', 'Z')) throw new Error(`${name}: timestamp UTC válido requerido`);
  return text;
}
export function parseAvailability(value: unknown): AvailabilityEvidence {
  const v = object(value, 'availability');
  if (typeof v.outcome !== 'string' || !['open', 'closed', 'missing', 'ambiguous', 'timeout', 'error'].includes(v.outcome)) throw new Error('availability.outcome inválido');
  const result: AvailabilityEvidence = { url: httpUrl(v.url, 'availability.url'), checkedAt: timestamp(v.checkedAt, 'checkedAt'), outcome: v.outcome as AvailabilityEvidence['outcome'] };
  if (v.httpStatus !== undefined) {
    if (!Number.isInteger(v.httpStatus) || Number(v.httpStatus) < 100 || Number(v.httpStatus) > 599) throw new Error('httpStatus inválido');
    result.httpStatus = v.httpStatus as number;
  }
  if (v.evidence !== undefined) result.evidence = str(v.evidence, 'availability.evidence');
  return result;
}
/**
 * Claves conocidas de `Opportunity`. `parseOpportunity` rechaza cualquier otra en vez de
 * descartarla en silencio: un adaptador que emita `visaSponsorship` o `salary` debe fallar
 * ruidosamente, no perder el dato sin que ninguna prueba lo note.
 */
export const OPPORTUNITY_KEYS = ['title', 'company', 'description', 'source', 'externalId', 'url', 'kind', 'skills',
  'remote', 'remoteness', 'seniority', 'employmentType', 'locationRestrictions', 'relocationRequired', 'location',
  'industry', 'compensation', 'payDisclosure', 'payEvidence', 'sponsorship', 'expiresAt', 'publishedAt',
  'publicationEvidence', 'availability', 'recurring', 'growthPotential'] as const;
export function parseOpportunity(value: unknown): Opportunity {
  const v = object(value, 'opportunity');
  const unknownKey = Object.keys(v).find(k => !OPPORTUNITY_KEYS.includes(k as typeof OPPORTUNITY_KEYS[number]));
  if (unknownKey) throw new Error(`opportunity: clave desconocida "${unknownKey}"`);
  const o: Opportunity = { title: str(v.title, 'title'), company: str(v.company, 'company'), skills: strings(v.skills === undefined ? [] : v.skills, 'skills') };
  for (const key of ['description', 'source', 'externalId', 'url', 'expiresAt', 'location', 'industry'] as const) {
    if (v[key] !== undefined) o[key] = str(v[key], key);
  }
  if (o.externalId && !o.source) throw new Error('externalId requiere source');
  if (o.url) {
    const url = new URL(o.url);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('url: solo HTTP/HTTPS');
  }
  if (o.expiresAt) {
    const date = o.expiresAt;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('expiresAt: fecha válida YYYY-MM-DD requerida');
  }
  if (v.publishedAt !== undefined) o.publishedAt = dateOnly(v.publishedAt, 'publishedAt');
  if (v.publicationEvidence !== undefined) {
    const e = object(v.publicationEvidence, 'publicationEvidence');
    o.publicationEvidence = { url: httpUrl(e.url, 'publicationEvidence.url'), excerpt: str(e.excerpt, 'publicationEvidence.excerpt'), observedAt: timestamp(e.observedAt, 'observedAt') };
  }
  if (v.availability !== undefined) o.availability = parseAvailability(v.availability);
  if (v.kind !== undefined) {
    if (typeof v.kind !== 'string' || !['employment', 'freelance', 'unknown'].includes(v.kind)) throw new Error('kind inválido');
    o.kind = v.kind as Kind;
  }
  for (const key of ['remote', 'recurring', 'growthPotential', 'relocationRequired'] as const) if (v[key] !== undefined) o[key] = bool(v[key], key);
  if (v.remoteness !== undefined) o.remoteness = oneOf(v.remoteness, REMOTENESS_LEVELS, 'remoteness');
  if (v.employmentType !== undefined) o.employmentType = oneOf(v.employmentType, EMPLOYMENT_TYPES, 'employmentType');
  if (v.payDisclosure !== undefined) o.payDisclosure = oneOf(v.payDisclosure, PAY_DISCLOSURES, 'payDisclosure');
  if (v.seniority !== undefined) {
    if (!Array.isArray(v.seniority) || !v.seniority.length) throw new Error('seniority: lista no vacía requerida');
    o.seniority = [...new Set(v.seniority.map(level => oneOf(level, SENIORITY_LEVELS, 'seniority')))];
  }
  if (v.locationRestrictions !== undefined) o.locationRestrictions = strings(v.locationRestrictions, 'locationRestrictions');
  if (v.payEvidence !== undefined) {
    const e = object(v.payEvidence, 'payEvidence');
    o.payEvidence = { field: str(e.field, 'payEvidence.field'), raw: str(e.raw, 'payEvidence.raw'), ...(e.converted !== undefined ? { converted: bool(e.converted, 'payEvidence.converted') } : {}) };
  }
  if (v.sponsorship !== undefined) {
    const s = object(v.sponsorship, 'sponsorship');
    const e = object(s.evidence, 'sponsorship.evidence');
    const quote = str(e.quote, 'sponsorship.evidence.quote').slice(0, 1000);
    const status = oneOf(s.status, SPONSORSHIP_STATUSES, 'sponsorship.status');
    // La cita debe existir LITERALMENTE en la descripción. Sin esto, "la oferta dice que
    // patrocina" degenera en "alguien escribió que lo dice" y la procedencia deja de valer.
    if (e.kind === 'description_phrase' && !(o.description ?? '').includes(quote)) throw new Error('sponsorship: la cita no aparece en la descripción');
    o.sponsorship = { status, ...(s.scope !== undefined ? { scope: oneOf(s.scope, SPONSORSHIP_SCOPES, 'sponsorship.scope') } : {}),
      evidence: { kind: oneOf(e.kind, SPONSORSHIP_EVIDENCE_KINDS, 'sponsorship.evidence.kind'), source: str(e.source, 'sponsorship.evidence.source'), quote, observedAt: timestamp(e.observedAt, 'sponsorship.evidence.observedAt') } };
  }
  // `remote` se conserva por compatibilidad pero deriva de `remoteness` cuando ambos vienen:
  // dos fuentes de verdad en desacuerdo son un error del adaptador, no un dato que promediar.
  if (o.remoteness !== undefined) {
    const derived = o.remoteness === 'fully_remote';
    if (o.remote !== undefined && o.remote !== derived) throw new Error('remote contradice remoteness');
    o.remote = derived;
  }
  if (v.compensation !== undefined) {
    const c = object(v.compensation, 'compensation');
    if (typeof c.period !== 'string' || !COMPENSATION_PERIODS.includes(c.period as CompensationPeriod)) throw new Error('compensation.period inválido');
    const currency = str(c.currency, 'currency').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency: código de tres letras requerido');
    o.compensation = { currency, period: c.period as Compensation['period'], min: positive(c.min, 'min', true) };
    for (const key of ['max', 'hoursPerMonth', 'estimatedHours'] as const) if (c[key] !== undefined) o.compensation[key] = positive(c[key], key, key === 'max');
    if ((o.compensation.max ?? o.compensation.min) < o.compensation.min) throw new Error('max debe ser >= min');
  }
  return o;
}
export function parseProfile(value: unknown): Profile {
  const v = object(value, 'profile');
  const p = { ...defaultProfile, skills: strings(v.skills === undefined ? [] : v.skills, 'skills'),
    secondarySkills: strings(v.secondarySkills === undefined ? [] : v.secondarySkills, 'secondarySkills'),
    preferredKinds: [...defaultProfile.preferredKinds] };
  // Una habilidad en las dos listas contaría dos veces y volvería el bono impredecible; el núcleo manda.
  const core = new Set(p.skills);
  if (p.secondarySkills.some(s => core.has(s))) throw new Error('secondarySkills: habilidad repetida en skills');
  if (v.preferredKinds !== undefined) {
    const kinds = strings(v.preferredKinds, 'preferredKinds');
    if (!kinds.length || kinds.some(k => !['employment', 'freelance'].includes(k))) throw new Error('preferredKinds inválido');
    p.preferredKinds = kinds as Profile['preferredKinds'];
  }
  if (v.remoteOnly !== undefined) p.remoteOnly = bool(v.remoteOnly, 'remoteOnly');
  for (const key of ['targetHourlyUsd', 'freelanceFloorHourlyUsd', 'attractiveProjectBudgetUsd', 'hoursPerMonth', 'employmentMinimumMonthlyUsd', 'employmentTargetMonthlyUsd', 'relocationThresholdMonthlyUsd'] as const) if (v[key] !== undefined) p[key] = positive(v[key], key);
  for (const key of ['excludedTerms', 'excludedIndustries'] as const) p[key] = strings(v[key] ?? defaultProfile[key], key);
  if (p.employmentTargetMonthlyUsd < p.employmentMinimumMonthlyUsd) throw new Error('employmentTargetMonthlyUsd debe ser >= employmentMinimumMonthlyUsd');
  p.relevance = parseRelevance(v.relevance);
  return p;
}
function parseRelevance(value: unknown): RelevanceConfig {
  if (value === undefined) return { ...defaultRelevance, skillAliases: {} };
  const v = object(value, 'relevance');
  // Cerrado a propósito: una clave mal escrita aquí apagaría en silencio una señal de relevancia.
  const known = ['roleTerms', 'roleExcludedTerms', 'skillAliases', 'relocationTargets', 'dailyTarget'];
  if (Object.keys(v).some(k => !known.includes(k))) throw new Error('relevance: clave desconocida');
  const config: RelevanceConfig = { ...defaultRelevance, roleFamilies: {}, skillAliases: {} };
  for (const key of ['roleExcludedTerms', 'relocationTargets'] as const) config[key] = strings(v[key] ?? defaultRelevance[key], `relevance.${key}`);
  // Lista plana -> una sola familia. Los perfiles escritos antes de las familias puntúan igual que
  // siempre: con un único grupo, "la familia que mejor coincide" es la misma bolsa de antes.
  if (Array.isArray(v.roleTerms)) config.roleFamilies = { default: strings(v.roleTerms, 'relevance.roleTerms') };
  else if (v.roleTerms !== undefined) {
    for (const [family, terms] of Object.entries(object(v.roleTerms, 'relevance.roleTerms'))) {
      const name = str(family, 'relevance.roleTerms').toLowerCase();
      const list = strings(terms, `relevance.roleTerms.${family}`);
      // Una familia vacía puntuaría 0 y competiría por una plaza reservada sin poder ganarla nunca.
      if (!list.length) throw new Error(`relevance.roleTerms.${family}: familia vacía`);
      config.roleFamilies[name] = list;
    }
  }
  if (v.dailyTarget !== undefined) {
    config.dailyTarget = positive(v.dailyTarget, 'relevance.dailyTarget');
    if (!Number.isSafeInteger(config.dailyTarget)) throw new Error('relevance.dailyTarget: entero requerido');
  }
  if (v.skillAliases !== undefined) {
    for (const [skill, aliases] of Object.entries(object(v.skillAliases, 'relevance.skillAliases'))) {
      config.skillAliases[str(skill, 'relevance.skillAliases').toLowerCase()] = strings(aliases, `relevance.skillAliases.${skill}`);
    }
  }
  return config;
}
