import { validatePublicUrl } from './safe-http.ts';

/**
 * Boards ATS: el propio tablero de la empresa. Que una vacante esté ahí SÍ es autoridad sobre
 * su disponibilidad. Agregadores: espejos con retraso — su presencia no confirma nada.
 */
export const ATS_ADAPTERS = ['greenhouse', 'lever', 'ashby'] as const;
export const AGGREGATOR_ADAPTERS = ['remotive', 'himalayas', 'jobicy', 'remoteok', 'arbeitnow', 'landingjobs', 'freehire'] as const;
/** Una sola lista: el tipo se deriva de ella para que no puedan desincronizarse. */
export const ADAPTERS = [...ATS_ADAPTERS, ...AGGREGATOR_ADAPTERS, 'rss'] as const;
export type Adapter = typeof ADAPTERS[number];
/**
 * Cuánta autoridad tiene la presencia en el feed sobre la disponibilidad de la vacante.
 * `listing` = el tablero de la empresa la lista hoy. `ambiguous` = hay que comprobarlo aparte.
 */
export type AvailabilityTrust = 'listing' | 'ambiguous';
export interface Source {
  id: string; adapter: Adapter; enabled: boolean; endpoint: string;
  company?: string; board?: string; region?: 'global' | 'eu';
  secretEnv?: string; captureHtml: boolean; minIntervalMinutes: number; fetchContent: boolean;
  availabilityTrust: AvailabilityTrust;
}
const fields = ['id', 'adapter', 'enabled', 'endpoint', 'company', 'board', 'region', 'secretEnv', 'captureHtml', 'minIntervalMinutes', 'fetchContent', 'availabilityTrust'];
/** Endpoints fijos por adaptador de agregador: el registro posee la URL, no la configuración. */
const AGGREGATOR_ENDPOINTS: Record<string, string> = {
  remotive: 'https://remotive.com/api/remote-jobs',
  himalayas: 'https://himalayas.app/jobs/api?limit=100',
  jobicy: 'https://jobicy.com/api/v2/remote-jobs?count=50',
  remoteok: 'https://remoteok.com/api',
  arbeitnow: 'https://www.arbeitnow.com/api/job-board-api',
  landingjobs: 'https://landing.jobs/api/v1/jobs?limit=100',
  /**
   * Agrega ~92 plataformas ATS rastreando páginas de carrera de empresas, no raspando portales.
   *
   * La consulta está FIJADA aquí, como la de cualquier agregador, y acota a lo único que puede
   * llegar a un corte desde Colombia: remoto, en una región que la compuerta de geografía acepta,
   * y dentro de la ventana de publicación. Medido el 2026-09-30: sin el filtro de región son 21.192
   * resultados —casi todos "remote, US only", que el gate bloquea— y con él 1.943, que cabe en el
   * tope de 2.000 filas y 25 páginas. Deliberadamente SIN `q`: el filtrado por rol y habilidades es
   * trabajo de `relevance()`, que es determinista y no cuesta una petición.
   */
  freehire: 'https://freehire.me/api/v1/agent/jobs/search?work_mode=remote&regions=latam&regions=global&regions=americas&posted_within_days=7&limit=100',
};
/**
 * Cadencia mínima por adaptador. Remotive pide explícitamente un máximo de ~4 llamadas diarias
 * en sus términos; el resto se mantiene por encima de lo razonable para una API pública gratuita.
 */
const MIN_INTERVAL: Record<string, number> = { remotive: 360, himalayas: 120, jobicy: 180, remoteok: 180, arbeitnow: 120, landingjobs: 120, freehire: 120 };
const DEFAULT_INTERVAL: Record<string, number> = { remotive: 360, himalayas: 180, jobicy: 360, remoteok: 360, arbeitnow: 180, landingjobs: 180, freehire: 180 };
/** El techo protege el tiempo de ciclo y el tamaño del checkpoint, no la corrección. */
export const MAX_SOURCES = 400;
export function parseRegistry(value: unknown): Source[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('registry_invalid');
  const registry = value as Record<string, unknown>;
  if (registry.version !== 1 || !Array.isArray(registry.sources) || registry.sources.length > MAX_SOURCES || Object.keys(registry).some(k => !['version', 'sources'].includes(k))) throw new Error('registry_invalid');
  const ids = new Set<string>();
  return registry.sources.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('source_invalid');
    const s = raw as Record<string, unknown>;
    if (Object.keys(s).some(k => !fields.includes(k)) || typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(s.id) || ids.has(s.id)
      || !ADAPTERS.includes(s.adapter as Adapter) || typeof s.enabled !== 'boolean' || (s.captureHtml !== undefined && typeof s.captureHtml !== 'boolean')
      || (s.fetchContent !== undefined && typeof s.fetchContent !== 'boolean')
      || (s.availabilityTrust !== undefined && !['listing', 'ambiguous'].includes(String(s.availabilityTrust)))) throw new Error('source_invalid');
    ids.add(s.id);
    const adapter = s.adapter as Adapter;
    const interval = s.minIntervalMinutes ?? DEFAULT_INTERVAL[adapter] ?? 60;
    const fetchContent = s.fetchContent === undefined ? true : s.fetchContent === true;
    if (!Number.isSafeInteger(interval) || Number(interval) < (MIN_INTERVAL[adapter] ?? 15)) throw new Error('source_interval_invalid');
    if (s.company !== undefined && (typeof s.company !== 'string' || !s.company.trim() || s.company.length > 200)) throw new Error('source_company_invalid');
    if (s.region !== undefined && !['global', 'eu'].includes(String(s.region))) throw new Error('source_region_invalid');
    if (s.secretEnv !== undefined && (adapter !== 'rss' || typeof s.secretEnv !== 'string' || !/^OFFERS_SOURCE_[A-Z0-9_]+_TOKEN$/.test(s.secretEnv))) throw new Error('source_secret_reference_invalid');
    let endpoint: string;
    if (['greenhouse', 'lever', 'ashby'].includes(adapter)) {
      if (typeof s.board !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.board) || !s.company || s.endpoint !== undefined) throw new Error('source_board_invalid');
      // content=true inlines every posting's full HTML description and inflates the listing 7-22x.
      // Measured 2026-09-19 (bare vs content=true): stripe 416KB/5.1MB, anthropic 437KB/8.9MB,
      // databricks 752KB/9.6MB, gitlab 153KB/3.4MB — all four blew the 2MB safe-http cap and
      // returned zero offers, while bare they all fit. Eligibility needs publishedAt, publication
      // evidence and availability, never the description, so large boards can opt out and still
      // produce verified offers. Defaults to true so existing sources keep their descriptions.
      endpoint = adapter === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${s.board}/jobs${fetchContent ? '?content=true' : ''}`
        : adapter === 'lever' ? `https://api${s.region === 'eu' ? '.eu' : ''}.lever.co/v0/postings/${s.board}?mode=json&limit=100&skip=0`
        : `https://api.ashbyhq.com/posting-api/job-board/${s.board}`;
    } else if (AGGREGATOR_ADAPTERS.includes(adapter as typeof AGGREGATOR_ADAPTERS[number])) {
      // El registro fija el endpoint: una URL configurable convertiría un agregador conocido en
      // un destino arbitrario y dejaría sin sentido el mapeo específico de su adaptador.
      if (s.endpoint !== undefined || s.board !== undefined) throw new Error('source_endpoint_invalid');
      endpoint = AGGREGATOR_ENDPOINTS[adapter]!;
    } else {
      if (typeof s.endpoint !== 'string') throw new Error('source_endpoint_invalid');
      const url = validatePublicUrl(s.endpoint);
      if (url.protocol !== 'https:' || url.search || url.hash) throw new Error('source_endpoint_invalid');
      endpoint = url.toString();
    }
    // El default nace del adaptador, no de la configuración: olvidarlo en un agregador nuevo
    // haría pasar por autoritativo un espejo con retraso.
    const availabilityTrust = (s.availabilityTrust as AvailabilityTrust | undefined)
      ?? (ATS_ADAPTERS.includes(adapter as typeof ATS_ADAPTERS[number]) ? 'listing' : 'ambiguous');
    return { id: s.id, adapter, enabled: s.enabled, endpoint, captureHtml: s.captureHtml === true, fetchContent, minIntervalMinutes: Number(interval), availabilityTrust,
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
