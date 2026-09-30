import type { Opportunity, Profile } from './contracts.ts';
import type { report } from './pipeline.ts';
import { normalizePay } from './compensation.ts';

/**
 * Corte diario en Markdown. Es lo único de todo el sistema que una persona lee de verdad, así que
 * cada oferta tiene que poder juzgarse sin abrir el enlace: por qué está aquí, cuánto paga (o que
 * no se sabe), desde dónde se puede trabajar y si patrocina visado, con la cita textual.
 *
 * Determinista: el mismo informe produce el mismo archivo. Sin eso, no se puede comprobar que dos
 * ejecuciones iguales no cambian nada.
 */
export interface DigestOptions { date: string; profile: Profile }
type Snapshot = ReturnType<typeof report>;

/**
 * Las tres funciones siguientes están EXPORTADAS porque resuelven exactamente los tres datos que
 * una carta de presentación necesita confirmar antes de enviarse —compensación, modalidad con su
 * ubicación, y patrocinio de visado con su cita textual—. Estaban privadas, y el material de
 * postulación habría acabado con una segunda implementación que dijera lo mismo de otra forma.
 * Compartirlas garantiza que el digest y la carta nunca se contradigan.
 */
export const money = (o: Opportunity, profile: Profile): string => {
  if (!o.compensation) {
    return o.payDisclosure === 'unparsed'
      ? `⚠️ La fuente publicó pago pero no se pudo interpretar${o.payEvidence ? ` (dijo: "${o.payEvidence.raw}")` : ''}`
      : 'Salario no publicado por la fuente';
  }
  const pay = normalizePay(o.compensation, profile.hoursPerMonth);
  const { currency, period, min, max } = o.compensation;
  const declared = `${min.toLocaleString('es')}${max && max > min ? `–${max.toLocaleString('es')}` : ''} ${currency}/${period}`;
  const monthly = pay.monthlyUsd ? ` ≈ ${Math.round(pay.monthlyUsd.min).toLocaleString('es')} USD/mes` : '';
  return `${declared}${monthly}${pay.converted ? ' (convertido)' : ''}`;
};

export const place = (o: Opportunity): string => {
  const mode = o.remoteness ?? (o.remote === true ? 'fully_remote' : o.remote === false ? 'in_person' : 'unknown');
  const label = { fully_remote: 'Remoto', partially_remote: 'Parcialmente remoto', hybrid: 'Híbrido', in_person: 'Presencial', unknown: 'Modalidad no declarada' }[mode];
  const where = o.locationRestrictions?.length ? o.locationRestrictions.join(', ') : o.location;
  return where ? `${label} — ${where}` : label;
};

export const visa = (o: Opportunity): string | undefined => {
  const s = o.sponsorship;
  if (!s || s.status === 'unknown') return undefined;
  if (s.status === 'stated_none') return `🚫 La oferta dice que NO patrocina: "${s.evidence.quote.replace(/\s+/g, ' ').trim()}"`;
  if (s.status === 'employer_registered') return `🇬🇧 El empleador figura en el registro británico de patrocinadores (no es una promesa sobre este puesto)`;
  return `✅ Patrocinio declarado (${s.scope ?? 'sin alcance'}): "${s.evidence.quote.replace(/\s+/g, ' ').trim()}"`;
};

export function renderDigest(snapshot: Snapshot, options: DigestOptions): string {
  const byId = new Map(snapshot.records.map(r => [r.id, r]));
  const lines: string[] = [`# Ofertas del ${options.date}`, ''];
  if (!snapshot.recommendations.length) {
    // Entregar cero y decirlo es información; rellenar con ofertas que no encajan, no.
    lines.push('Hoy no hay ninguna oferta que supere el umbral de relevancia.', '',
      'No es un fallo del ciclo: significa que el pool de fuentes no produjo nada que encaje.',
      'Si se repite varios días, la respuesta es ampliar fuentes, no bajar el umbral.');
    return `${lines.join('\n')}\n`;
  }
  const nuevas = snapshot.recommendations.filter(r => !r.repeated).length;
  lines.push(`${snapshot.recommendations.length} oportunidades · **${nuevas} nuevas** · ${snapshot.recommendations.length - nuevas} repetidas`, '');
  for (const rec of snapshot.recommendations) {
    const record = byId.get(rec.id);
    if (!record) continue;
    const o = record.opportunity, e = record.evaluation;
    lines.push(`## ${rec.rank}. ${o.title}${rec.repeated ? ' *(repetida)*' : ''}`, '');
    lines.push(`**${o.company}** · ${place(o)} · publicada hace ${e.verification.ageDays ?? '?'} día(s)`, '');
    lines.push(`- **Pago:** ${money(o, options.profile)}`);
    if (e.screening.indicative.status !== 'unknown' && !o.compensation) lines.push(`- **Estimado:** ${e.screening.indicative.reason}`);
    lines.push(`- **Relevancia:** ${e.relevance.tier} (${e.relevance.score}/100)${e.relevance.roleMatched.length ? ` — rol: ${e.relevance.roleMatched.join(', ')}` : ''}`);
    if (e.relevance.skillsMatched.length) lines.push(`- **Habilidades encontradas:** ${e.relevance.skillsMatched.join(', ')}`);
    lines.push(`- **Tipo:** ${e.classification.kind}${o.employmentType ? ` (${o.employmentType})` : ''}${o.seniority?.length ? ` · ${o.seniority.join(', ')}` : ''}`);
    const sponsorship = visa(o);
    if (sponsorship) lines.push(`- **Visado:** ${sponsorship}`);
    lines.push(`- **Por qué está aquí:** ${rec.selectionReason}`);
    lines.push(`- ${o.url}`, '');
  }
  lines.push('---', '', 'Cada oferta pasó el gate de evidencia: fecha de publicación comprobable dentro de la ventana',
    'y disponibilidad verificada en las últimas 24 horas. Nada de esto es una recomendación de postularse:',
    'es una lista de vacantes que existen, están abiertas y encajan con el perfil declarado.');
  return `${lines.join('\n')}\n`;
}
