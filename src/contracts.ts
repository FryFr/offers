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
export interface Compensation {
  currency: string;
  period: 'hour' | 'month' | 'project';
  min: number;
  max?: number;
  hoursPerMonth?: number;
  estimatedHours?: number;
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
  relocationRequired?: boolean;
  location?: string;
  industry?: string;
  compensation?: Compensation;
  expiresAt?: string;
  publishedAt?: string;
  publicationEvidence?: PublicationEvidence;
  availability?: AvailabilityEvidence;
  recurring?: boolean;
  growthPotential?: boolean;
}
export interface Profile {
  skills: string[];
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
export const defaultProfile: Profile = {
  skills: [], preferredKinds: ['employment', 'freelance'], remoteOnly: false,
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
  return [...new Set(value.map(v => str(v, name).toLowerCase()))];
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
  if (!['open', 'closed', 'missing', 'ambiguous', 'timeout', 'error'].includes(String(v.outcome))) throw new Error('availability.outcome inválido');
  const result: AvailabilityEvidence = { url: httpUrl(v.url, 'availability.url'), checkedAt: timestamp(v.checkedAt, 'checkedAt'), outcome: v.outcome as AvailabilityEvidence['outcome'] };
  if (v.httpStatus !== undefined) {
    if (!Number.isInteger(v.httpStatus) || Number(v.httpStatus) < 100 || Number(v.httpStatus) > 599) throw new Error('httpStatus inválido');
    result.httpStatus = v.httpStatus as number;
  }
  if (v.evidence !== undefined) result.evidence = str(v.evidence, 'availability.evidence');
  return result;
}
export function parseOpportunity(value: unknown): Opportunity {
  const v = object(value, 'opportunity');
  const o: Opportunity = { title: str(v.title, 'title'), company: str(v.company, 'company'), skills: strings(v.skills ?? [], 'skills') };
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
    if (!['employment', 'freelance', 'unknown'].includes(String(v.kind))) throw new Error('kind inválido');
    o.kind = v.kind as Kind;
  }
  for (const key of ['remote', 'recurring', 'growthPotential', 'relocationRequired'] as const) if (v[key] !== undefined) o[key] = bool(v[key], key);
  if (v.compensation !== undefined) {
    const c = object(v.compensation, 'compensation');
    if (!['hour', 'month', 'project'].includes(String(c.period))) throw new Error('compensation.period inválido');
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
  const p = { ...defaultProfile, skills: strings(v.skills ?? [], 'skills'), preferredKinds: [...defaultProfile.preferredKinds] };
  if (v.preferredKinds !== undefined) {
    const kinds = strings(v.preferredKinds, 'preferredKinds');
    if (!kinds.length || kinds.some(k => !['employment', 'freelance'].includes(k))) throw new Error('preferredKinds inválido');
    p.preferredKinds = kinds as Profile['preferredKinds'];
  }
  if (v.remoteOnly !== undefined) p.remoteOnly = bool(v.remoteOnly, 'remoteOnly');
  for (const key of ['targetHourlyUsd', 'freelanceFloorHourlyUsd', 'attractiveProjectBudgetUsd', 'hoursPerMonth', 'employmentMinimumMonthlyUsd', 'employmentTargetMonthlyUsd', 'relocationThresholdMonthlyUsd'] as const) if (v[key] !== undefined) p[key] = positive(v[key], key);
  for (const key of ['excludedTerms', 'excludedIndustries'] as const) p[key] = strings(v[key] ?? defaultProfile[key], key);
  if (p.employmentTargetMonthlyUsd < p.employmentMinimumMonthlyUsd) throw new Error('employmentTargetMonthlyUsd debe ser >= employmentMinimumMonthlyUsd');
  return p;
}
