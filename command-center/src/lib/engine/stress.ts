// Chaos Simulator: deterministic stress tests. No probabilities: each cell is
// one explicit combination of shocks, and we report where the plan breaks.
import type { Levers, ProjectionInputs } from "./model";
import { DEFAULT_HORIZON_WEEKS, project } from "./projection";

export const STRESS_AXES = {
  salesDecline: [0, 0.1, 0.2, 0.3],
  paymentDelayDays: [0, 15, 30, 45],
  costShock: [0, 0.1, 0.2],
};

export interface StressCell {
  salesDecline: number;
  paymentDelayDays: number;
  costShock: number;
  minCash: number;
  endingCash: number;
  breachesReserve: boolean;
  goesNegative: boolean;
}

export function stressed(levers: Levers, s: { salesDecline: number; paymentDelayDays: number; costShock: number }): Levers {
  return {
    ...levers,
    salesChangePct: levers.salesChangePct - s.salesDecline,
    paymentDelayDays: levers.paymentDelayDays + s.paymentDelayDays,
    costShockPct: levers.costShockPct + s.costShock,
  };
}

export function stressGrid(inputs: ProjectionInputs, levers: Levers, reserve: number, horizon = DEFAULT_HORIZON_WEEKS, axes = STRESS_AXES): StressCell[] {
  const cells: StressCell[] = [];
  for (const salesDecline of axes.salesDecline)
    for (const paymentDelayDays of axes.paymentDelayDays)
      for (const costShock of axes.costShock) {
        const p = project(inputs, stressed(levers, { salesDecline, paymentDelayDays, costShock }), reserve, horizon);
        cells.push({
          salesDecline,
          paymentDelayDays,
          costShock,
          minCash: p.summary.minCash,
          endingCash: p.summary.endingCash,
          breachesReserve: p.summary.firstBreachWeek !== null,
          goesNegative: p.summary.firstNegativeWeek !== null,
        });
      }
  return cells;
}

export interface BreakingPoint {
  axis: "salesDecline" | "paymentDelayDays" | "costShock";
  /** Smallest shock on this axis alone that takes cash below the reserve; null if none up to the max tested. */
  breaksReserveAt: number | null;
  /** Smallest shock that takes cash below zero. */
  breaksZeroAt: number | null;
  maxTested: number;
}

const SEARCH: Record<BreakingPoint["axis"], number[]> = {
  salesDecline: Array.from({ length: 11 }, (_, i) => i * 0.05), // 0..50%
  paymentDelayDays: Array.from({ length: 13 }, (_, i) => i * 5), // 0..60 days
  costShock: Array.from({ length: 11 }, (_, i) => i * 0.05), // 0..50%
};

export function breakingPoints(inputs: ProjectionInputs, levers: Levers, reserve: number, horizon = DEFAULT_HORIZON_WEEKS): BreakingPoint[] {
  return (Object.keys(SEARCH) as BreakingPoint["axis"][]).map((axis) => {
    let reserveAt: number | null = null;
    let zeroAt: number | null = null;
    for (const v of SEARCH[axis]) {
      const shock = { salesDecline: 0, paymentDelayDays: 0, costShock: 0, [axis]: v };
      const p = project(inputs, stressed(levers, shock), reserve, horizon);
      if (reserveAt === null && p.summary.firstBreachWeek !== null) reserveAt = v;
      if (zeroAt === null && p.summary.firstNegativeWeek !== null) zeroAt = v;
      if (reserveAt !== null && zeroAt !== null) break;
    }
    return { axis, breaksReserveAt: reserveAt, breaksZeroAt: zeroAt, maxTested: SEARCH[axis][SEARCH[axis].length - 1] };
  });
}

/** Mildest combination in the grid that breaches the reserve (by total shock severity). */
export function firstBreakingCombo(cells: StressCell[]): StressCell | null {
  const sev = (c: StressCell) => c.salesDecline / 0.1 + c.paymentDelayDays / 15 + c.costShock / 0.1;
  return cells.filter((c) => c.breachesReserve).sort((a, b) => sev(a) - sev(b))[0] ?? null;
}
