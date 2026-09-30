/**
 * PDF del CV y la carta, con verificación ATS de lo que el PDF realmente contiene.
 *
 * LaTeX y `pdftotext` son binarios del SISTEMA, no dependencias npm: mismo precedente que `himalaya`
 * en `mail-runner.ts`. El proyecto sigue con cero dependencias de producción.
 *
 * La plantilla es de UNA COLUMNA, sin iconos y sin paquetes fuera de lo que trae una instalación
 * básica de TeX. No es minimalismo: una plantilla decorativa de dos columnas con glifos de fuente de
 * iconos desordena el orden de lectura y contamina la capa de texto, que es exactamente lo que un
 * ATS lee. Adoptar una plantilla bonita y después pelearla con un verificador es hacerlo al revés.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateFacts } from './candidacy.ts';

/** Motores admitidos. `lualatex` y `xelatex` aceptan fuentes del sistema vía `fontspec`. */
export const ENGINES = ['lualatex', 'xelatex', 'pdflatex'] as const;
export type Engine = typeof ENGINES[number];
/** Segundos de tope por compilación. Una plantilla de una página no tarda más de dos. */
const COMPILE_TIMEOUT_MS = 60_000;

/**
 * Escapa texto para LaTeX.
 *
 * Y a la vez **normaliza a ASCII lo que LaTeX convertiría en tipografía**: `--` se vuelve raya en la
 * capa de texto, y un ATS que descarta no-ASCII lee `2019–2026` como `20192026`. Medido el
 * 2026-09-30 compilando y extrayendo con `pdftotext`: `2019--2026` sale `U+2013`, `2019-2026` sale
 * ASCII. Por eso los guiones consecutivos se separan con `{}`, que LaTeX ignora al maquetar.
 */
export function tex(value: string): string {
  return value
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    // Rompe ligaduras de guiones ANTES de que LaTeX las convierta en raya.
    .replace(/-{2,}/g, match => match.split('').join('{}'))
    // Las comillas rectas tampoco: LaTeX las volvería tipográficas y salen fuera de ASCII.
    .replace(/"/g, "''")
    .replace(/</g, '\\textless{}')
    .replace(/>/g, '\\textgreater{}');
}

const PREAMBLE = (font: string) => `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1.8cm]{geometry}
\\usepackage{fontspec}
\\usepackage[hidelinks]{hyperref}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\setmainfont{${font}}
\\pagestyle{empty}
% Sin guionado: LaTeX parte palabras al final de línea y un ATS lee "min-utes", no "minutes".
% Medido el 2026-09-30 sobre una carta compilada: la capa de texto decía "90 min-\\nutes" y la
% palabra clave no aparecía. Un renglón algo más suelto es un precio barato por una palabra entera.
\\hyphenpenalty=10000
\\exhyphenpenalty=10000
\\sloppy
\\setlist[itemize]{nosep,leftmargin=*,label={-}}
\\titleformat{\\section}{\\large\\bfseries}{}{0pt}{}
\\titlespacing{\\section}{0pt}{10pt}{4pt}
\\begin{document}
`;
/** Fuente por defecto: presente en cualquier macOS y sin ligaduras decorativas. */
export const DEFAULT_FONT = 'Helvetica';

const period = (start: string, end?: string) => `${start} - ${end ?? 'present'}`;

/** CV en una columna. Los grupos y los logros llegan ya ordenados; aquí no se decide nada. */
export function renderCvTex(facts: CandidateFacts, options: { font?: string } = {}): string {
  const contact = [facts.location, facts.contact?.email, facts.contact?.phone, ...(facts.contact?.links ?? [])].filter((v): v is string => !!v);
  const experience = (facts.experience ?? []).map(entry => `\\textbf{${tex(entry.role)}} \\hfill ${tex(period(entry.start, entry.end))}\\\\
${tex(entry.company)}${entry.location ? ` | ${tex(entry.location)}` : ''}
\\begin{itemize}
${entry.achievements.map(a => `\\item ${tex(a)}`).join('\n')}
\\end{itemize}`).join('\n\n\\medskip\n');
  return `${PREAMBLE(options.font ?? DEFAULT_FONT)}\\begin{center}
{\\LARGE\\bfseries ${tex(facts.name)}}\\\\[2pt]
${facts.headline ? `${tex(facts.headline)}\\\\[2pt]` : ''}
${contact.map(tex).join(' | ')}
\\end{center}

${facts.skillGroups?.length ? `\\section*{Skills}
\\begin{itemize}
${facts.skillGroups.map(g => `\\item \\textbf{${tex(g.name)}:} ${g.skills.map(tex).join(', ')}`).join('\n')}
\\end{itemize}
` : ''}
${experience ? `\\section*{Experience}\n${experience}\n` : ''}
${facts.education?.length ? `\\section*{Education}
\\begin{itemize}
${facts.education.map(e => `\\item \\textbf{${tex(e.degree)}}, ${tex(e.institution)} | ${tex(period(e.start, e.end))}`).join('\n')}
\\end{itemize}
` : ''}
${facts.languages?.length ? `\\section*{Languages}
\\begin{itemize}
${facts.languages.map(l => `\\item ${tex(l.name)}: ${tex(l.level)}${l.evidence ? ` (${tex(l.evidence)})` : ''}`).join('\n')}
\\end{itemize}
` : ''}\\end{document}
`;
}

/** Carta en una columna, con el cuerpo ya redactado por `application-draft.ts`. */
export function renderCoverLetterTex(inputs: { facts: CandidateFacts; company: string; paragraphs: readonly string[]; bullets: readonly string[]; font?: string }): string {
  const { facts, company, paragraphs, bullets } = inputs;
  const contact = [facts.location, facts.contact?.email, ...(facts.contact?.links ?? [])].filter((v): v is string => !!v);
  return `${PREAMBLE(inputs.font ?? DEFAULT_FONT)}\\begin{flushright}
${tex(facts.name)}\\\\
${contact.map(tex).join(' | ')}
\\end{flushright}

\\noindent ${tex(company)}

\\bigskip
\\noindent Dear Hiring Team,

${paragraphs.map(p => `\\medskip\\noindent ${tex(p)}`).join('\n\n')}

${bullets.length ? `\\begin{itemize}\n${bullets.map(b => `\\item ${tex(b)}`).join('\n')}\n\\end{itemize}` : ''}

\\bigskip
\\noindent Kind regards,\\\\
${tex(facts.name)}
\\end{document}
`;
}

/**
 * Compila un `.tex` a PDF. Devuelve la ruta del PDF.
 *
 * `-halt-on-error` y `-interaction=nonstopmode`: LaTeX pregunta por la consola cuando algo falla, y
 * sin esto la compilación se queda esperando una tecla para siempre. Se corre DOS veces porque
 * `\hfill` y las referencias necesitan la segunda pasada para maquetar bien.
 */
export async function compilePdf(texSource: string, directory: string, name: string, options: { engine?: Engine } = {}): Promise<string> {
  const engine = options.engine ?? 'lualatex';
  if (!ENGINES.includes(engine)) throw new Error('engine inválido');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('nombre de archivo inválido');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const texPath = join(directory, `${name}.tex`);
  await writeFile(texPath, texSource, { mode: 0o600 });
  for (let pass = 0; pass < 2; pass++) {
    const result = spawnSync(engine, ['-interaction=nonstopmode', '-halt-on-error', `-output-directory=${directory}`, texPath],
      { encoding: 'utf8', timeout: COMPILE_TIMEOUT_MS });
    if (result.error) throw new Error(`pdf_compile_unavailable: ${engine}`);
    if (result.status !== 0) {
      // El log de LaTeX es enorme; se reporta solo la primera línea de error, que es la útil.
      const reason = (result.stdout ?? '').split('\n').find(line => line.startsWith('!')) ?? `exit ${result.status}`;
      throw new Error(`pdf_compile_failed: ${reason.trim()}`);
    }
  }
  return join(directory, `${name}.pdf`);
}

export interface AtsReport {
  ok: boolean;
  pages: number;
  characters: number;
  /** Términos buscados que SÍ aparecen en la capa de texto. */
  present: string[];
  /** Los que no. Cada uno es una palabra clave de la oferta que el PDF no comunica. */
  missing: string[];
  /** Años pegados a un guión no-ASCII. Vacío es lo correcto, y esto SÍ falla. */
  unicodeDates: string[];
  /**
   * Cualquier carácter fuera de ASCII en la capa de texto. Se REPORTA pero no falla: el nombre o la
   * ciudad de la persona pueden llevar acentos legítimamente, y un ATS que los destroce destroza un
   * dato suyo, no un defecto de la plantilla. Sirve para revisar de un vistazo que lo no-ASCII que
   * aparece sea solo eso y no tipografía que la plantilla introdujo sola.
   */
  nonAscii: string[];
  issues: string[];
}
/** NFC, comillas y guiones tipográficos a su forma recta, espacios colapsados. Solo para comparar. */
const fold = (value: string) => value.normalize('NFC')
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
/**
 * Solo letras y dígitos, para buscar una palabra clave sin que la maquetación produzca un falso
 * negativo. Un guionado al final de renglón deja "min-\nutes" en la capa de texto, y buscar
 * "minutes" fallaba: el informe decía "falta esta palabra clave" cuando el problema era otro.
 * Se acepta el riesgo de un falso positivo —"a rt" casando con "art"— porque un falso negativo
 * esconde un defecto real detrás de uno tipográfico, que es mucho peor.
 */
const squash = (value: string) => fold(value).replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Comprueba lo que el PDF REALMENTE contiene, no lo que el `.tex` decía.
 *
 * Es la compuerta que faltaba, y la idea viene de `tools/verify_pdf.py` de `MadsLorentzen/ai-job-search`.
 * Cuatro comprobaciones, y la tercera es la que no se le ocurre a nadie:
 *
 * 1. Hay capa de texto. Un PDF de solo imagen es invisible para un ATS y se ve perfecto en pantalla.
 * 2. Las palabras clave de la oferta aparecen, comparadas con plegado tipográfico.
 * 3. Ninguna fecha lleva guión no-ASCII. Esta comprobación **no** normaliza, a propósito: busca
 *    exactamente lo que el plegado de la comprobación 2 escondería. Medido el 2026-09-30: `2019--2026`
 *    en LaTeX sale como `2019\u20132026`, y un ATS que descarta no-ASCII lo lee `20192026`.
 * 4. El número de páginas es el esperado.
 */
export async function verifyAtsLayer(pdfPath: string, options: { keywords?: readonly string[]; minCharacters?: number; expectedPages?: number } = {}): Promise<AtsReport> {
  const result = spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 8_000_000, timeout: COMPILE_TIMEOUT_MS });
  if (result.error) throw new Error('ats_pdftotext_unavailable');
  if (result.status !== 0) throw new Error('ats_pdftotext_failed');
  const raw = result.stdout ?? '';
  const folded = fold(raw);
  const issues: string[] = [];
  const minCharacters = options.minCharacters ?? 200;
  if (folded.length < minCharacters) issues.push(`text_layer_too_short:${folded.length}`);
  const squashed = squash(raw);
  const keywords = [...new Set((options.keywords ?? []).map(k => fold(k)).filter(Boolean))];
  const present = keywords.filter(keyword => squashed.includes(squash(keyword)));
  const missing = keywords.filter(keyword => !squashed.includes(squash(keyword)));
  if (missing.length) issues.push(`keywords_missing:${missing.length}`);
  // SIN plegar: se busca el carácter problemático tal como quedó en el PDF.
  const unicodeDates = [...new Set(raw.match(/\d{4}\s?[\u2010-\u2015]\s?\d{2,4}/g) ?? [])];
  if (unicodeDates.length) issues.push(`unicode_dates:${unicodeDates.length}`);
  // `pdftotext` separa páginas con un salto de formulario; la última no lo lleva.
  const nonAscii = [...new Set((raw.match(/[^\u0000-\u007F]/g) ?? []))];
  const pages = raw ? raw.split('\f').filter((page, index, all) => page.trim() || index < all.length - 1).length : 0;
  if (options.expectedPages !== undefined && pages !== options.expectedPages) issues.push(`pages:${pages}!=${options.expectedPages}`);
  return { ok: !issues.length, pages, characters: folded.length, present, missing, unicodeDates, nonAscii, issues };
}
