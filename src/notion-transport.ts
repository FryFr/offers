import type { HttpTransport } from './notion-sync.ts';

/** No network or credential access until called. Never retries uncertain writes. */
export function createNotionTransport(fetcher: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): HttpTransport {
  return async request => {
    const token = env.NOTION_API_KEY;
    if (!token || token.trim() !== token || /[\r\n]/.test(token)) throw new Error('notion_credentials_missing_or_invalid');
    const url = new URL(request.url);
    // Rutas permitidas, cada una con sus métodos. El esquema de una base se lee con GET sobre la
    // data source: el endpoint de query devuelve FILAS, no columnas, así que no sirve para
    // verificar el esquema por mucho que se le pida.
    const writePath = /^\/v1\/(?:pages(?:\/[a-f\d-]+)?|(?:data_sources|databases)\/[a-f\d-]+\/query)$/i.test(url.pathname);
    const readPath = /^\/v1\/(?:data_sources|databases)\/[a-f\d-]+$/i.test(url.pathname);
    /**
     * Los hijos de una página: leerlos y AÑADIR, nunca borrar.
     *
     * Sin DELETE a propósito. Borrar bloques borraría lo que Juan escribió a mano dentro de la
     * página, y la única forma de "reescribir" el cuerpo sería borrar primero. Al no existir el
     * método, ese camino no puede tomarse ni por error: el cuerpo se escribe una vez, cuando la
     * página está vacía, y después es suyo.
     */
    const blockPath = /^\/v1\/blocks\/[a-f\d-]+\/children$/i.test(url.pathname);
    /**
     * Subida de archivos: crear la subida y enviar los bytes. Nada más.
     *
     * Existe porque el CV y la carta tienen que viajar a Notion como PDF —a una postulación se sube
     * un archivo, no se pega texto— y Notion exige dos pasos: `POST /v1/file_uploads` devuelve un id
     * y `POST /v1/file_uploads/{id}/send` recibe los bytes en `multipart/form-data`.
     *
     * Ese segundo paso es el ÚNICO sitio del transporte donde el cuerpo no es JSON, y por eso se
     * reconoce por su propia ruta en vez de aflojar la regla para todos: un `Content-Type` que
     * depende del contenido sería una puerta abierta en cada petición.
     *
     * Sigue sin haber DELETE: un bloque adjuntado no se puede quitar desde aquí, igual que el resto
     * del cuerpo.
     */
    const uploadCreate = /^\/v1\/file_uploads$/i.test(url.pathname);
    const uploadSend = /^\/v1\/file_uploads\/[a-f\d-]+\/send$/i.test(url.pathname);
    // La ruta de la data source admite leer el esquema (GET) y añadirle columnas (PATCH).
    const allowed = writePath ? ['POST', 'PATCH'] : readPath ? ['GET', 'PATCH'] : blockPath ? ['GET', 'PATCH']
      : uploadCreate || uploadSend ? ['POST'] : [];
    if (url.origin !== 'https://api.notion.com' || url.username || url.password || url.search || url.hash
      || !allowed.includes(request.method)) throw new Error('notion_request_rejected');
    try {
      /**
       * El envío de bytes manda un `FormData`, y el `Content-Type` lo pone `fetch` con su `boundary`.
       * Fijarlo a mano rompería la petición, así que en ESA ruta se omite la cabecera.
       *
       * El tiempo también cambia: 15 s bastan para JSON y se quedan cortos subiendo un PDF.
       */
      const multipart = uploadSend && request.form instanceof FormData;
      const response = await fetcher(url, {
        method: request.method, redirect: 'error', signal: AbortSignal.timeout(multipart ? 60_000 : 15_000),
        headers: { ...(multipart ? {} : { 'Content-Type': 'application/json' }),
          'Notion-Version': request.headers['Notion-Version'] ?? '2025-09-03', Authorization: `Bearer ${token}` },
        // Una lectura no lleva cuerpo; enviarlo haría que Notion rechace la petición.
        ...(request.method === 'GET' ? {} : { body: multipart ? request.form : JSON.stringify(request.body) }),
      });
      // Do not propagate service error bodies (which may echo private inputs).
      return { status: response.status, body: response.ok ? await response.json() : null };
    } catch { throw new Error('notion_transport_error'); }
  };
}
export const transport = createNotionTransport();
