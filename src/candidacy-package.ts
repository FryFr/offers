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

export interface PackageFile { name: string; contents: string }
export interface CandidacyPackage {
  opportunityId: string;
  roleFamily: string;
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
  return { opportunityId: record.id, roleFamily: family, deliverable: deliverable(findings), findings,
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
