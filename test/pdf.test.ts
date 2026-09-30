import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCandidateFacts } from '../src/candidacy.ts';
import { compilePdf, renderCvTex, renderCoverLetterTex, tex, verifyAtsLayer, DEFAULT_FONT } from '../src/pdf.ts';

/** LaTeX y poppler son binarios del sistema: si faltan, estas pruebas se omiten en vez de fallar. */
const has = (binary: string) => spawnSync(binary, ['--version'], { encoding: 'utf8' }).error === undefined;
const toolchain = has('lualatex') && has('pdftotext');

const facts = parseCandidateFacts({
  schemaVersion: 2,
  name: 'Juan Sebastian Silva Medina',
  headline: 'AI & Automation Engineer',
  location: 'Bogota, Colombia',
  contact: { email: 'juan@example.com', links: ['https://example.com/portfolio'] },
  skills: ['n8n', 'llm'],
  highlights: ['Runs 30+ production n8n workflows.'],
  experience: [{ company: 'Dynapro Pumps', role: 'Business Systems & AI Specialist', start: '2026-01', location: 'Bogota, Colombia',
    achievements: ['Run 30+ production n8n workflows integrating Odoo ERP and HubSpot CRM.', 'Reduced order processing from ~90 minutes to ~2 minutes.'] },
    { company: 'Teleperformance', role: 'Client Account Manager', start: '2020-06', end: '2022-08',
      achievements: ['Managed an operation of 1,200 people and achieved +30% in sales.'] }],
  education: [{ institution: 'Universidad EAN', degree: 'B.Eng. Mechatronics Engineering', start: '2021-02', end: '2025-11' }],
  languages: [{ name: 'English', level: 'C1', evidence: 'IELTS, British Council; valid 07/2025-07/2028' }],
  skillGroups: [{ name: 'AI & agents', skills: ['LLM integration', 'RAG', 'MCP'] }],
});

test('el escape de LaTeX protege los metacaracteres y evita la tipografía que rompe un ATS', () => {
  assert.equal(tex('50% & $100 #1 _x^2 {a}'), '50\\% \\& \\$100 \\#1 \\_x\\textasciicircum{}2 \\{a\\}');
  // LA regla medida: `--` en LaTeX se convierte en raya U+2013, y un ATS que descarta no-ASCII lee
  // "2019-2026" como "20192026". Los guiones consecutivos se separan con `{}`, que no se maqueta.
  assert.equal(tex('2019--2026'), '2019-{}-2026');
  assert.equal(tex('a---b'), 'a-{}-{}-b');
  assert.equal(tex('2019-2026'), '2019-2026', 'un guión simple no se toca: ya es ASCII');
  // Las comillas rectas también se volverían tipográficas.
  assert.equal(tex('say "hi"'), "say ''hi''");
  assert.equal(tex('a<b>c'), 'a\\textless{}b\\textgreater{}c');
});

test('renderCvTex produce una columna, sin iconos y sin paquetes fuera de una instalación básica', () => {
  const source = renderCvTex(facts);
  // Solo paquetes que trae BasicTeX. `moderncv` y `fontawesome5` NO están, y además son de dos
  // columnas y con glifos de iconos: desordenan la lectura y contaminan la capa de texto del ATS.
  const packages = [...source.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)].map(m => m[1]);
  assert.deepEqual(packages.sort(), ['enumitem', 'fontspec', 'geometry', 'hyperref', 'titlesec']);
  assert.equal(source.includes('moderncv'), false);
  assert.equal(source.includes('fontawesome'), false);
  assert.equal(source.includes('multicol'), false);
  assert.equal(source.includes('\\begin{tabular}'), false, 'ni tablas: un ATS lee sus columnas en el orden equivocado');
  assert.match(source, new RegExp(`\\\\setmainfont\\{${DEFAULT_FONT}\\}`));
  // La cronología completa viaja: ningún puesto se recorta para que quepa.
  for (const entry of facts.experience!) assert.ok(source.includes(entry.company));
  assert.equal(source, renderCvTex(facts), 'determinista');
});

test('compila el CV, la capa de texto es legible y las fechas quedan en ASCII', { skip: !toolchain }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-pdf-'));
  try {
    const pdf = await compilePdf(renderCvTex(facts), dir, 'cv');
    const report = await verifyAtsLayer(pdf, { keywords: ['n8n', 'LLM integration', 'Odoo'], expectedPages: 1 });
    assert.deepEqual(report.issues, [], 'el PDF pasa la compuerta ATS');
    assert.equal(report.ok, true);
    assert.equal(report.pages, 1);
    assert.ok(report.characters > 400, `capa de texto de ${report.characters} caracteres`);
    // Las palabras clave de la oferta están DE VERDAD en el PDF, no solo en el .tex.
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.present.sort(), ['llm integration', 'n8n', 'odoo']);
    // Y la comprobación que no normaliza: ni una fecha con guión no-ASCII.
    assert.deepEqual(report.unicodeDates, []);
    // LA PLANTILLA no aporta ni un carácter fuera de ASCII. Lo no-ASCII que quede tiene que venir
    // solo de los datos de la persona, y en este fixture no hay ninguno. El primer intento sí lo
    // aportaba: `label=--` en itemize se convertía en U+2013 en cada viñeta del documento.
    assert.deepEqual(report.nonAscii, [], 'la estructura del CV es ASCII pura');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('la compuerta ATS detecta lo que el ojo no ve', { skip: !toolchain }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-pdf-gate-'));
  try {
    // Un PDF con `--` en las fechas: se ve idéntico en pantalla y un ATS lo lee "20202022".
    const conRaya = `\\documentclass[11pt,a4paper]{article}\n\\usepackage{fontspec}\n\\setmainfont{${DEFAULT_FONT}}\n\\pagestyle{empty}\n\\begin{document}\nJuan Silva, engineer. Worked 2020--2022 on automation pipelines with n8n and llm integrations across several teams and clients, building and maintaining production workflows end to end.\n\\end{document}\n`;
    const report = await verifyAtsLayer(await compilePdf(conRaya, dir, 'raya'), { keywords: ['n8n'] });
    assert.equal(report.ok, false);
    assert.deepEqual(report.unicodeDates, ['2020–2022'], 'la raya tipográfica queda a la vista');
    assert.ok(report.issues.some(i => i.startsWith('unicode_dates')));
    // La palabra clave sí estaba: el fallo es SOLO la tipografía, que es justo lo difícil de ver.
    assert.deepEqual(report.missing, []);

    // Una palabra clave ausente se nombra, no se resume en un booleano.
    const faltante = await verifyAtsLayer(await compilePdf(renderCvTex(facts), dir, 'cv'), { keywords: ['kubernetes', 'n8n'] });
    assert.deepEqual(faltante.missing, ['kubernetes']);
    assert.deepEqual(faltante.present, ['n8n']);

    // Y una capa de texto vacía —el PDF de solo imagen— falla aunque se vea perfecto.
    const vacio = `\\documentclass{article}\n\\pagestyle{empty}\n\\begin{document}\\hbox{}\\end{document}\n`;
    const sinTexto = await verifyAtsLayer(await compilePdf(vacio, dir, 'vacio'), {});
    assert.equal(sinTexto.ok, false);
    assert.ok(sinTexto.issues.some(i => i.startsWith('text_layer_too_short')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('la compilación falla ruidosamente y valida sus argumentos', { skip: !toolchain }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-pdf-bad-'));
  try {
    // Sin `-halt-on-error` e `-interaction=nonstopmode`, LaTeX se queda esperando una tecla y la
    // compilación cuelga para siempre. Aquí tiene que fallar con el motivo.
    await assert.rejects(compilePdf('\\documentclass{article}\\begin{document}\\undefinedmacro\\end{document}\n', dir, 'roto'), /pdf_compile_failed/);
    await assert.rejects(compilePdf(renderCvTex(facts), dir, '../fuera'), /nombre de archivo inválido/);
    await assert.rejects(compilePdf(renderCvTex(facts), dir, 'cv', { engine: 'rm' as never }), /engine inválido/);
    await assert.rejects(verifyAtsLayer(join(dir, 'no-existe.pdf'), {}), /ats_pdftotext_failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('la carta compila y conserva las frases declaradas', { skip: !toolchain }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-letter-'));
  try {
    const bullets = facts.experience![0]!.achievements;
    const source = renderCoverLetterTex({ facts, company: 'Acme', paragraphs: ['I am writing about the AI Automation Engineer role at Acme.'], bullets });
    const report = await verifyAtsLayer(await compilePdf(source, dir, 'cover-letter'), { keywords: bullets, expectedPages: 1 });
    assert.deepEqual(report.issues, []);
    // Los logros llegan al PDF LITERALES: es la misma garantía que en el borrador Markdown.
    assert.deepEqual(report.missing, [], 'cada logro declarado aparece en el PDF');
    assert.deepEqual(report.unicodeDates, []);
    await writeFile(join(dir, 'kept.txt'), source);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ninguna palabra se parte al final de renglón, ni con texto largo', { skip: !toolchain }, async () => {
  // Encontrado compilando una carta real: LaTeX guionó "minutes" y la capa de texto decía
  // "90 min-\nutes". La palabra clave no aparecía, y el informe culpaba a la palabra clave cuando el
  // problema era la maquetación. Un ATS que no deshifena tampoco la encontraría, así que se arregla
  // la CAUSA —sin guionado— y además la comparación se hace inmune a artefactos de maquetado.
  const dir = await mkdtemp(join(tmpdir(), 'offers-hyphen-'));
  try {
    const largo = 'Built an AI document-processing pipeline that reduced order processing from approximately 90 minutes to approximately 2 minutes across several distinguished international manufacturing organisations.';
    const source = renderCoverLetterTex({ facts, company: 'Acme', paragraphs: [largo], bullets: [largo] });
    const pdf = await compilePdf(source, dir, 'largo');
    const report = await verifyAtsLayer(pdf, { keywords: [largo, 'minutes', 'document-processing'] });
    assert.deepEqual(report.missing, [], 'la frase completa aparece pese a ocupar varios renglones');
    assert.deepEqual(report.issues, []);
    // Y la capa de texto no contiene ni un guión pegado a un salto de renglón.
    const { spawnSync: run } = await import('node:child_process');
    const layer = run('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).stdout ?? '';
    assert.equal(/-\s*\n/.test(layer.replace(/^- /gm, '')), false, 'ninguna palabra queda partida');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
