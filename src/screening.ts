import type { Kind, Opportunity, Profile } from './contracts.ts';
import { canonical, contains } from './text.ts';
import { normalizePay } from './compensation.ts';

type Status = 'eligible' | 'ineligible' | 'unknown' | 'not_applicable';
interface Decision { status: Status; reason: string }

export function screen(o: Opportunity, p: Profile, kind: Kind) {
  const text = canonical([o.title, o.company, o.description, o.industry, ...o.skills].filter(Boolean).join(' '));
  const matches: string[] = [];
  // Mandatory domain exclusion, including common Spanish/English variants.
  const pump = text.match(/\b(bombas?|pumps?|pumping)\b/)?.[0];
  const mining = text.match(/\b(mineria|minero|minera|mineros|mineras|mining|mines?)\b/)?.[0];
  if (pump && mining) matches.push(`Bombas para minería: términos "${pump}" + "${mining}"`);
  for (const term of p.excludedTerms) if (contains(text, canonical(term))) matches.push(`Término excluido: "${term}"`);
  for (const industry of p.excludedIndustries) if (contains(text, canonical(industry))) matches.push(`Industria excluida: "${industry}"`);

  const c = o.compensation;
  const pay = normalizePay(c, p.hoursPerMonth);
  // Profile hours are useful for projections, but are not evidence of paid volume: el gate solo
  // acepta una cifra mensual que no descanse en horas supuestas. La proyección con horas del
  // perfil alimenta `indicative`, que ordena pero no decide elegibilidad.
  const monthly = pay.monthlyBasis === 'declared' ? pay.monthlyUsd : null;
  const indicativeMonthly = pay.monthlyUsd;
  const threshold = (amount: number, strict: boolean): Decision => {
    const rule = `USD ${amount}/mes (${strict ? 'estrictamente mayor' : 'mínimo inclusivo'})`;
    if (!monthly) return { status: 'unknown', reason: `${rule}; falta compensación mensual USD o tarifa USD con horas mensuales declaradas` };
    const meets = (n: number) => strict ? n > amount : n >= amount;
    return { status: meets(monthly.min) ? 'eligible' : !meets(monthly.max) ? 'ineligible' : 'unknown', reason: `${rule}; rango informado/equivalente USD ${monthly.min}–${monthly.max}/mes${c?.period === 'hour' ? '; usa horas declaradas, sin garantía de volumen' : ''}` };
  };
  const salary = threshold(p.employmentMinimumMonthlyUsd, false);
  const target = threshold(p.employmentTargetMonthlyUsd, false);
  const relocation: Decision = o.relocationRequired === false
    ? { status: 'eligible', reason: 'No requiere relocalización según declaración' }
    : o.relocationRequired === true ? threshold(p.relocationThresholdMonthlyUsd, true)
    : { status: 'unknown', reason: 'Necesidad de relocalización no informada; no se infiere de ubicación o remoto' };
  const applicable = kind === 'employment';
  const status: Status = kind === 'freelance' ? 'not_applicable' : kind === 'unknown' ? 'unknown'
    : [salary, relocation].some(d => d.status === 'ineligible') ? 'ineligible'
    : [salary, relocation].some(d => d.status === 'unknown') ? 'unknown' : 'eligible';
  const notApplicable: Decision = { status: kind === 'freelance' ? 'not_applicable' : 'unknown', reason: 'Requiere clasificación como empleo' };
  /**
   * Señal ORIENTATIVA para ordenar, nunca para decidir elegibilidad. Acepta la proyección con
   * horas del perfil y las conversiones de moneda que el gate rechaza, y va acotada por debajo
   * de lo que otorga un salario publicado: un 6k/mes declarado siempre gana a una conjetura.
   */
  const indicative = indicativeMonthly === null
    ? { status: 'unknown' as const, reason: o.payDisclosure === 'unparsed' ? 'La fuente publicó pago pero no se pudo interpretar' : 'Salario no publicado por la fuente', monthlyUsd: null }
    : { status: indicativeMonthly.min >= p.employmentMinimumMonthlyUsd ? 'meets' as const : indicativeMonthly.max >= p.employmentMinimumMonthlyUsd ? 'partial' as const : 'below' as const,
        reason: `Orientativo USD ${Math.round(indicativeMonthly.min)}–${Math.round(indicativeMonthly.max)}/mes (${pay.monthlyBasis === 'declared' ? 'base declarada' : 'proyectado con horas del perfil'}${pay.converted ? ', convertido de otra moneda' : ''})`,
        monthlyUsd: indicativeMonthly };
  return {
    status: matches.length ? 'discarded' as const : 'retained' as const,
    reasons: matches,
    employment: { status, salary: applicable ? salary : notApplicable, target: applicable ? target : notApplicable, relocation: applicable ? relocation : notApplicable },
    indicative,
    payDisclosure: o.payDisclosure ?? (o.compensation ? 'published' : 'not_published'),
  };
}
