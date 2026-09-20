import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseProfile } from './contracts.ts';
import { parseRegistry } from './source-registry.ts';
import { runSourceCycle } from './multi-source.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Deterministic, network-free run of the real source-cycle pipeline (registry -> adapter ->
 * verification gate -> Notion eligibility), using the existing Ashby fixture as an in-memory
 * transport. Reads no data/ state and writes nothing; not a substitute for `npm run sources --
 * dry-run` against live sources, only a reproducible local proof that the pipeline reaches
 * eligible > 0 for evidence that legitimately satisfies the verification gate. LinkedIn is
 * intentionally out of scope: its domain stays blocked by safe-http's source_disallowed check.
 */
export async function runLocalCycleDemo(root: string = repositoryRoot) {
  const profile = parseProfile(JSON.parse(await readFile(join(root, 'examples/profile.json'), 'utf8')));
  const sources = parseRegistry({ version: 1, sources: [{ id: 'ashby-demo', adapter: 'ashby', enabled: true, board: 'acme', company: 'Acme' }] });
  const fixture = await readFile(join(root, 'test/fixtures/sources/ashby.json'), 'utf8');
  const now = new Date('2026-09-19T12:00:00Z');
  const notionConfig = { enabled: false, dataSourceId: '12345678-1234-1234-1234-123456789012', externalKeyProperty: 'External key' };
  return runSourceCycle({
    sources, profile, now, notionConfig,
    resolveHost: async () => ['93.184.216.34'],
    transport: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: fixture }),
  });
}

export async function localCycleDemoMain(): Promise<number> {
  const result = await runLocalCycleDemo();
  console.log(JSON.stringify({ mode: 'local-demo', confirmed: false, counts: result.counts, health: result.health }, null, 2));
  return result.counts.eligible > 0 ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await localCycleDemoMain();
