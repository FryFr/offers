import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runLocalCycleDemo } from '../src/local-cycle-demo.ts';

test('local cycle demo reaches eligible > 0 deterministically, in-memory, with no network', async () => {
  const result = await runLocalCycleDemo();
  assert.equal(result.health[0]?.status, 'ok');
  assert.equal(result.counts.captured, 1);
  assert.ok(result.counts.eligible > 0, 'expected at least one eligible record');
  assert.equal(result.notionPlan.records.length, result.counts.eligible);
  assert.equal(result.notionPlan.blocked.length, 0);
  const [record] = result.jobs;
  assert.equal(record!.opportunity.title, 'Backend engineer');
  assert.equal(record!.opportunity.availability?.outcome, 'open');
  assert.ok(record!.opportunity.publishedAt);
});

test('CLI entrypoint prints JSON with eligible > 0 and exits 0', () => {
  const run = spawnSync(process.execPath, ['src/local-cycle-demo.ts'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.mode, 'local-demo');
  assert.equal(output.confirmed, false);
  assert.ok(output.counts.eligible > 0);
});
