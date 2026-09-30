import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_STATES, boardEvents, parseBoardRow, queryBoardRequest, readBoard, type BoardRow } from '../src/notion-board.ts';
import { validateNotionConfig, type HttpTransport } from '../src/notion-sync.ts';
import { applicationIdentity, parseTrackingStore, emptyTrackingStore, importTracking, trackingReport } from '../src/tracking.ts';
import { pullBoardStatus, applicationFunnel, sourcesMain } from '../src/source-cli.ts';

const now = new Date('2026-09-30T12:00:00Z');
const rawConfig = { enabled: true, dataSourceId: '12345678-1234-1234-1234-123456789012', externalKeyProperty: 'External Key' };
const config = validateNotionConfig(rawConfig);
const key = 'a'.repeat(64);
const page = (estado: string, overrides: Record<string, unknown> = {}) => ({
  object: 'page', id: 'p1', last_edited_time: '2026-09-28T09:00:00Z',
  properties: {
    'External Key': { rich_text: [{ text: { content: key } }] },
    Estado: { select: { name: estado } },
    'Applied at': { date: { start: '2026-09-20' } },
    ...overrides,
  },
});

test('la consulta filtra por Estado no vacío y pagina por el cuerpo, no por la query string', () => {
  // El transporte PROHÍBE `url.search`, así que el cursor tiene que ir en el body o la petición se
  // rechaza antes de salir. Y pedir las 16.861 filas para descartar 16.846 sería absurdo.
  const request = queryBoardRequest(rawConfig);
  assert.equal(new URL(request.url).search, '');
  assert.deepEqual(request.body.filter, { property: 'Estado', select: { is_not_empty: true } });
  assert.equal('start_cursor' in request.body, false);
  const paged = queryBoardRequest(rawConfig, 'cursor-2');
  assert.equal(paged.body.start_cursor, 'cursor-2');
  assert.equal(new URL(paged.url).search, '', 'el cursor NO viaja en la query string');
});

test('una fila sin clave válida o sin Estado se salta con su motivo, nunca se adivina', () => {
  assert.deepEqual(parseBoardRow(page('Postulada'), config), { externalKey: key, estado: 'Postulada', appliedAt: '2026-09-20', lastEditedAt: '2026-09-28T09:00:00Z' });
  // Una clave que no es SHA-256 no puede corresponder a un registro: no se adivina a cuál.
  assert.deepEqual(parseBoardRow(page('Postulada', { 'External Key': { rich_text: [{ text: { content: 'no-es-sha' } }] } }), config),
    { externalKey: 'no-es-sha', reason: 'external_key_invalid' });
  assert.equal('reason' in parseBoardRow(page('Postulada', { Estado: { select: null } }), config), true);
  assert.equal('reason' in parseBoardRow({ ...page('Postulada'), last_edited_time: undefined }, config), true);
  // Sin `Applied at` la fila se lee, pero no produce eventos (ver la prueba siguiente).
  const sinFecha = parseBoardRow(page('Postulada', { 'Applied at': { date: null } }), config) as BoardRow;
  assert.equal(sinFecha.appliedAt, undefined);
});

test('la escalera produce TODOS los eventos previos, porque Estado es un select de un valor', () => {
  // `validateGraph` exige que exista el `application` antes de cualquier otro evento, y un select no
  // puede expresar "respondió y además entrevistó".
  const row = (estado: string): BoardRow => ({ externalKey: key, estado, appliedAt: '2026-09-20', lastEditedAt: '2026-09-28T09:00:00Z' });
  assert.deepEqual(boardEvents([row('Nueva')], now).events, [], 'un estado previo a postular no produce nada');
  assert.deepEqual(boardEvents([row('Por postular')], now).events, []);
  assert.deepEqual(boardEvents([row('Descartada')], now).events, []);
  assert.deepEqual(boardEvents([row('Postulada')], now).events.map(e => e.type), ['application']);
  assert.deepEqual(boardEvents([row('Rechazada')], now).events.map(e => `${e.type}:${'outcome' in e ? e.outcome : ''}`), ['application:', 'response:negative']);
  assert.deepEqual(boardEvents([row('Entrevista hecha')], now).events.map(e => e.type), ['application', 'response', 'interview', 'interview']);
  assert.deepEqual(boardEvents([row('Aceptada')], now).events.map(e => e.type), ['application', 'response', 'interview', 'interview', 'offer', 'offer']);
  // Y el grafo resultante es VÁLIDO: se importa sin lanzar.
  for (const estado of BOARD_STATES) {
    const { events } = boardEvents([row(estado)], now);
    assert.doesNotThrow(() => importTracking(emptyTrackingStore(), { schemaVersion: 1, events }), `${estado} produce un grafo inválido`);
  }
});

test('nunca se adivina una fecha de postulación, y un Estado desconocido se reporta', () => {
  // `attemptId` se deriva de `Applied at`: inventarla inventaría la identidad de la postulación.
  const sinFecha: BoardRow = { externalKey: key, estado: 'Postulada', lastEditedAt: '2026-09-28T09:00:00Z' };
  const resultado = boardEvents([sinFecha], now);
  assert.deepEqual(resultado.events, []);
  assert.deepEqual(resultado.skipped, [{ externalKey: key, reason: 'applied_at_missing' }]);
  // Un select nuevo NO se traduce en silencio: adivinar su escalón inventaría el dato del embudo.
  const nuevo = boardEvents([{ externalKey: key, estado: 'En negociación', appliedAt: '2026-09-20', lastEditedAt: '2026-09-28T09:00:00Z' }], now);
  assert.deepEqual(nuevo.unknownStates, ['En negociación']);
  assert.deepEqual(nuevo.events, []);
});

test('el eventId lleva el occurredAt dentro: reimportar es idempotente y editar es una observación nueva', () => {
  // ESTE es el detalle que rompe todo si se hace mal. `importTracking` LANZA si el mismo `eventId`
  // llega con contenido distinto, así que con `recordedAt` en el hash el segundo --pull-status fallaría.
  const row: BoardRow = { externalKey: key, estado: 'Entrevista', appliedAt: '2026-09-20', lastEditedAt: '2026-09-28T09:00:00Z' };
  const primero = boardEvents([row], now);
  const segundo = boardEvents([row], new Date('2026-10-05T12:00:00Z'));
  assert.deepEqual(primero.events.map(e => e.eventId), segundo.events.map(e => e.eventId), 'el mismo tablero da los mismos ids');
  const store = importTracking(emptyTrackingStore(), { schemaVersion: 1, events: primero.events });
  // Reimportar con otro `recordedAt` NO lanza y NO añade nada.
  assert.equal(importTracking(store, { schemaVersion: 1, events: segundo.events }), store, 'idempotente: misma referencia');

  // Una edición posterior en Notion cambia `last_edited_time` -> observación NUEVA, no conflicto.
  const editada = boardEvents([{ ...row, estado: 'Entrevista hecha', lastEditedAt: '2026-10-01T09:00:00Z' }], now);
  const ampliado = importTracking(store, { schemaVersion: 1, events: editada.events });
  assert.ok(ampliado.events.length > store.events.length);
  // Y las tasas no se inflan: `trackingReport` cuenta por applicationId con Set.
  const report = trackingReport(ampliado, new Date('2026-10-10T00:00:00Z'));
  assert.equal(report.counts.applications, 1, 'una postulación, aunque haya varias observaciones');
});

test('--pull-status lee, importa una vez y la segunda no cambia nada', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offers-board-'));
  try {
    await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'data/notion-local.json'), JSON.stringify({ schemaVerified: true, config: rawConfig }));
    const transport: HttpTransport = async () => ({ status: 200, body: { object: 'list', has_more: false, results: [page('Entrevista')] } });

    const dry = await pullBoardStatus({ root, now, dryRun: true, dependencies: { transport } });
    assert.equal(dry.rows, 1);
    assert.equal(dry.events, 3, 'application + response + interview');
    assert.equal(dry.imported, 0, '--dry-run no importa');
    await assert.rejects(readFile(join(root, 'data/tracking.json'), 'utf8'), /ENOENT/, '--dry-run no escribe');

    const first = await pullBoardStatus({ root, now, dependencies: { transport } });
    assert.equal(first.imported, 3);
    const second = await pullBoardStatus({ root, now, dependencies: { transport } });
    assert.equal(second.imported, 0, 'LA idempotencia: la segunda pasada importa cero');
    assert.equal(second.revision, first.revision, 'y no gasta una revisión');
    assert.equal(parseTrackingStore(JSON.parse(await readFile(join(root, 'data/tracking.json'), 'utf8'))).events.length, 3);

    // El embudo se calcula del almacén, sin tocar la red.
    const funnel = await applicationFunnel({ root, cutoff: new Date('2026-10-10T00:00:00Z') });
    assert.equal(funnel.counts.applications, 1);
    assert.equal(funnel.counts.responses, 1);
    // `trackingReport` cuenta solo entrevistas COMPLETADAS, así que `Entrevista` —agendada— todavía
    // no cuenta. Es lo correcto: una entrevista agendada puede cancelarse.
    assert.equal(funnel.counts.interviews, 0, 'Entrevista es agendada, no hecha');
    assert.equal(funnel.rates.offerAcceptance, null, 'sin oferta, la tasa es null y no 0');

    // Y con `Entrevista hecha` sí cuenta, sin duplicar la postulación.
    const hecha: HttpTransport = async () => ({ status: 200, body: { object: 'list', has_more: false,
      results: [{ ...page('Entrevista hecha'), last_edited_time: '2026-10-02T09:00:00Z' }] } });
    await pullBoardStatus({ root, now, dependencies: { transport: hecha } });
    const conEntrevista = await applicationFunnel({ root, cutoff: new Date('2026-10-10T00:00:00Z') });
    assert.equal(conEntrevista.counts.interviews, 1);
    assert.equal(conEntrevista.counts.applications, 1, 'una postulación, aunque el estado avanzara');

    // Un Estado desconocido sale con su propio código y NOMBRA el valor.
    const raro: HttpTransport = async () => ({ status: 200, body: { object: 'list', has_more: false, results: [page('En negociación')] } });
    await assert.rejects(pullBoardStatus({ root, now, dependencies: { transport: raro } }), /board_state_unknown/);
    assert.equal(await sourcesMain(['--pull-status', '--force'], root), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
