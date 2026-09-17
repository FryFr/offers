import { screen } from './screening.ts';
import type { Kind, Opportunity, Profile, VerificationStatus } from './contracts.ts';

export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export interface Verification {
  status: VerificationStatus;
  reasons: string[];
  ageDays: number | null;
  sameDay: boolean;
  validUntil: string | null;
}
/** UTC calendar days, inclusive day 3. Status is derived, never imported. */
export function verification(o: Opportunity, now: Date): Verification {
  if (!Number.isFinite(now.getTime())) throw new Error('Fecha de evaluación inválida');
  const today = Date.parse(now.toISOString().slice(0, 10));
  const ageDays = o.publishedAt ? (today - Date.parse(o.publishedAt)) / 86_400_000 : null;
  const a = o.availability;
  const reasons: string[] = [];
  const unavailable = expiration(o, now) === 'expired' || a?.outcome === 'closed' || a?.outcome === 'missing' || a?.httpStatus === 404 || a?.httpStatus === 410;
  if (expiration(o, now) === 'expired') reasons.push('deadline_expired');
  if (a?.httpStatus === 404 || a?.httpStatus === 410) reasons.push(`source_http_${a.httpStatus}`);
  if (a?.outcome === 'closed') reasons.push('listing_closed');
  if (a?.outcome === 'missing') reasons.push('source_missing');
  if (ageDays === null) reasons.push('publication_date_missing');
  else if (ageDays < 0) reasons.push('publication_date_future');
  else if (ageDays > 3) reasons.push('publication_older_than_3_days');
  if (!o.publicationEvidence) reasons.push('publication_evidence_missing');
  else if (Date.parse(o.publicationEvidence.observedAt) > now.getTime() || (o.publishedAt && Date.parse(o.publicationEvidence.observedAt) < Date.parse(o.publishedAt))) reasons.push('publication_evidence_time_invalid');
  if (o.publicationEvidence && o.publicationEvidence.url !== o.url) reasons.push('publication_source_mismatch');
  if (!o.url) reasons.push('source_url_missing');
  if (!a) reasons.push('availability_missing');
  else {
    if (a.url !== o.url) reasons.push('availability_source_mismatch');
    if (Date.parse(a.checkedAt) > now.getTime()) reasons.push('verification_time_future');
    if (o.publishedAt && Date.parse(a.checkedAt) < Date.parse(o.publishedAt)) reasons.push('verification_before_publication');
    if (now.getTime() >= Date.parse(a.checkedAt) + VERIFICATION_TTL_MS) reasons.push('verification_expired');
    if (['ambiguous', 'timeout', 'error'].includes(a.outcome)) reasons.push(`availability_${a.outcome}`);
    if (a.outcome === 'open' && (!a.evidence || a.httpStatus !== 200)) reasons.push('availability_not_confirmed');
  }
  return { status: unavailable ? 'unavailable' : ageDays !== null && ageDays > 3 ? 'stale' : reasons.length ? 'unknown' : 'verified', reasons, ageDays, sameDay: ageDays === 0,
    validUntil: a ? new Date(Math.min(Date.parse(a.checkedAt) + VERIFICATION_TTL_MS, o.publishedAt ? Date.parse(o.publishedAt) + 4 * 86_400_000 : Infinity, o.expiresAt ? Date.parse(o.expiresAt) + 86_400_000 : Infinity)).toISOString() : null };
}

export function classify(o: Opportunity): { kind: Kind; reason: string } {
  if (o.kind && o.kind !== 'unknown') return { kind: o.kind, reason: 'Tipo declarado manualmente' };
  const text = `${o.title} ${o.description ?? ''}`.toLowerCase();
  const freelance = /\b(freelance|freelancer|contractor|por proyecto)\b/.test(text) || o.compensation?.period === 'project';
  const employment = /\b(empleo|empleado|indefinido|full[ -]time|part[ -]time|employment)\b/.test(text);
  return { kind: freelance === employment ? 'unknown' : freelance ? 'freelance' : 'employment', reason: freelance && employment ? 'Señales contradictorias; revisar' : freelance || employment ? 'Inferido de texto o compensación por proyecto' : 'Sin señales suficientes; revisar' };
}
export interface Normalized {
  hourlyUsd: { min: number; max: number } | null;
  monthlyUsd: { min: number; max: number } | null;
  projectUsd: { min: number; max: number } | null;
  assumptions: string[];
}
export function normalize(o: Opportunity, p: Profile): Normalized {
  const n: Normalized = { hourlyUsd: null, monthlyUsd: null, projectUsd: null, assumptions: [] };
  const c = o.compensation;
  if (!c) { n.assumptions.push('Compensación no informada'); return n; }
  if (c.currency !== 'USD') { n.assumptions.push(`Moneda ${c.currency} sin tasa de cambio; no se convierte`); return n; }
  const range = { min: c.min, max: c.max ?? c.min };
  const scale = (factor: number) => ({ min: range.min * factor, max: range.max * factor });
  const hours = c.hoursPerMonth ?? p.hoursPerMonth;
  if (c.period === 'hour') { n.hourlyUsd = range; n.monthlyUsd = scale(hours); n.assumptions.push(`Proyección mensual con ${hours} horas, sin garantía de volumen`); }
  if (c.period === 'month') { n.monthlyUsd = range; n.hourlyUsd = scale(1 / hours); n.assumptions.push(`Equivalencia usando ${hours} horas/mes`); }
  if (c.period === 'project') {
    n.projectUsd = range;
    if (c.estimatedHours) { n.hourlyUsd = scale(1 / c.estimatedHours); n.assumptions.push(`Proyecto estimado en ${c.estimatedHours} horas`); }
    else n.assumptions.push('Proyecto sin horas estimadas; tarifa horaria desconocida');
  }
  return n;
}
export function expiration(o: Opportunity, now: Date): 'active' | 'expired' | 'unknown' {
  if (!Number.isFinite(now.getTime())) throw new Error('Fecha de evaluación inválida');
  if (!o.expiresAt) return 'unknown';
  return now.getTime() >= Date.parse(o.expiresAt) + 86_400_000 ? 'expired' : 'active';
}
export interface Score { value: number; reasons: { points: number; reason: string }[] }
function score(reasons: Score['reasons']): Score { return { value: Math.min(100, Math.max(0, reasons.reduce((sum, r) => sum + r.points, 0))), reasons }; }
export function evaluate(o: Opportunity, p: Profile, now: Date) {
  const classification = classify(o);
  const normalized = normalize(o, p);
  const matching = p.skills.filter(s => o.skills.includes(s));
  const fit = score([
    { points: p.skills.length ? Math.round(60 * matching.length / p.skills.length) : 30, reason: p.skills.length ? `Habilidades coincidentes: ${matching.join(', ') || 'ninguna'} (${matching.length}/${p.skills.length})` : 'Sin preferencias de habilidades: valor neutral' },
    { points: classification.kind === 'unknown' ? 10 : p.preferredKinds.includes(classification.kind) ? 20 : 0, reason: `Tipo: ${classification.kind}; preferencias: ${p.preferredKinds.join(', ')}` },
    { points: !p.remoteOnly || o.remote === true ? 20 : o.remote === undefined ? 10 : 0, reason: !p.remoteOnly ? 'Sin restricción de trabajo remoto' : `Remoto: ${o.remote ?? 'desconocido'}` },
  ]);
  const hourly = normalized.hourlyUsd?.min;
  const attractiveBudget = (normalized.projectUsd?.min ?? 0) >= p.attractiveProjectBudgetUsd;
  const flexibility = classification.kind === 'freelance' && (!!o.recurring || !!o.growthPotential || attractiveBudget);
  const belowFloor = hourly !== undefined && hourly < p.freelanceFloorHourlyUsd;
  const economic = score([
    { points: hourly === undefined ? 0 : Math.round(70 * Math.min(1, hourly / p.targetHourlyUsd)), reason: hourly === undefined ? 'Tarifa horaria desconocida: sin puntos de tarifa' : `Tarifa conservadora USD ${hourly}/h frente a objetivo USD ${p.targetHourlyUsd}/h` },
    { points: classification.kind === 'freelance' && o.recurring ? 10 : 0, reason: o.recurring ? 'Recurrencia declarada (bonifica freelance)' : 'Sin recurrencia declarada' },
    { points: classification.kind === 'freelance' && o.growthPotential ? 10 : 0, reason: o.growthPotential ? 'Crecimiento declarado (bonifica freelance)' : 'Sin crecimiento declarado' },
    { points: attractiveBudget ? 10 : 0, reason: `Presupuesto de proyecto ${attractiveBudget ? 'alcanza' : 'no alcanza o no informa'} umbral USD ${p.attractiveProjectBudgetUsd}` },
  ]);
  const review = hourly === undefined ? 'needs_information' : classification.kind === 'unknown' ? 'needs_classification' : classification.kind !== 'freelance' ? 'not_applicable' : !belowFloor ? 'meets_floor' : flexibility ? 'flexible_review' : 'below_floor';
  return { verification: verification(o, now), classification, normalized, screening: screen(o, p, classification.kind), expiration: expiration(o, now), scores: { fit, economic }, freelanceReview: { status: review, reason: `Umbral USD ${p.freelanceFloorHourlyUsd}/h; excepciones: recurrencia, crecimiento o presupuesto de proyecto >= USD ${p.attractiveProjectBudgetUsd}`, flexibilitySignals: flexibility }, evaluatedAt: now.toISOString() };
}
