/**
 * Un paquete de candidatura por oportunidad: `output/candidacy/<id>/`.
 *
 * El `<id>` es el mismo SHA-256 de `identity()` que es el id del registro, el `External Key` de
 * Notion y la clave del ledger de entregas. Desde una fila del tablero se llega a la carpeta copiando
 * esa celda. Es la propagación que el proyecto tenía a mano y nunca hizo.
 *
 * Y el CV se adapta a la FAMILIA de rol de la oferta. Si falta el archivo de hechos de esa familia,
 * la oferta no genera paquete y se reporta: mandarle un CV de robótica a un puesto de management es
 * peor que no mandar nada.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildCandidacyBrief, candidacyGate, renderCandidacyMarkdown, type CandidacyRecord, type CandidateFacts } from './candidacy.ts';
import { beforeSending, renderCoverLetterDraft, renderTailoredCv, selectAchievements } from './application-draft.ts';
import { deliverable, reviewCandidacy, type Finding } from './candidacy-review.ts';
import type { Profile } from './contracts.ts';
import { compilePdf, renderCoverLetterTex, renderCvTex, verifyAtsLayer, type AtsReport, type Engine } from './pdf.ts';

export interface PackageFile { name: string; contents: string }
export interface CandidacyPackage {
  opportunityId: string;
  roleFamily: string;
  /** Lo que `relevance()` halló en el texto de ESTA oferta. Con esto se verifica el PDF. */
  keywords: string[];
  files: PackageFile[];
  findings: Finding[];
  deliverable: boolean;
}
export interface SkippedCandidacy { opportunityId: string; reason: string; detail?: string }

/**
 * Construye el paquete en memoria. Puro: no escribe nada, para poder probarlo sin disco.
 *
 * `factsByFamily` mapea `relevance.roleFamily` a los hechos de esa familia. La clave `default` sirve
 * de reserva SOLO cuando la oferta no tiene familia; nunca para sustituir a una familia que falta.
 */
export function buildCandidacyPackage(record: CandidacyRecord, factsByFamily: Readonly<Record<string, CandidateFacts>>, profile: Profile, options: { tiers?: readonly string[] } = {}): CandidacyPackage | SkippedCandidacy {
  // El gate va PRIMERO: si la oferta no merece un paquete, el motivo es ese, no que falte un CV.
  if (!candidacyGate(record, options.tiers)) return { opportunityId: record.id, reason: 'gate_blocked', detail: record.evaluation.relevance.tier };
  const family = record.evaluation.relevance.roleFamily;
  const facts = factsByFamily[family] ?? (family ? undefined : factsByFamily.default);
  if (!facts) return { opportunityId: record.id, reason: 'candidate_facts_missing', detail: family || '(sin familia)' };
  const brief = buildCandidacyBrief(record, facts, options)!;
  const matched = brief.match.matched;
  const selected = selectAchievements(facts, matched);
  const inputs = { facts, opportunity: record.opportunity, profile, matched, selected };
  const letter = renderCoverLetterDraft(inputs);
  const cv = renderTailoredCv(inputs);
  const findings = reviewCandidacy({ facts, opportunity: record.opportunity, letter, cv, roleFamily: family, matched });
  return { opportunityId: record.id, roleFamily: family, keywords: [...matched], deliverable: deliverable(findings), findings,
    files: [
      { name: 'brief.md', contents: renderCandidacyMarkdown(brief) },
      { name: 'cover-letter.md', contents: letter },
      { name: 'cv.md', contents: cv },
      { name: 'review.json', contents: `${JSON.stringify({ schemaVersion: 1, opportunityId: record.id, roleFamily: family,
        deliverable: deliverable(findings), findings, beforeSending: beforeSending(record.opportunity, profile) }, null, 2)}\n` },
    ] };
}

/**
 * Escribe el paquete. Idempotente por bytes y atómico por archivo.
 *
 * Con `fsync` del archivo Y del directorio, que es lo que `writeCandidacyBriefs` no hacía y
 * `saveTrackingStore` sí: sin el del directorio, un corte justo después del `rename` puede dejar la
 * entrada sin persistir y el archivo huérfano. No es una transacción entre archivos, y no lo
 * pretende: volver a correr repara la salida.
 */
export async function writeCandidacyPackage(directory: string, pack: CandidacyPackage): Promise<{ path: string; changed: string[] }> {
  if (!/^[a-f0-9]{64}$/.test(pack.opportunityId)) throw new Error('candidacy.opportunityId: SHA-256 inválido');
  const path = join(directory, pack.opportunityId);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const changed: string[] = [];
  for (const file of [...pack.files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(file.name)) throw new Error('candidacy: nombre de archivo inválido');
    const target = join(path, file.name);
    let previous: string | undefined;
    try { previous = await readFile(target, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous === file.contents) continue;
    const temporary = join(path, `.${file.name}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(file.contents); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      const folder = await open(dirname(target), 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    } finally { await rm(temporary, { force: true }); }
    changed.push(file.name);
  }
  return { path, changed };
}

export interface CompiledPackage { cv: AtsReport; coverLetter: AtsReport; ok: boolean }
/**
 * Compila el CV y la carta a PDF junto al paquete, y pasa la compuerta ATS.
 *
 * Es OPT-IN porque compilar cuesta un par de segundos por oferta y quince ofertas son medio minuto.
 * El Markdown se genera siempre; el PDF, cuando se va a enviar algo.
 *
 * Las palabras clave con las que se verifica son las de ESTA oferta: lo que `relevance()` halló en su
 * texto. Comprobar contra una lista fija no diría nada sobre si el PDF comunica lo que esta vacante
 * pide. Y las viñetas de la carta se verifican literales, que es la misma garantía del Markdown
 * llevada hasta el archivo que se adjunta.
 */
export async function compileCandidacyPdfs(directory: string, pack: CandidacyPackage, facts: CandidateFacts, company: string, options: { engine?: Engine } = {}): Promise<CompiledPackage> {
  const path = join(directory, pack.opportunityId);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const letter = pack.files.find(file => file.name === 'cover-letter.md')!.contents;
  const paragraphs = letter.split('\n').filter(line => line && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('>') && !line.startsWith('**'));
  const bullets = letter.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2));
  // El CV se verifica contra lo que la OFERTA pide; la carta, contra sus propias viñetas, que es la
  // garantía del Markdown llevada hasta el archivo que se adjunta.
  const cvPath = await compilePdf(renderCvTex(facts), path, 'cv', options);
  const cv = await verifyAtsLayer(cvPath, { keywords: pack.keywords, expectedPages: 1 });
  const coverPath = await compilePdf(renderCoverLetterTex({ facts, company, paragraphs, bullets }), path, 'cover-letter', options);
  const coverLetter = await verifyAtsLayer(coverPath, { keywords: bullets, expectedPages: 1 });
  return { cv, coverLetter, ok: cv.ok && coverLetter.ok };
}
