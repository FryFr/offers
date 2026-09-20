import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applicationIdentity, emptyTrackingStore, importTracking, loadTrackingStore, parseTrackingStore, saveTrackingStore, trackingReport } from '../src/tracking.ts';

const t = (day: number, hour = 12) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const app = (opportunityId: string, attemptId: string, eventId = `app-${attemptId}`, day = 1) => ({ schemaVersion: 1, eventId, type: 'application', applicationId: applicationIdentity(opportunityId, attemptId), opportunityId, attemptId, occurredAt: t(day), recordedAt: t(day) });
const event = (eventId: string, type: 'response' | 'interview' | 'offer', applicationId: string, detail: object, day = 2, recordedDay = day) => ({ schemaVersion: 1, eventId, type, applicationId, occurredAt: t(day), recordedAt: t(recordedDay), ...detail });
const envelope = (...events: unknown[]) => ({ schemaVersion: 1, events });

test('identidad separa reintentos reales y reimportar es idempotente', () => {
  const first = app('job-1', 'first');
  const retry = app('job-1', 'retry');
  assert.notEqual(first.applicationId, retry.applicationId);
  const store = importTracking(emptyTrackingStore(), envelope(first, retry));
  assert.equal(store.events.length, 2);
  assert.strictEqual(importTracking(store, envelope(first, retry)), store);
  assert.throws(() => importTracking(store, envelope({ ...first, occurredAt: t(2) })), /reutilizado/);
});

test('validación cerrada y transaccional exige referencias y UTC válidos', () => {
  const original = importTracking(emptyTrackingStore(), envelope(app('job', 'one')));
  for (const invalid of [
    envelope(event('orphan', 'response', 'missing', { outcome: 'positive' })),
    envelope({ ...app('job', 'two'), extra: true }),
    envelope({ ...app('job', 'two'), occurredAt: '2026-09-01T07:00:00-05:00' }),
    envelope(app('job', 'two'), {}),
  ]) assert.throws(() => importTracking(original, invalid));
  assert.equal(original.events.length, 1);
});

test('dos postulaciones, respuestas múltiples y entrevistas canceladas/reprogramadas no duplican conversiones', () => {
  const a = app('same-vacancy', 'first'); const b = app('same-vacancy', 'second');
  const store = importTracking(emptyTrackingStore(), envelope(a, b,
    event('r1', 'response', a.applicationId, { outcome: 'positive' }),
    event('r2', 'response', a.applicationId, { outcome: 'negative' }, 3),
    event('i1', 'interview', a.applicationId, { status: 'cancelled' }),
    event('i2', 'interview', b.applicationId, { status: 'rescheduled' }),
  ));
  assert.deepEqual(trackingReport(store, new Date(t(9))).counts, { applications: 2, responses: 1, interviews: 0, offers: 0, acceptedOffers: 0 });
});

test('fixture de cuatro postulaciones produce 50%, 25%, 25% y 100%; cohorte vacía usa null', () => {
  const applications = [1, 2, 3, 4].map(n => app(`job-${n}`, 'first', `a${n}`));
  const store = importTracking(emptyTrackingStore(), envelope(...applications,
    event('r1', 'response', applications[0]!.applicationId, { outcome: 'positive' }),
    event('r2', 'response', applications[1]!.applicationId, { outcome: 'negative' }),
    event('i1', 'interview', applications[0]!.applicationId, { status: 'completed' }),
    event('o1', 'offer', applications[0]!.applicationId, { status: 'received' }),
    event('o2', 'offer', applications[0]!.applicationId, { status: 'accepted' }, 3),
  ));
  assert.deepEqual(trackingReport(store, new Date(t(9))).rates, { response: .5, interview: .25, offer: .25, offerAcceptance: 1 });
  assert.deepEqual(trackingReport(emptyTrackingStore(), new Date(t(9))).rates, { response: null, interview: null, offer: null, offerAcceptance: null });
});

test('corte UTC excluye eventos tardíos y correcciones conservan originales reconstruibles', () => {
  const a = app('expired-or-discarded-job', 'first');
  const response = event('late', 'response', a.applicationId, { outcome: 'positive' }, 2, 4);
  const original = event('interview-original', 'interview', a.applicationId, { status: 'completed' }, 2, 2);
  const correction = { ...event('interview-correction', 'interview', a.applicationId, { status: 'cancelled' }, 2, 3), correctsEventId: original.eventId };
  const store = importTracking(emptyTrackingStore(), envelope(a, response, original, correction));
  assert.equal(trackingReport(store, new Date(t(2, 23))).counts.responses, 0);
  assert.equal(trackingReport(store, new Date(t(2, 23))).counts.interviews, 1);
  assert.equal(trackingReport(store, new Date(t(3, 23))).counts.interviews, 0);
  assert.equal(trackingReport(store, new Date(t(4, 23))).counts.responses, 1);
  assert.equal(store.events.length, 4);
});

test('checksum detecta corrupción; escritura es atómica y concurrencia no pierde revisiones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-tracking-store-')); const path = join(dir, 'tracking.json');
  try {
    const first = importTracking(emptyTrackingStore(), envelope(app('job', 'one')));
    await saveTrackingStore(path, first, 0);
    assert.deepEqual(await loadTrackingStore(path), first);
    const corrupt = JSON.parse(await readFile(path, 'utf8')); corrupt.events[0].attemptId = 'tampered';
    await writeFile(path, JSON.stringify(corrupt));
    await assert.rejects(loadTrackingStore(path), /checksum/);
    await writeFile(path, `${JSON.stringify(first)}\n`);
    const secondA = importTracking(first, envelope(app('job', 'two')));
    const secondB = importTracking(first, envelope(app('job', 'three')));
    const results = await Promise.allSettled([saveTrackingStore(path, secondA, 1), saveTrackingStore(path, secondB, 1)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await loadTrackingStore(path)).revision, 2);
    const blockedParent = join(dir, 'blocked-parent'); await writeFile(blockedParent, 'not a directory');
    await assert.rejects(saveTrackingStore(join(blockedParent, 'tracking.json'), secondA, 0));
    assert.deepEqual(parseTrackingStore(await loadTrackingStore(path)), await loadTrackingStore(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI opt-in importa/reporta determinísticamente y el flujo legacy no crea tracking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offers-tracking-cli-'));
  try {
    const state = join(dir, 'tracking.json'); const input = join(dir, 'events.json'); const cutoff = t(9);
    await writeFile(input, JSON.stringify(envelope(app('job', 'first'))));
    const args = ['src/cli.ts', '--tracking-state', state, '--tracking-import', input, '--tracking-cutoff', cutoff];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr); assert.equal(first.stdout, second.stdout);
    const before = await readFile(state, 'utf8');
    const reportOnly = spawnSync(process.execPath, ['src/cli.ts', '--tracking-state', state, '--tracking-report', '--tracking-cutoff', cutoff], { encoding: 'utf8', env: { ...process.env, NOTION_TOKEN: 'must-not-be-used' } });
    assert.equal(reportOnly.status, 0, reportOnly.stderr); assert.equal(reportOnly.stdout, first.stdout); assert.equal(await readFile(state, 'utf8'), before);
    const legacyState = join(dir, 'offers.json'); const absent = join(dir, 'absent.json');
    const legacy = spawnSync(process.execPath, ['src/cli.ts', '--input', '-', '--state', legacyState, '--now', cutoff], { input: JSON.stringify({ title: 'x', company: 'y' }), encoding: 'utf8' });
    assert.equal(legacy.status, 0, legacy.stderr);
    await assert.rejects(readFile(absent), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
