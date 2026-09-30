/**
 * Lee el `Estado` del tablero y lo convierte en eventos de seguimiento.
 *
 * `tracking.ts` se reutiliza TAL CUAL, sin tocar una línea: ya tiene identidad de postulación,
 * validación del grafo, concurrencia optimista y el informe del embudo. Lo único que faltaba era la
 * fuente de los eventos, y la fuente es la única columna que Juan edita a mano.
 *
 * El diseño está dominado por un detalle que lo rompe todo si se hace mal. `importTracking` LANZA si
 * el mismo `eventId` llega con contenido distinto, así que si `recordedAt` fuera "ahora", el segundo
 * `--pull-status` fallaría en vez de ser idempotente. Por eso `occurredAt` va DENTRO del hash del
 * `eventId`: una edición posterior en Notion produce un evento nuevo —una observación nueva—, no un
 * conflicto. `trackingReport` cuenta por `applicationId` con `Set`, así que observaciones repetidas
 * no inflan las tasas.
 */
import { createHash } from 'node:crypto';
import type { HttpRequest, HttpTransport, NotionConfig } from './notion-sync.ts';
import { validateNotionConfig } from './notion-sync.ts';
import type { TrackingEvent } from './tracking.ts';
import { applicationIdentity } from './tracking.ts';

/**
 * La escalera de estados. Cada uno implica TODOS los eventos de los anteriores, porque
 * `validateGraph` exige que exista el `application` antes de cualquier otro evento y `Estado` es un
 * select de un solo valor: no puede expresar "respondió y además entrevistó".
 */
const LADDER: Record<string, readonly string[]> = {
  'Nueva': [],
  'Por postular': [],
  'Descartada': [],
  'Postulada': ['application'],
  'Sin respuesta': ['application'],
  'Rechazada': ['application', 'response:negative'],
  'Entrevista': ['application', 'response:positive', 'interview:scheduled'],
  'Entrevista hecha': ['application', 'response:positive', 'interview:scheduled', 'interview:completed'],
  'Oferta': ['application', 'response:positive', 'interview:scheduled', 'interview:completed', 'offer:received'],
  'Aceptada': ['application', 'response:positive', 'interview:scheduled', 'interview:completed', 'offer:received', 'offer:accepted'],
  'Declinada': ['application', 'response:positive', 'interview:scheduled', 'interview:completed', 'offer:received', 'offer:declined'],
};
export const BOARD_STATES = Object.keys(LADDER);

export interface BoardRow {
  externalKey: string;
  estado: string;
  appliedAt?: string;
  lastEditedAt: string;
}
export interface SkippedRow { externalKey: string; reason: string }

/**
 * Filtra por `Estado` no vacío: una fila que Juan no ha tocado no tiene nada que contar, y pedir las
 * 16.861 para descartar 16.846 sería absurdo.
 */
export function queryBoardRequest(value: unknown, cursor?: string): HttpRequest {
  const config = validateNotionConfig(value);
  const target = `${config.dataSourceId ? 'data_sources' : 'databases'}/${config.dataSourceId ?? config.databaseId}`;
  return { method: 'POST', url: `https://api.notion.com/v1/${target}/query`,
    headers: { 'Content-Type': 'application/json', 'Notion-Version': config.dataSourceId ? '2025-09-03' : '2022-06-28' },
    // El cursor va en el CUERPO, no en la query string: el transporte prohíbe `url.search`.
    body: { filter: { property: 'Estado', select: { is_not_empty: true } }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } };
}
const plain = (property: unknown): string | undefined => {
  const rich = (property as { rich_text?: { text?: { content?: unknown } }[] } | null)?.rich_text;
  if (!Array.isArray(rich)) return undefined;
  const joined = rich.map(chunk => typeof chunk?.text?.content === 'string' ? chunk.text.content : '').join('');
  return joined.trim() || undefined;
};
export function parseBoardRow(page: unknown, config: NotionConfig): BoardRow | SkippedRow {
  const p = page as { properties?: Record<string, unknown>; last_edited_time?: unknown } | null;
  const properties = p?.properties ?? {};
  const externalKey = plain(properties[config.externalKeyProperty]) ?? '';
  // Una clave que no es un SHA-256 no puede corresponder a un registro: no se adivina a cuál.
  if (!/^[a-f0-9]{64}$/.test(externalKey)) return { externalKey, reason: 'external_key_invalid' };
  const estado = (properties.Estado as { select?: { name?: unknown } } | null)?.select?.name;
  if (typeof estado !== 'string' || !estado.trim()) return { externalKey, reason: 'estado_missing' };
  const appliedAt = (properties['Applied at'] as { date?: { start?: unknown } } | null)?.date?.start;
  const lastEditedAt = typeof p?.last_edited_time === 'string' ? p.last_edited_time : undefined;
  if (!lastEditedAt) return { externalKey, reason: 'last_edited_missing' };
  return { externalKey, estado: estado.trim(), lastEditedAt, ...(typeof appliedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(appliedAt) ? { appliedAt: appliedAt.slice(0, 10) } : {}) };
}
export async function readBoard(value: unknown, transport: HttpTransport): Promise<{ rows: BoardRow[]; skipped: SkippedRow[] }> {
  const config = validateNotionConfig(value);
  const rows: BoardRow[] = []; const skipped: SkippedRow[] = [];
  let cursor: string | undefined;
  // Tope de páginas por el mismo motivo que en las fuentes: un cursor roto no puede girar sin fin.
  for (let page = 0; page < 50; page++) {
    const response = await transport(queryBoardRequest(config, cursor));
    if (response.status !== 200) throw new Error('board_unreadable');
    const body = response.body as { results?: unknown[]; has_more?: unknown; next_cursor?: unknown } | null;
    if (!Array.isArray(body?.results)) throw new Error('board_unreadable');
    for (const result of body.results) {
      const row = parseBoardRow(result, config);
      if ('reason' in row) skipped.push(row); else rows.push(row);
    }
    if (body.has_more !== true || typeof body.next_cursor !== 'string' || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return { rows, skipped };
}

/**
 * Convierte filas en eventos. `unknownStates` es la lista de valores de `Estado` que no se reconocen.
 *
 * Un select nuevo **no se traduce en silencio**: si alguien añade "En negociación" al tablero, esto lo
 * reporta y el CLI sale con error. Adivinar a qué escalón corresponde sería inventar un dato del
 * embudo, y el embudo es lo único que va a decidir si esta máquina sirve.
 */
export function boardEvents(rows: readonly BoardRow[], now: Date): { events: TrackingEvent[]; skipped: SkippedRow[]; unknownStates: string[] } {
  const events: TrackingEvent[] = []; const skipped: SkippedRow[] = [];
  const unknownStates = [...new Set(rows.map(row => row.estado).filter(estado => !(estado in LADDER)))].sort();
  void now;
  for (const row of rows) {
    const ladder = LADDER[row.estado];
    if (!ladder) continue;
    if (!ladder.length) continue;
    // `Postulada` o más sin fecha se SALTA. Nunca se adivina una fecha de postulación: `attemptId`
    // se deriva de ella, así que inventarla inventaría la identidad de la postulación entera.
    if (!row.appliedAt) { skipped.push({ externalKey: row.externalKey, reason: 'applied_at_missing' }); continue; }
    const attemptId = row.appliedAt;
    const applicationId = applicationIdentity(row.externalKey, attemptId);
    for (const step of ladder) {
      const [type, discriminator] = step.split(':') as [TrackingEvent['type'], string | undefined];
      // La postulación ocurrió el día que dice la fecha; los pasos posteriores, cuando se editó la
      // fila. Es lo más cercano a la verdad que el tablero puede ofrecer.
      const occurredAt = type === 'application' ? `${row.appliedAt}T00:00:00Z` : row.lastEditedAt;
      const eventId = createHash('sha256').update(JSON.stringify(['notion', applicationId, type, discriminator ?? '', occurredAt])).digest('hex');
      /**
       * `recordedAt` se ata a la MISMA información que el `eventId`, y por eso es `occurredAt`.
       *
       * `importTracking` lanza si un `eventId` repetido llega con contenido distinto, así que el
       * invariante que hay que garantizar es "mismo id implica mismo contenido". Dos intentos
       * fallaron antes de llegar aquí: con el reloj de la corrida, la segunda pasada rompía; y con
       * `last_edited_time`, el evento de postulación —cuyo id NO depende de esa fecha— cambiaba de
       * contenido en cuanto Juan editaba cualquier otra cosa de la fila.
       *
       * Lo que se pierde es el matiz de "cuándo nos enteramos", y lo que se gana es que reimportar
       * el mismo tablero no pueda fallar nunca. Para el embudo da igual: `trackingReport` filtra por
       * ambas fechas y aquí son la misma.
       */
      const base = { schemaVersion: 1 as const, eventId, occurredAt, recordedAt: occurredAt, applicationId };
      if (type === 'application') events.push({ ...base, type, opportunityId: row.externalKey, attemptId });
      else if (type === 'response') events.push({ ...base, type, outcome: discriminator as 'positive' | 'negative' });
      else if (type === 'interview') events.push({ ...base, type, status: discriminator as 'scheduled' | 'completed' });
      else events.push({ ...base, type: 'offer', status: discriminator as 'received' | 'accepted' | 'declined' });
    }
  }
  return { events, skipped, unknownStates };
}
