import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { evaluate } from '../src/evaluate.ts';
import { DESCRIPTION_BLOCKS, MAX_CHILDREN, appendChildrenRequest, markdownBlocks, pageBody, readChildrenRequest } from '../src/notion-body.ts';
import { parseCandidateFacts } from '../src/candidacy.ts';
import { selectAchievements, renderCoverLetterDraft, renderTailoredCv } from '../src/application-draft.ts';
import { ensurePageBody, type HttpTransport } from '../src/notion-sync.ts';
import { archiveBoard } from '../src/source-cli.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotionTransport } from '../src/notion-transport.ts';

const now = new Date('2026-09-16T12:00:00Z');
const profile = parseProfile({ skills: ['typescript'], relevance: { roleTerms: ['backend engineer'] } });
const job = (overrides: Partial<Opportunity> = {}) => parseOpportunity({ title: 'Senior Backend Engineer', company: 'Acme',
  skills: [], remoteness: 'fully_remote', description: 'Build typescript services for a distributed team.', ...overrides });
const body = (overrides: Partial<Opportunity> = {}) => {
  const opportunity = job(overrides);
  return pageBody({ opportunity, evaluation: evaluate(opportunity, profile, now), profile });
};
const texts = (blocks: Record<string, unknown>[]) => JSON.stringify(blocks);

test('el cuerpo dice por qué está aquí, cuánto paga y qué publicó la oferta', () => {
  // Las 1.258 páginas ya creadas están VACÍAS: una fila de 24 columnas obliga a abrir el navegador
  // para saber de qué va la oferta, que es justo el trabajo que este proyecto quita.
  const blocks = body();
  const serialized = texts(blocks);
  assert.match(serialized, /Por qué está aquí/);
  assert.match(serialized, /Relevancia (strong|possible)/);
  assert.match(serialized, /backend engineer/, 'el término de rol que coincidió');
  assert.match(serialized, /typescript/, 'la habilidad hallada en el texto');
  assert.match(serialized, /Compensación y modalidad/);
  assert.match(serialized, /Descripción publicada/);
  assert.match(serialized, /Build typescript services/);
  // Y el cuerpo reutiliza las funciones del digest: los dos dicen lo mismo de la misma oferta.
  assert.match(serialized, /Salario no publicado por la fuente/);
  assert.match(serialized, /Remoto/);
});

test('el material de postulación va PRIMERO y literalmente en el cuerpo', () => {
  // Juan no usaba el tablero porque la carta y el CV no estaban ahí: se escribían en
  // `output/candidacy/<id>/` como archivos locales que nadie abre. El tablero es donde decide a qué
  // postularse, así que es donde tiene que estar lo que va a enviar, listo para copiar y pegar.
  const facts = parseCandidateFacts({ schemaVersion: 2, name: 'Juan Sebastian Silva Medina',
    headline: 'AI & Automation Engineer', skills: ['typescript'],
    highlights: ['Runs 30+ production n8n workflows.'],
    experience: [{ company: 'Dynapro Pumps', role: 'AI Specialist', start: '2026-01',
      achievements: ['Built a typescript pipeline that cut processing from 90 to 2 minutes.'] }] });
  const opportunity = job();
  const matched = ['typescript'];
  const inputs = { facts, opportunity, profile, matched, selected: selectAchievements(facts, matched) };
  const material = { coverLetter: renderCoverLetterDraft(inputs), cv: renderTailoredCv(inputs) };
  const blocks = pageBody({ opportunity, evaluation: evaluate(opportunity, profile, now), profile, material });

  // PRIMERO, antes de la relevancia y antes de la descripción: es lo que se viene a copiar.
  assert.equal((blocks[0] as { heading_2?: { rich_text: { text: { content: string } }[] } }).heading_2?.rich_text[0]!.text.content, 'Carta de presentación');
  const order = (needle: string) => texts(blocks).indexOf(needle);
  assert.ok(order('Carta de presentación') < order('Por qué está aquí'), 'la carta antes del análisis');
  assert.ok(order('CV adaptado') < order('Descripción publicada'), 'el CV antes de la descripción publicada');

  // Y el contenido es el MISMO que el paquete local, no una segunda redacción: si se construyeran
  // los bloques aparte, el CV que Juan copia de Notion dejaría de ser el que el revisor verificó.
  const serialised = texts(blocks);
  for (const claim of ['Runs 30+ production n8n workflows.',
    'Built a typescript pipeline that cut processing from 90 to 2 minutes.']) {
    assert.ok(serialised.includes(claim), `el cuerpo cita literal: ${claim}`);
  }
  assert.ok(serialised.includes('Dear Hiring Team,'));
  assert.ok(serialised.includes('Juan Sebastian Silva Medina'));
  // Nunca se pasa del tope de Notion, y el material no es lo que se recorta.
  assert.ok(blocks.length <= MAX_CHILDREN);

  // Sin hechos no se inventa una carta: se dice que falta el archivo.
  const sinMaterial = texts(pageBody({ opportunity, evaluation: evaluate(opportunity, profile, now), profile }));
  assert.ok(sinMaterial.includes('candidate-facts'), 'nombra el archivo que falta');
  assert.ok(!sinMaterial.includes('Dear Hiring Team'), 'y no fabrica una carta');
});

test('markdownBlocks traduce lo que las plantillas emiten, y nada más', () => {
  const blocks = markdownBlocks('# Titulo\n\n## Seccion\n\n### Sub\n\n- viñeta\n\nparrafo **con enfasis**\n\n> cita\n');
  assert.deepEqual(blocks.map(b => b.type), ['heading_2', 'heading_3', 'bulleted_list_item', 'paragraph', 'quote']);
  // El `#` se omite: la página de Notion ya se llama como la oferta.
  assert.ok(!JSON.stringify(blocks).includes('Titulo'));
  // Los asteriscos se quitan en vez de viajar literales: el destino es un formulario web.
  assert.ok(JSON.stringify(blocks).includes('parrafo con enfasis'));
  assert.ok(!JSON.stringify(blocks).includes('**'));
  // Un párrafo más largo que el tope de Notion se trocea en vez de perderse.
  const largo = markdownBlocks('x'.repeat(4500));
  assert.equal(largo.length, 3);
  assert.equal(largo.map(b => (b as { paragraph: { rich_text: { text: { content: string } }[] } }).paragraph.rich_text[0]!.text.content).join('').length, 4500);
});

test('la checklist se DERIVA de lo que el registro no pudo confirmar', () => {
  // Una lista fija repite lo ya verificado y calla lo que falta.
  const sinNada = texts(body().filter(b => b.type === 'to_do'));
  for (const item of ['Confirmar la compensación', 'Confirmar autorización de trabajo', 'Confirmar que la vacante sigue abierta']) {
    assert.match(sinNada, new RegExp(item));
  }
  // La modalidad SÍ está declarada en este fixture, así que ese punto no aparece.
  assert.equal(sinNada.includes('Confirmar modalidad'), false);

  // Con todo publicado queda solo el que ninguna comprobación previa sustituye.
  const quote = 'We sponsor visas for this role.';
  const completa = body({ description: `Build typescript services. ${quote}`,
    payDisclosure: 'published', compensation: { currency: 'USD', period: 'month', min: 7000 },
    sponsorship: { status: 'stated', evidence: { kind: 'description_phrase', source: 'test', quote, observedAt: now.toISOString() } } });
  const pendientes = completa.filter(b => b.type === 'to_do');
  assert.equal(pendientes.length, 1);
  assert.match(texts(pendientes), /sigue abierta/);
});

test('la descripción se trocea, se acota y el recorte se DECLARA', () => {
  // Una oferta de 20.000 caracteres son diez párrafos. Cortar sin decirlo haría creer que la oferta
  // dice menos de lo que dice.
  const enorme = body({ description: 'x'.repeat(2000 * (DESCRIPTION_BLOCKS + 5)) });
  assert.ok(enorme.length <= MAX_CHILDREN, `${enorme.length} bloques excede el tope de Notion`);
  assert.match(texts(enorme), /\[Recortada: \d+ bloque\(s\) más/);
  // Ningún bloque supera los 2000 caracteres que Notion admite.
  for (const block of enorme) {
    for (const chunk of (block as { paragraph?: { rich_text: { text: { content: string } }[] } }).paragraph?.rich_text ?? []) {
      assert.ok(chunk.text.content.length <= 2000);
    }
  }
  // Sin descripción no se inventa una sección vacía.
  assert.equal(texts(body({ description: undefined })).includes('Descripción publicada'), false);
});

test('el cuerpo se escribe una vez y NUNCA se reescribe', async () => {
  const children = body();
  const calls: { method: string; url: string }[] = [];
  const vacia: HttpTransport = async request => {
    calls.push({ method: request.method, url: request.url });
    return request.method === 'GET' ? { status: 200, body: { object: 'list', results: [] } } : { status: 200, body: { object: 'list', results: children } };
  };
  assert.equal(await ensurePageBody('page-1', children, vacia), 'written');
  assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH']);

  // Una página con CUALQUIER hijo se deja intacta: no hay forma de distinguir el cuerpo que escribió
  // este módulo del que Juan amplió, y equivocarse ahí borra trabajo suyo.
  const conContenido: HttpTransport = async request => {
    if (request.method !== 'GET') assert.fail('no debe escribir en una página con contenido');
    return { status: 200, body: { object: 'list', results: [{ object: 'block', id: 'b1' }] } };
  };
  assert.equal(await ensurePageBody('page-1', children, conContenido), 'already_present');
  // Sin bloques que escribir no se hace ni la consulta.
  assert.equal(await ensurePageBody('page-1', [], async () => assert.fail('sin cuerpo no se consulta')), 'empty_body');
  // Y una respuesta que no se puede interpretar falla en vez de suponer que la página estaba vacía.
  await assert.rejects(ensurePageBody('page-1', children, async () => ({ status: 200, body: {} })), /notion_body_unreadable/);
  await assert.rejects(ensurePageBody('page-1', children, async () => ({ status: 404, body: null })), /notion_body_unreadable/);
});

test('el archivado recoge TODOS los ids antes de archivar ninguno', async () => {
  // Paginar mientras se archiva mueve el cursor bajo los pies: las filas archivadas salen del
  // conjunto, el `next_cursor` apunta a un sitio que ya no existe y quedan filas sin visitar.
  const root = await mkdtemp(join(tmpdir(), 'offers-archive-'));
  try {
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: true,
      config: { enabled: true, dataSourceId: '4c2fb0a6-6c69-4fe7-9bc0-21cf0825851a', externalKeyProperty: 'External Key', propertyMap: {} } }));
    const calls: { method: string; url: string; body: unknown }[] = [];
    const transport: HttpTransport = async request => {
      calls.push({ method: request.method, url: request.url, body: request.body });
      if (request.url.includes('/query')) {
        const first = !(request.body as { start_cursor?: string }).start_cursor;
        return { status: 200, body: first
          ? { results: [{ id: 'a' }, { id: 'b' }], has_more: true, next_cursor: 'c2' }
          : { results: [{ id: 'c' }], has_more: false, next_cursor: null } };
      }
      return { status: 200, body: {} };
    };
    // Sin `apply` cuenta y NO toca nada: una operación sobre miles de filas se mira antes.
    const seco = await archiveBoard({ root, dependencies: { transport }, sleep: async () => {} });
    assert.deepEqual(seco, { rows: 3, archived: 0, failed: 0, applied: false });
    assert.equal(calls.every(c => c.url.includes('/query')), true, 'un conteo no escribe');

    calls.length = 0;
    const aplicado = await archiveBoard({ root, apply: true, dependencies: { transport }, sleep: async () => {} });
    assert.deepEqual(aplicado, { rows: 3, archived: 3, failed: 0, applied: true });
    // Las dos consultas PRIMERO, los tres archivados DESPUÉS. Ese orden es la prueba.
    assert.deepEqual(calls.map(c => c.url.includes('/query') ? 'query' : 'archive'),
      ['query', 'query', 'archive', 'archive', 'archive']);
    // Y se ARCHIVA, no se borra: PATCH con `archived: true`, nunca DELETE.
    for (const call of calls.filter(c => !c.url.includes('/query'))) {
      assert.equal(call.method, 'PATCH');
      assert.deepEqual(call.body, { archived: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('el transporte admite leer y AÑADIR bloques, nunca borrarlos', async () => {
  // Sin DELETE a propósito: borrar bloques borraría lo que Juan escribió dentro de la página, y la
  // única forma de "reescribir" el cuerpo sería borrar primero. Al no existir el método, ese camino
  // no puede tomarse ni por error.
  const seen: string[] = [];
  const transport = createNotionTransport(async (url, init) => {
    seen.push(`${init?.method} ${new URL(String(url)).pathname}`);
    return new Response(JSON.stringify({ object: 'list', results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, { NOTION_API_KEY: 'test-only' });
  const pageId = '11111111-1111-1111-1111-111111111111';
  await transport(readChildrenRequest(pageId));
  await transport(appendChildrenRequest(pageId, [{ object: 'block' }]));
  assert.deepEqual(seen, [`GET /v1/blocks/${pageId}/children`, `PATCH /v1/blocks/${pageId}/children`]);
  // DELETE y POST sobre bloques se rechazan en el transporte, antes de tocar la red.
  for (const method of ['DELETE', 'POST'] as const) {
    await assert.rejects(transport({ method: method as 'POST', url: `https://api.notion.com/v1/blocks/${pageId}/children`, headers: {}, body: {} }), /notion_request_rejected/);
  }
  // Y un id que no parece un id tampoco entra.
  await assert.rejects(transport({ method: 'GET', url: 'https://api.notion.com/v1/blocks/../children', headers: {}, body: {} }), /notion_request_rejected/);
});

test('el cuerpo llega a una página existente aunque sus columnas no cambien', async () => {
  // Medido contra la base real: las 40 páginas más antiguas del tablero seguían VACÍAS después de
  // varias corridas. La llamada estaba dentro del `else`, así que solo alcanzaba a las páginas cuyas
  // propiedades se movían — y una fila estable sale `unchanged`, que es lo normal. Justo las que más
  // lo necesitan eran las que nunca lo recibían.
  const { records } = await import('./notion-fixtures.ts');
  const children = body();
  let created: Record<string, unknown> | undefined;
  const setup: HttpTransport = async request => {
    if (request.url.endsWith('/query')) return { status: 200, body: { object: 'list', has_more: false, results: [] } };
    created = (request.body as { properties: Record<string, unknown> }).properties;
    return { status: 200, body: { object: 'page', id: 'page-1' } };
  };
  const { upsertNotionRecords, validateNotionConfig } = await import('../src/notion-sync.ts');
  const config = validateNotionConfig({ enabled: true, dataSourceId: '12345678-1234-1234-1234-123456789012', externalKeyProperty: 'External key' });
  await upsertNotionRecords(records, config, setup, { now: () => now, body: () => children, limit: 1 });
  assert.ok(created);

  // La página ya existe con las MISMAS propiedades: sale `unchanged` y su cuerpo está vacío.
  const calls: string[] = [];
  const existing: HttpTransport = async request => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    if (request.url.endsWith('/query')) return { status: 200, body: { object: 'list', has_more: false, results: [{ object: 'page', id: 'page-1', properties: created }] } };
    if (request.url.includes('/blocks/') && request.method === 'GET') return { status: 200, body: { object: 'list', results: [] } };
    return { status: 200, body: { object: 'list', results: children } };
  };
  const result = await upsertNotionRecords(records.slice(0, 1), config, existing, { now: () => now, body: () => children });
  assert.equal(result.records[0]?.reason, 'unchanged', 'las columnas no cambiaron');
  assert.equal(result.bodies.written, 1, 'y aun así el cuerpo se escribió');
  assert.ok(calls.some(c => c.startsWith('PATCH /v1/blocks/')), 'se añadieron los bloques');
  assert.equal(calls.some(c => c.startsWith('PATCH /v1/pages/')), false, 'sin tocar las columnas');
});
