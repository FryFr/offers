import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type ResolveHost = (hostname: string) => Promise<string[]>;
export const resolvePublicHost: ResolveHost = async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(r => r.address);
/** Allow only globally routable unicast; reject mapped/transition/documentation ranges. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  // WHATWG expands equivalent IPv6 spellings consistently (including IPv4 mappings).
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const first = parseInt(normalized.split(':')[0]!, 16);
  const second = parseInt(normalized.split(':')[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3ffd && first !== 0x2002
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}
export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid_protocol');
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && !isPublicAddress(literal)) throw new Error('ssrf_blocked');
  if (url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('invalid_url');
  if (/(^|\.)(linkedin\.com|indeed\.com|glassdoor\.[a-z.]+)$/i.test(url.hostname)) throw new Error('source_disallowed');
  return url;
}
export async function assertSafeUrl(raw: string, resolver: ResolveHost = resolvePublicHost): Promise<{ url: URL; addresses: string[] }> {
  const url = validatePublicUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [hostname] : await resolver(hostname);
  if (!addresses.length || addresses.some(a => !isPublicAddress(a))) throw new Error('ssrf_blocked');
  return { url, addresses };
}
export interface SafeRequest { url: string; signal: AbortSignal; addresses: string[]; headers?: Record<string, string> }
export interface SafeResponse { status: number; headers: Record<string, string>; body: string }
export type SafeTransport = (request: SafeRequest) => Promise<SafeResponse>;
export const DEFAULT_TYPES = ['text/html', 'application/xhtml+xml', 'application/json', 'application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'];
/** DNS is pinned in the connection lookup; TLS still authenticates the original hostname. No proxy, cookies or automatic redirects. */
export function createPinnedTransport(maxBytes = 2_000_000, types = DEFAULT_TYPES): SafeTransport {
  return async ({ url: raw, signal, addresses, headers }) => {
    const url = validatePublicUrl(raw);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a))) throw new Error('ssrf_blocked');
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET', signal, agent: false, headers: { Accept: types.join(', '), 'Accept-Encoding': 'identity', 'User-Agent': 'Offers/1.0', ...headers },
        lookup: (_host, options, callback) => {
          const address = addresses[0]!;
          if (options.all) callback(null, addresses.map(address => ({ address, family: isIP(address) })));
          else callback(null, address, isIP(address));
        },
      }, response => {
        const status = response.statusCode ?? 0;
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
        const finish = (body: string) => resolve({ status, headers: responseHeaders, body });
        if (status !== 200) { response.destroy(); finish(''); return; }
        const type = (responseHeaders['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (!types.includes(type) || (responseHeaders['content-encoding'] && responseHeaders['content-encoding'] !== 'identity')) { response.destroy(); reject(new Error('unsupported_content_type')); return; }
        if (Number(responseHeaders['content-length']) > maxBytes) { response.destroy(); reject(new Error('response_too_large')); return; }
        const chunks: Buffer[] = []; let size = 0;
        // Cortar el flujo por tamaño dispara 'aborted', que reportaba `fetch_failed` y enmascaraba
        // la causa real: un diagnóstico equivocado manda a buscar problemas de red o de DNS donde
        // solo había un límite superado. El motivo propio gana sobre el aborto que él mismo causa.
        let cause: string | undefined;
        const fail = (code: string) => { cause ??= code; reject(new Error(cause)); };
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) { cause = 'response_too_large'; response.destroy(); fail('response_too_large'); }
          else chunks.push(chunk);
        });
        response.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        response.on('error', () => fail('fetch_failed'));
        response.on('aborted', () => fail('fetch_failed'));
      });
      request.on('error', () => reject(new Error('fetch_failed')));
      request.end();
    });
  };
}
export interface SafeReadOptions {
  transport?: SafeTransport; resolveHost?: ResolveHost; timeoutMs?: number; maxBytes?: number;
  maxRedirects?: number; contentTypes?: string[]; headers?: Record<string, string>;
}
export async function safeRead(raw: string, options: SafeReadOptions = {}): Promise<SafeResponse & { finalUrl: string }> {
  const timeoutMs = options.timeoutMs ?? 8000, maxBytes = options.maxBytes ?? 2_000_000, hops = options.maxRedirects ?? 5;
  if (![timeoutMs, maxBytes].every(v => Number.isSafeInteger(v) && v > 0) || !Number.isSafeInteger(hops) || hops < 0 || hops > 10) throw new Error('invalid_limits');
  const types = options.contentTypes ?? DEFAULT_TYPES;
  const transport = options.transport ?? createPinnedTransport(maxBytes, types);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('request_timeout')); }, timeoutMs); });
  const run = async () => {
    let current = raw;
    const initialOrigin = validatePublicUrl(raw).origin;
    for (let hop = 0; hop <= hops; hop++) {
      const { url, addresses } = await assertSafeUrl(current, options.resolveHost);
      controller.signal.throwIfAborted();
      if (options.headers && url.origin !== initialOrigin) throw new Error('credential_redirect_blocked');
      const response = await transport({ url: url.toString(), addresses, signal: controller.signal, headers: options.headers });
      controller.signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (hop === hops) throw new Error('too_many_redirects');
        const location = response.headers.location;
        if (!location) throw new Error('redirect_missing_location');
        const next = validatePublicUrl(new URL(location, url).toString());
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('redirect_downgrade');
        current = next.toString(); continue;
      }
      if (response.status === 200) {
        if (!types.includes((response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase())) throw new Error('unsupported_content_type');
        if (Buffer.byteLength(response.body) > maxBytes || Number(response.headers['content-length']) > maxBytes) throw new Error('response_too_large');
      }
      return { ...response, finalUrl: url.toString() };
    }
    throw new Error('too_many_redirects');
  };
  try { return await Promise.race([run(), timeout]); } finally { clearTimeout(timer!); }
}
