/**
 * Registro de qué oportunidades ya se entregaron.
 *
 * Sin esto, una ventana de publicación de siete días entrega LA MISMA lista siete días seguidos:
 * el corte diario es determinista, así que sin memoria repite su mejor respuesta hasta que el
 * pool cambie. El ledger es lo que convierte "las 10 mejores" en "10 que no habías visto".
 *
 * No elimina lo ya entregado, lo DEGRADA: si un día solo hay 6 nuevas, es preferible completar
 * con repetidas marcadas como tales que entregar seis y fingir que no hay más.
 */
export interface DeliveryEntry { id: string; firstDeliveredAt: string; deliveries: number }
export interface DeliveryLedger { version: 1; entries: DeliveryEntry[] }

export const emptyLedger = (): DeliveryLedger => ({ version: 1, entries: [] });

export function parseLedger(value: unknown): DeliveryLedger {
  if (value === undefined) return emptyLedger();
  const v = value as Partial<DeliveryLedger> | null;
  if (!v || v.version !== 1 || !Array.isArray(v.entries)) throw new Error('ledger_invalid');
  const seen = new Set<string>();
  const entries = v.entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('ledger_invalid');
    const { id, firstDeliveredAt, deliveries } = entry as DeliveryEntry;
    if (typeof id !== 'string' || !/^[a-f\d]{64}$/.test(id) || seen.has(id)) throw new Error('ledger_invalid');
    if (typeof firstDeliveredAt !== 'string' || !Number.isFinite(Date.parse(firstDeliveredAt)) || new Date(firstDeliveredAt).toISOString() !== firstDeliveredAt) throw new Error('ledger_invalid');
    if (!Number.isSafeInteger(deliveries) || deliveries < 1) throw new Error('ledger_invalid');
    seen.add(id);
    return { id, firstDeliveredAt, deliveries };
  });
  return { version: 1, entries: entries.sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Conjunto de identidades ya entregadas, para que `recommend` las degrade sin releer el archivo. */
export const deliveredIds = (ledger: DeliveryLedger): ReadonlySet<string> => new Set(ledger.entries.map(e => e.id));

/** Suma una entrega. `firstDeliveredAt` nunca se reescribe: es el dato que dice cuándo la viste. */
export function recordDelivery(ledger: DeliveryLedger, ids: readonly string[], at: string): DeliveryLedger {
  const byId = new Map(ledger.entries.map(e => [e.id, e]));
  for (const id of new Set(ids)) {
    const existing = byId.get(id);
    byId.set(id, existing ? { ...existing, deliveries: existing.deliveries + 1 } : { id, firstDeliveredAt: at, deliveries: 1 });
  }
  return { version: 1, entries: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

/**
 * Olvida entregas anteriores al corte. Una oferta vista hace meses puede volver a ofrecerse: el
 * ledger acota el store, no guarda historia para siempre.
 */
export function pruneLedger(ledger: DeliveryLedger, before: string): DeliveryLedger {
  const cutoff = Date.parse(before);
  return { version: 1, entries: ledger.entries.filter(e => Date.parse(e.firstDeliveredAt) >= cutoff) };
}
