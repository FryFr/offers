import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseProfile } from './contracts.ts';
import { adaptExternalAlertEnvelope } from './external-alerts.ts';
import { atomicMailWrite, runMailAlerts, withMailLock, type Command } from './mail-runner.ts';
import { ingest, parseStore, report, type Store } from './pipeline.ts';
import { planNotionSync, validateNotionConfig } from './notion-sync.ts';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
export const target = { databaseId: 'a18a64dd-cda0-42e3-9b05-64446954e5c4', dataSourceId: '4c2fb0a6-6c69-4fe7-9bc0-21cf0825851a' };
/** Fixed repository paths; root/command injection is for isolated tests only. No sync transport is imported. */
export async function runAutomation(options: { account: string; mailbox?: string; executable?: string; root?: string; command?: Command; now?: Date }) {
  const root = options.root ?? repositoryRoot;
  const data = join(root, 'data');
  return withMailLock(join(data, 'automation'), async () => {
    const local = await readJson(join(data, 'notion-local.json')) as { databaseId?: unknown; dataSourceId?: unknown; schemaVerified?: unknown; config?: unknown };
    if (!local || local.databaseId !== target.databaseId || local.dataSourceId !== target.dataSourceId || typeof local.schemaVerified !== 'boolean') throw new Error('automation_config_invalid');
    const config = local.schemaVerified ? validateNotionConfig(local.config) : undefined;
    if (config && (config.dataSourceId !== target.dataSourceId || config.enabled)) throw new Error('automation_config_invalid');
    const profile = parseProfile(await readJson(join(root, 'examples/profile.json')));
    let result: { eligible: number; blocked: number; schemaVerified: boolean } | undefined;
    await runMailAlerts({ account: options.account, mailbox: options.mailbox, executable: options.executable, cursorPath: join(data, 'mail-cursor.json') }, async envelope => {
      await withMailLock(join(data, 'offers.json'), async () => {
        let store: Store = { version: 1, records: [] };
        try { store = parseStore(await readJson(join(data, 'offers.json'))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const next = ingest(store, adaptExternalAlertEnvelope(envelope));
        const snapshot = report(next, profile, options.now ?? new Date());
        const notionPlan = config ? planNotionSync(snapshot.notion.records, config, new Date(snapshot.generatedAt)) : {
          mode: 'dry-run', confirmed: false, records: [],
          blocked: snapshot.records.map(row => ({ externalKey: row.id, reason: 'schema_unverified', verification: row.evaluation.verification })),
        };
        await atomicMailWrite(join(data, 'offers.json'), next);
        await atomicMailWrite(join(data, 'automation-plan.json'), { ...snapshot, target, schemaVerified: !!config, notionPlan });
        result = { eligible: notionPlan.records.length, blocked: notionPlan.blocked.length, schemaVerified: !!config };
      });
    }, options.command);
    return result!;
  });
}
export async function automationMain(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('npm run automation -- --account NAME [--mailbox INBOX] [--himalaya /absolute/path]\nDry-run only; uses repository data/. Exit: 0 planned, 2 invalid arguments, 3 lock busy, 4 execution failure, 5 schema unverified.');
    return 0;
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!['--account', '--mailbox', '--himalaya'].includes(key) || !value || value.startsWith('--') || values.has(key)) return 2;
    values.set(key, value);
  }
  if (!values.get('--account')) return 2;
  try {
    const result = await runAutomation({ account: values.get('--account')!, mailbox: values.get('--mailbox'), executable: values.get('--himalaya') });
    console.log(JSON.stringify({ mode: 'dry-run', ...result }));
    return result.schemaVerified ? 0 : 5;
  } catch (error) {
    const busy = error instanceof Error && error.message.includes('existe .lock');
    console.error(busy ? 'automation_lock_busy' : 'automation_failed; inspect local configuration, cursor and mail access');
    return busy ? 3 : 4;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await automationMain(process.argv.slice(2));
