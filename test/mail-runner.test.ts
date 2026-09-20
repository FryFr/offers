import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { himalayaCommand, interpretHimalayaResult, runMailAlerts, type Command, type MailCursor } from '../src/mail-runner.ts';
import type { ExternalAlertEnvelope } from '../src/external-alerts.ts';

const ignoredMail = 'Subject: Hola\n\nMensaje normal sin trabajos.';
const options = (cursorPath: string, limit = 1) => ({ account: 'acc', mailbox: 'INBOX', limit, cursorPath });

test('newsletter no bloquea alertas reales; un fallo real mantiene el cursor sin avanzar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-mail-runner-'));
  try {
    const newsletter = await readFile(new URL('./fixtures/linkedin/newsletter.eml', import.meta.url), 'utf8');
    const job = await readFile(new URL('./fixtures/linkedin/real-reduced.eml', import.meta.url), 'utf8');
    for (const broken of [false, true]) {
      const cursorPath = join(dir, `cursor-${broken}.json`);
      const list = himalaya({ 1: JSON.stringify({ envelopes: [{ id: '123923' }, { id: 'job' }] }) });
      const command: Command = (executable, args) => args[0] === 'message'
        ? args.at(-1) === '123923' ? newsletter : broken ? 'From: jobs-noreply@linkedin.com\nSubject: Job alert\n\nUnsupported card' : job
        : list(executable, args);
      const delivered: ExternalAlertEnvelope[] = [];
      const run = runMailAlerts(options(cursorPath, 2), async envelope => { delivered.push(envelope); }, command);
      if (broken) {
        await assert.rejects(run, /Alerta LinkedIn no reconocida; cursor sin avanzar/);
        assert.deepEqual(delivered, []);
        assert.equal(existsSync(cursorPath), false);
      } else {
        await run;
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0]!.alerts.length, 3);
        const cursor = JSON.parse(await readFile(cursorPath, 'utf8')) as MailCursor;
        assert.deepEqual(cursor.processed, ['123923', 'job']);
        assert.equal(cursor.pending, undefined);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('lectura fallida 123750 es un fallo operativo: no entrega, no avanza y reintenta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-mail-runner-'));
  try {
    const cursorPath = join(dir, 'cursor.json');
    await runMailAlerts(options(cursorPath), async () => {}, himalaya({
      1: JSON.stringify({ envelopes: [{ id: 'processed' }] }),
    }));
    const original = await readFile(cursorPath, 'utf8');
    const job = await readFile(new URL('./fixtures/linkedin/real-reduced.eml', import.meta.url), 'utf8');
    const list = himalaya({ 1: JSON.stringify({ envelopes: [
      { id: 'processed' }, { id: 'job' }, { id: '123750' }, { id: 'later' },
    ] }) });
    const reads: string[] = [];
    const delivered: ExternalAlertEnvelope[] = [];
    const command: Command = (executable, args) => {
      if (args[0] !== 'message') return list(executable, args);
      const id = args.at(-1)!;
      reads.push(id);
      if (id === '123750') return interpretHimalayaResult({ status: 1, stdout: '' });
      return job;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        runMailAlerts(options(cursorPath, 3), async envelope => { delivered.push(envelope); }, command),
        /^Error: Himalaya: salió con código 1 \(comprueba cuenta y acceso al llavero; sin cambios al cursor\)$/,
      );
      assert.equal(await readFile(cursorPath, 'utf8'), original);
      assert.equal(existsSync(`${cursorPath}.lock`), false);
    }
    assert.deepEqual(reads, ['job', '123750', 'job', '123750']);
    assert.deepEqual(delivered, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Version check must pass; page payloads are indexed by page number (1-based).
function himalaya(pages: Record<number, string>): Command {
  return (_executable, args) => {
    if (args[0] === '--version') return 'himalaya v2.1.0\n';
    if (args[0] === 'envelope') {
      const page = Number(args[args.indexOf('--page') + 1]);
      const payload = pages[page];
      if (payload === undefined) throw new Error(`unexpected page ${page}`);
      return payload;
    }
    if (args[0] === 'message') return ignoredMail;
    throw new Error(`unexpected himalaya call: ${args.join(' ')}`);
  };
}

test('envelope list en formato real ({ envelopes: [...] }) se desenvuelve y procesa', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-mail-runner-'));
  try {
    const cursorPath = join(dir, 'cursor.json');
    const command = himalaya({ 1: JSON.stringify({ envelopes: [{ id: 'm1' }] }) });
    const delivered: ExternalAlertEnvelope[] = [];
    await runMailAlerts(options(cursorPath), async envelope => { delivered.push(envelope); }, command);
    assert.deepEqual(delivered, [{ schemaVersion: 1, alerts: [] }]);
    const cursor = JSON.parse(await readFile(cursorPath, 'utf8')) as MailCursor;
    assert.deepEqual(cursor.processed, ['m1']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('formato inválido (array plano, estilo Himalaya pre-2.1.0) se rechaza', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-mail-runner-'));
  try {
    const cursorPath = join(dir, 'cursor.json');
    const command = himalaya({ 1: JSON.stringify([{ id: 'm1' }]) });
    await assert.rejects(runMailAlerts(options(cursorPath), async () => {}, command), /Himalaya: lista de envelopes inválida/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('JSON corrupto en envelope list se rechaza sin avanzar el cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-mail-runner-'));
  try {
    const cursorPath = join(dir, 'cursor.json');
    const command = himalaya({ 1: '{not valid json' });
    await assert.rejects(runMailAlerts(options(cursorPath), async () => {}, command), /Himalaya: no se pudo listar el buzón como JSON/);
    assert.equal(existsSync(cursorPath), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('paginación agrega envelopes desenvueltos de varias páginas hasta el límite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-mail-runner-'));
  try {
    const cursorPath = join(dir, 'cursor.json');
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    const page2 = Array.from({ length: 5 }, (_, i) => ({ id: `m${100 + i}` }));
    const command = himalaya({ 1: JSON.stringify({ envelopes: page1 }), 2: JSON.stringify({ envelopes: page2 }) });
    const delivered: ExternalAlertEnvelope[] = [];
    await runMailAlerts(options(cursorPath, 105), async envelope => { delivered.push(envelope); }, command);
    assert.deepEqual(delivered, [{ schemaVersion: 1, alerts: [] }]);
    const cursor = JSON.parse(await readFile(cursorPath, 'utf8')) as MailCursor;
    assert.equal(cursor.processed.length, 105);
    assert.equal(cursor.processed.at(-1), 'm104');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('himalayaCommand: binario inexistente reporta error de ejecución sin exponer stderr', () => {
  assert.throws(
    () => himalayaCommand(join(tmpdir(), 'offers-nonexistent-binary-xyz'), ['--version']),
    /^Error: Himalaya: no se pudo ejecutar el binario \(comprueba instalación y PATH; sin cambios al cursor\)$/,
  );
});

test('himalayaCommand: proceso terminado por señal reporta señal sin exponer stderr', () => {
  assert.throws(
    () => himalayaCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']),
    /^Error: Himalaya: proceso interrumpido por señal SIGTERM \(posible timeout; sin cambios al cursor\)$/,
  );
});

test('himalayaCommand: código de salida distinto de cero reporta el código sin exponer stderr', () => {
  assert.throws(
    () => himalayaCommand(process.execPath, ['-e', 'console.error("secreto-credencial"); process.exit(3)']),
    /^Error: Himalaya: salió con código 3 \(comprueba cuenta y acceso al llavero; sin cambios al cursor\)$/,
  );
});

test('interpretHimalayaResult: ETIMEDOUT se reporta como tiempo de espera agotado, distinto de un fallo de ejecución genérico', () => {
  const result = { error: Object.assign(new Error('spawnSync himalaya ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM' as const, status: null, stdout: '' };
  assert.throws(
    () => interpretHimalayaResult(result),
    /^Error: Himalaya: tiempo de espera agotado \(30s\); sin cambios al cursor$/,
  );
});

test('interpretHimalayaResult: ENOBUFS (maxBuffer excedido) se reporta distinto de un fallo de ejecución genérico', () => {
  const result = { error: Object.assign(new Error('spawnSync himalaya ENOBUFS'), { code: 'ENOBUFS' }), signal: 'SIGTERM' as const, status: null, stdout: '' };
  assert.throws(
    () => interpretHimalayaResult(result),
    /^Error: Himalaya: salida excede el límite de buffer \(8MB\); sin cambios al cursor$/,
  );
});

test('interpretHimalayaResult: error sin código reconocido cae en el fallo de ejecución genérico', () => {
  const result = { error: Object.assign(new Error('spawnSync himalaya ENOENT'), { code: 'ENOENT' }), signal: null, status: null, stdout: '' };
  assert.throws(
    () => interpretHimalayaResult(result),
    /^Error: Himalaya: no se pudo ejecutar el binario \(comprueba instalación y PATH; sin cambios al cursor\)$/,
  );
});

test('himalayaCommand: stderr con secreto no aparece en la salida observable del proceso de tests', (t) => {
  const secret = `secreto-${randomUUID()}`;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  t.mock.method(process.stdout, 'write', (chunk: unknown) => { stdoutChunks.push(String(chunk)); return true; });
  t.mock.method(process.stderr, 'write', (chunk: unknown) => { stderrChunks.push(String(chunk)); return true; });
  let thrown: unknown;
  try {
    himalayaCommand(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(secret)}); process.exit(3)`]);
  } catch (error) { thrown = error; }
  assert.ok(thrown instanceof Error);
  assert.equal((thrown as Error).message, 'Himalaya: salió con código 3 (comprueba cuenta y acceso al llavero; sin cambios al cursor)');
  const observedInTestProcess = [...stdoutChunks, ...stderrChunks].join('');
  assert.ok(!observedInTestProcess.includes(secret), 'el secreto no debe aparecer en stdout/stderr observables del proceso de tests');
  const serializedError = `${String(thrown)}\n${(thrown as Error).stack ?? ''}`;
  assert.ok(!serializedError.includes(secret), 'el secreto no debe aparecer en la representación serializada del error');
});

test('timeout de Himalaya en envelope list se propaga con su propio mensaje, sin quedar oculto como JSON inválido', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-mail-runner-'));
  try {
    const cursorPath = join(dir, 'cursor.json');
    const command: Command = (_executable, args) => {
      if (args[0] === '--version') return 'himalaya v2.1.0\n';
      if (args[0] === 'envelope') throw new Error('Himalaya: tiempo de espera agotado (30s); sin cambios al cursor');
      throw new Error(`unexpected himalaya call: ${args.join(' ')}`);
    };
    await assert.rejects(
      runMailAlerts(options(cursorPath), async () => {}, command),
      /^Error: Himalaya: tiempo de espera agotado \(30s\); sin cambios al cursor$/,
    );
    assert.equal(existsSync(cursorPath), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('buzón vacío entrega envelope sin alertas y no escribe cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-mail-runner-'));
  try {
    const cursorPath = join(dir, 'cursor.json');
    const command = himalaya({ 1: JSON.stringify({ envelopes: [] }) });
    const delivered: ExternalAlertEnvelope[] = [];
    await runMailAlerts(options(cursorPath), async envelope => { delivered.push(envelope); }, command);
    assert.deepEqual(delivered, [{ schemaVersion: 1, alerts: [] }]);
    assert.equal(existsSync(cursorPath), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
