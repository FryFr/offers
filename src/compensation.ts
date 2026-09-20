import type { Compensation } from './contracts.ts';
import { toUsd } from './fx.ts';

/**
 * Normalización ÚNICA de compensación. Antes vivía duplicada en `screening.ts` y en
 * `evaluate.normalize()` con dos matemáticas distintas: una proyectaba con las horas del perfil
 * y la otra se negaba a hacerlo, así que la misma oferta daba cifras diferentes según quién
 * preguntara. Un solo módulo elimina esa divergencia por construcción.
 *
 * Todo se ancla en `hoursPerMonth` del perfil: mensual primero, y el resto se deriva de ahí.
 * Las equivalencias por día y por semana usan esas horas declaradas en vez de constantes de
 * calendario, para que el supuesto sea uno solo y quede escrito en `assumptions`.
 */
export interface Range { min: number; max: number }
export interface NormalizedPay {
  hourlyUsd: Range | null;
  monthlyUsd: Range | null;
  projectUsd: Range | null;
  assumptions: string[];
  /** Si alguna cifra pasó por la tabla de cambio; relevante para no tratarla como dato de la fuente. */
  converted: boolean;
  /**
   * Sobre qué descansa la cifra mensual. `declared` cuando el proveedor publicó un periodo que
   * no depende de horas (mes, año) o declaró sus horas; `assumed_hours` cuando hubo que asumir
   * las del perfil. El gate de screening solo acepta `declared`: las horas del perfil sirven
   * para proyectar, no son evidencia de volumen pagado.
   */
  monthlyBasis: 'declared' | 'assumed_hours' | null;
}

const empty = (assumption: string): NormalizedPay => ({ hourlyUsd: null, monthlyUsd: null, projectUsd: null, assumptions: [assumption], converted: false, monthlyBasis: null });
/** Periodos cuya equivalencia mensual no requiere suponer cuántas horas se trabajarán. */
const CALENDAR_PERIODS = new Set(['month', 'year']);
const scale = (range: Range, factor: number): Range => ({ min: range.min * factor, max: range.max * factor });

export function normalizePay(compensation: Compensation | undefined, hoursPerMonth: number): NormalizedPay {
  if (!compensation) return empty('Compensación no informada');
  const low = toUsd(compensation.min, compensation.currency);
  const high = toUsd(compensation.max ?? compensation.min, compensation.currency);
  if (!low || !high) return empty(`Moneda ${compensation.currency.toUpperCase()} fuera de la tabla de cambio; no se convierte ni se estima`);

  const usd: Range = { min: low.usd, max: high.usd };
  const assumptions = [low.assumption];
  const perMonth: Record<Exclude<Compensation['period'], 'project'>, number> = {
    hour: hoursPerMonth,
    day: hoursPerMonth / 8,
    week: hoursPerMonth / 40,
    month: 1,
    year: 1 / 12,
  };

  if (compensation.period === 'project') {
    const hours = compensation.estimatedHours;
    assumptions.push(hours === undefined
      ? 'Presupuesto por proyecto sin horas estimadas: no se deriva tarifa horaria'
      : `Tarifa horaria derivada de ${hours} horas estimadas declaradas por la fuente`);
    return { hourlyUsd: hours === undefined ? null : scale(usd, 1 / hours), monthlyUsd: null, projectUsd: usd, assumptions, converted: low.converted, monthlyBasis: null };
  }

  const factor = perMonth[compensation.period];
  const monthly = scale(usd, factor);
  if (compensation.period !== 'month') {
    assumptions.push(`Equivalencia mensual con ${hoursPerMonth} h/mes declaradas en el perfil; no garantiza volumen de trabajo`);
  }
  // Las horas del proveedor mandan sobre las del perfil cuando las declara.
  const hours = compensation.hoursPerMonth ?? hoursPerMonth;
  if (compensation.hoursPerMonth !== undefined) assumptions.push(`Horas mensuales declaradas por la fuente: ${compensation.hoursPerMonth}`);
  const monthlyBasis = CALENDAR_PERIODS.has(compensation.period) || compensation.hoursPerMonth !== undefined ? 'declared' : 'assumed_hours';
  return { hourlyUsd: scale(monthly, 1 / hours), monthlyUsd: monthly, projectUsd: null, assumptions, converted: low.converted, monthlyBasis };
}
