/**
 * Tabla de cambio ESTÁTICA, versionada y fechada. No es una cotización ni consulta la red.
 *
 * Existe porque bloquear toda oferta que no esté en USD sería un falso negativo enorme:
 * 90.000 EUR/año son ~8.100 USD/mes y caen de lleno en el rango objetivo. Landing.jobs y las
 * fuentes europeas publican casi todo en EUR.
 *
 * Cada cifra derivada arrastra una assumption literal que dice que es una tasa fija y su fecha,
 * para que nadie confunda una conversión aproximada con un dato del proveedor. Una prueba falla
 * cuando `asOf` supera los 180 días: la tabla la refresca una persona, no el programa.
 *
 * ⚠️ Los valores son aproximados y de mantenimiento manual. Revisarlos antes de tomar
 * decisiones económicas finas; sirven para ordenar ofertas, no para negociar un contrato.
 */
export interface FxTable {
  version: 1;
  asOf: string;
  base: 'USD';
  /** Cuántos USD vale UNA unidad de la moneda. */
  rates: Readonly<Record<string, number>>;
}
export const FX: FxTable = {
  version: 1,
  asOf: '2026-09-20',
  base: 'USD',
  rates: {
    USD: 1, EUR: 1.08, GBP: 1.26, CHF: 1.12, CAD: 0.72, AUD: 0.65, NZD: 0.60,
    SEK: 0.094, NOK: 0.092, DKK: 0.145, PLN: 0.25, CZK: 0.043, ILS: 0.27,
    SGD: 0.75, JPY: 0.0067, INR: 0.012, BRL: 0.18, MXN: 0.050, COP: 0.00025,
    ARS: 0.0010, CLP: 0.0011, UYU: 0.025, ZAR: 0.055,
  },
};
/** Días que puede tener la tabla antes de que la prueba de frescura falle. */
export const FX_MAX_AGE_DAYS = 180;

export interface Converted { usd: number; converted: boolean; assumption: string }
/**
 * Convierte a USD. Devuelve `null` para monedas que la tabla no cubre: es preferible no
 * puntuar una oferta a inventarle un salario.
 */
export function toUsd(amount: number, currency: string): Converted | null {
  const code = currency.toUpperCase();
  const rate = FX.rates[code];
  if (rate === undefined) return null;
  if (code === 'USD') return { usd: amount, converted: false, assumption: 'Importe declarado en USD por la fuente' };
  return { usd: amount * rate, converted: true, assumption: `Convertido de ${code} con tasa fija ${rate} del ${FX.asOf}; no es cotización` };
}
