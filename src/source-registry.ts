import { validatePublicUrl } from './safe-http.ts';

export type Adapter = 'remotive' | 'rss' | 'greenhouse' | 'lever' | 'ashby';
export interface Source {
  id: string; adapter: Adapter; enabled: boolean; endpoint: string;
  company?: string; board?: string; region?: 'global' | 'eu';
  secretEnv?: string; captureHtml: boolean; minIntervalMinutes: number;
}
const adapters: Adapter[] = ['remotive', 'rss', 'greenhouse', 'lever', 'ashby'];
const fields = ['id', 'adapter', 'enabled', 'endpoint', 'company', 'board', 'region', 'secretEnv', 'captureHtml', 'minIntervalMinutes'];
export function parseRegistry(value: unknown): Source[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('registry_invalid');
  const registry = value as Record<string, unknown>;
  if (registry.version !== 1 || !Array.isArray(registry.sources) || registry.sources.length > 100 || Object.keys(registry).some(k => !['version', 'sources'].includes(k))) throw new Error('registry_invalid');
  const ids = new Set<string>();
  return registry.sources.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('source_invalid');
    const s = raw as Record<string, unknown>;
    if (Object.keys(s).some(k => !fields.includes(k)) || typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(s.id) || ids.has(s.id)
      || !adapters.includes(s.adapter as Adapter) || typeof s.enabled !== 'boolean' || (s.captureHtml !== undefined && typeof s.captureHtml !== 'boolean')) throw new Error('source_invalid');
    ids.add(s.id);
    const adapter = s.adapter as Adapter;
    const interval = s.minIntervalMinutes ?? (adapter === 'remotive' ? 360 : 60);
    if (!Number.isSafeInteger(interval) || Number(interval) < (adapter === 'remotive' ? 360 : 15)) throw new Error('source_interval_invalid');
    if (s.company !== undefined && (typeof s.company !== 'string' || !s.company.trim() || s.company.length > 200)) throw new Error('source_company_invalid');
    if (s.region !== undefined && !['global', 'eu'].includes(String(s.region))) throw new Error('source_region_invalid');
    if (s.secretEnv !== undefined && (adapter !== 'rss' || typeof s.secretEnv !== 'string' || !/^OFFERS_SOURCE_[A-Z0-9_]+_TOKEN$/.test(s.secretEnv))) throw new Error('source_secret_reference_invalid');
    let endpoint: string;
    if (['greenhouse', 'lever', 'ashby'].includes(adapter)) {
      if (typeof s.board !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.board) || !s.company || s.endpoint !== undefined) throw new Error('source_board_invalid');
      endpoint = adapter === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${s.board}/jobs?content=true`
        : adapter === 'lever' ? `https://api${s.region === 'eu' ? '.eu' : ''}.lever.co/v0/postings/${s.board}?mode=json&limit=100&skip=0`
        : `https://api.ashbyhq.com/posting-api/job-board/${s.board}`;
    } else if (adapter === 'remotive') {
      if (s.endpoint !== undefined || s.board !== undefined) throw new Error('source_endpoint_invalid');
      endpoint = 'https://remotive.com/api/remote-jobs';
    } else {
      if (typeof s.endpoint !== 'string') throw new Error('source_endpoint_invalid');
      const url = validatePublicUrl(s.endpoint);
      if (url.protocol !== 'https:' || url.search || url.hash) throw new Error('source_endpoint_invalid');
      endpoint = url.toString();
    }
    return { id: s.id, adapter, enabled: s.enabled, endpoint, captureHtml: s.captureHtml === true, minIntervalMinutes: Number(interval),
      ...(s.company ? { company: String(s.company).trim() } : {}), ...(s.board ? { board: String(s.board) } : {}),
      ...(s.region ? { region: s.region as 'global' | 'eu' } : {}), ...(s.secretEnv ? { secretEnv: String(s.secretEnv) } : {}) };
  });
}
export function sourceHeaders(source: Source, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!source.secretEnv) return undefined;
  const secret = env[source.secretEnv];
  if (!secret || secret.trim() !== secret || /[\r\n]/.test(secret)) throw new Error('source_secret_missing');
  return { Authorization: `Bearer ${secret}` };
}
