import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseProfile } from './contracts.ts';
import { parseStore, report } from './pipeline.ts';
import { atomicMailWrite, withMailLock } from './mail-runner.ts';
import { parseRegistry } from './source-registry.ts';
import { runSourceCycle, type CycleOptions, type SourceState } from './multi-source.ts';
import { createClaudeEnricher } from './claude-enrichment.ts';
import { upsertNotionRecords, validateNotionConfig, type HttpTransport } from './notion-sync.ts';
import { createNotionTransport } from './notion-transport.ts';
import type { Provenance } from './source-adapters.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
async function optionalJson(path: string): Promise<unknown | undefined> {
  try { return await json(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function parseSourceState(value: unknown): SourceState {
  const s = value as SourceState | null;
  if (!s || s.version !== 1 || !s.lastAttempt || typeof s.lastAttempt !== 'object' || Array.isArray(s.lastAttempt)) throw new Error('checkpoint_invalid');
  for (const [key, date] of Object.entries(s.lastAttempt)) if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || typeof date !== 'string'
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) throw new Error('checkpoint_invalid');
  if (s.lastResult !== undefined && (!s.lastResult || typeof s.lastResult !== 'object' || Array.isArray(s.lastResult) || Object.values(s.lastResult).some(v => !['ok', 'partial', 'failed'].includes(v)))) throw new Error('checkpoint_invalid');
  return { version: 1, lastAttempt: { ...s.lastAttempt }, lastResult: { ...s.lastResult } };
}
/** One atomic checkpoint includes store, provenance, cadence and dry-run plan; no production transport. */
export async function runSources(options: { root?: string; enrichModel?: string; now?: Date; dependencies?: Pick<CycleOptions, 'transport' | 'resolveHost' | 'htmlFetch' | 'env' | 'enrich'> } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  return withMailLock(join(data, 'automation'), () => withMailLock(join(data, 'source-cycle.json'), async () => {
    const sources = parseRegistry(await json(join(root, 'examples/sources.json')));
    const profile = parseProfile(await json(join(root, 'examples/profile.json')));
    const prior = await optionalJson(join(data, 'source-cycle.json')) as Record<string, unknown> | undefined;
    if (prior && (prior.version !== 1 || prior.mode !== 'dry-run' || prior.confirmed !== false)) throw new Error('checkpoint_invalid');
    const store = parseStore(prior?.store ?? await optionalJson(join(data, 'offers.json')) ?? { version: 1, records: [] });
    const state = prior ? parseSourceState(prior.state) : undefined;
    const local = await optionalJson(join(data, 'notion-local.json')) as { schemaVerified?: unknown; config?: unknown } | undefined;
    const enrich = options.dependencies?.enrich ?? (options.enrichModel ? createClaudeEnricher({ model: options.enrichModel }) : undefined);
    // Dry-run only plans; force enabled:false so an enabled data/notion-local.json config cannot trip runSourceCycle's write guard.
    const dryRunNotionConfig = local?.schemaVerified === true && local.config && typeof local.config === 'object'
      ? { ...local.config as Record<string, unknown>, enabled: false } : undefined;
    const result = await runSourceCycle({ ...options.dependencies, sources, profile, store, state, now: options.now,
      notionConfig: dryRunNotionConfig, enrich, mode: 'dry-run' });
    const provenance = { ...(prior?.provenance as Record<string, Provenance[]> | undefined) };
    for (const job of result.jobs) {
      const key = job.opportunity.url!;
      const old = provenance[key] ?? [];
      // Preserve first/last observations for each exact source payload without unbounded repeat entries.
      const merged = [...old, ...job.provenance];
      const groups = new Map<string, Provenance[]>();
      for (const p of merged) {
        const id = JSON.stringify([p.sourceId, p.externalId, p.payloadHash]);
        const entries = groups.get(id) ?? []; entries.push(p); groups.set(id, entries);
      }
      provenance[key] = [...groups.values()].flatMap(entries => entries.length > 1 ? [entries[0]!, entries.at(-1)!] : entries);
    }
    await atomicMailWrite(join(data, 'source-cycle.json'), { ...result, provenance });
    return result;
  }));
}
export async function sourceHealth(root = repositoryRoot, now = new Date()) {
  const checkpoint = await json(join(root, 'data/source-cycle.json')) as { generatedAt?: string; health?: { status?: string }[]; mode?: string; confirmed?: boolean; notionPlan?: { records?: unknown[] }; counts?: unknown };
  const age = now.getTime() - Date.parse(checkpoint.generatedAt ?? '');
  const healthy = Number.isFinite(age) && age >= 0 && age < 24 * 60 * 60_000 && checkpoint.mode === 'dry-run' && checkpoint.confirmed === false
    && Array.isArray(checkpoint.health) && checkpoint.health.some(s => ['ok', 'not_due'].includes(s.status ?? ''))
    && checkpoint.health.every(s => ['ok', 'not_due', 'disabled'].includes(s.status ?? ''));
  return { healthy, mode: 'dry-run', confirmed: false, generatedAt: checkpoint.generatedAt, counts: checkpoint.counts };
}
/** Reads the existing checkpoint store/profile and the existing writer only; never recollects sources or revalidates cadence. */
export async function runNotionSync(options: { root?: string; now?: Date; dependencies?: { transport?: HttpTransport; env?: NodeJS.ProcessEnv } } = {}) {
  const root = options.root ?? repositoryRoot, data = join(root, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  return withMailLock(join(data, 'automation'), () => withMailLock(join(data, 'source-cycle.json'), async () => {
    const local = await optionalJson(join(data, 'notion-local.json')) as { schemaVerified?: unknown; config?: unknown } | undefined;
    if (!local || local.schemaVerified !== true) throw new Error('notion_sync_disabled');
    const config = validateNotionConfig(local.config);
    if (!config.enabled) throw new Error('notion_sync_disabled');
    const now = options.now ?? new Date();
    const health = await sourceHealth(root, now);
    if (!health.healthy) throw new Error('checkpoint_unhealthy');
    const checkpoint = await json(join(data, 'source-cycle.json')) as { store?: unknown };
    const store = parseStore(checkpoint.store);
    const profile = parseProfile(await json(join(root, 'examples/profile.json')));
    const records = report(store, profile, now).notion.records;
    const transport = options.dependencies?.transport ?? createNotionTransport(fetch, options.dependencies?.env ?? process.env);
    const result = await upsertNotionRecords(records, config, transport, { now: () => now });
    const summary = { version: 1 as const, generatedAt: now.toISOString(),
      counts: { created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed, total: result.records.length } };
    await atomicMailWrite(join(data, 'notion-sync.json'), summary);
    return summary;
  }));
}
export async function sourcesMain(args: string[], root = repositoryRoot): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('npm run sources -- --dry-run [--enrich-model MODEL]\nnpm run sources -- --health\nnpm run sources -- --sync\n'
      + 'Fixed repository config. --sync requires data/notion-local.json with schemaVerified:true and an enabled config, plus a fresh healthy checkpoint from --dry-run; it reads the existing store/profile without recollecting sources and writes only through the existing Notion transport (NOTION_API_KEY). Result counts are saved to data/notion-sync.json.\n'
      + '--sync exits: 0 synced, 2 invalid arguments, 3 occupied lock, 4 sync failure, 5 sync disabled (unverified schema or disabled config), 6 stale/unhealthy checkpoint, 7 synced with failed records.');
    return 0;
  }
  if (args.length === 1 && args[0] === '--health') {
    try { const health = await sourceHealth(root); console.log(JSON.stringify(health)); return health.healthy ? 0 : 4; }
    catch { console.error('source_health_unavailable'); return 4; }
  }
  if (args.length === 1 && args[0] === '--sync') {
    try {
      const result = await runNotionSync({ root });
      console.log(JSON.stringify({ counts: result.counts }));
      return result.counts.failed > 0 ? 7 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('existe .lock')) { console.error('source_lock_busy'); return 3; }
      if (message === 'notion_sync_disabled') { console.error('notion_sync_disabled'); return 5; }
      if (message === 'checkpoint_unhealthy') { console.error('checkpoint_unhealthy'); return 6; }
      console.error('notion_sync_failed'); return 4;
    }
  }
  if (args[0] !== '--dry-run' || ![1, 3].includes(args.length) || (args.length === 3 && (args[1] !== '--enrich-model' || !args[2]))) return 2;
  try {
    const result = await runSources({ root, enrichModel: args[2] });
    console.log(JSON.stringify({ mode: result.mode, confirmed: false, counts: result.counts, health: result.health }));
    if (result.health.some(s => s.status === 'failed')) return 4;
    if (result.health.some(s => s.status === 'partial')) return 6;
    return result.notionPlan.blocked.some(b => 'reason' in b && b.reason === 'schema_unverified') ? 5 : 0;
  } catch (error) {
    const busy = error instanceof Error && error.message.includes('existe .lock');
    console.error(busy ? 'source_lock_busy' : 'source_cycle_failed'); return busy ? 3 : 4;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await sourcesMain(process.argv.slice(2));
