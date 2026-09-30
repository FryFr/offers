import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpportunity, parseProfile, type Opportunity } from '../src/contracts.ts';
import { evaluate } from '../src/evaluate.ts';
import { DESCRIPTION_BLOCKS, MAX_CHILDREN, appendChildrenRequest, pageBody, readChildrenRequest } from '../src/notion-body.ts';
import { ensurePageBody, type HttpTransport } from '../src/notion-sync.ts';
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
