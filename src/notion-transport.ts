import type { HttpTransport } from './notion-sync.ts';

/** No network or credential access until called. Never retries uncertain writes. */
export function createNotionTransport(fetcher: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): HttpTransport {
  return async request => {
    const token = env.NOTION_API_KEY;
    if (!token || token.trim() !== token || /[\r\n]/.test(token)) throw new Error('notion_credentials_missing_or_invalid');
    const url = new URL(request.url);
    if (url.origin !== 'https://api.notion.com' || url.username || url.password || url.search || url.hash
      || !/^\/v1\/(?:pages(?:\/[a-f\d-]+)?|(?:data_sources|databases)\/[a-f\d-]+\/query)$/i.test(url.pathname)
      || !['POST', 'PATCH'].includes(request.method)) throw new Error('notion_request_rejected');
    try {
      const response = await fetcher(url, {
        method: request.method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', 'Notion-Version': request.headers['Notion-Version'] ?? '2025-09-03', Authorization: `Bearer ${token}` },
        body: JSON.stringify(request.body),
      });
      // Do not propagate service error bodies (which may echo private inputs).
      return { status: response.status, body: response.ok ? await response.json() : null };
    } catch { throw new Error('notion_transport_error'); }
  };
}
export const transport = createNotionTransport();
