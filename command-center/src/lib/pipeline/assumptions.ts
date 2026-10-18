// Editable assumptions. Each maps to a lever or setting of the simulation, so
// editing one in the UI reruns the engine in the browser with no model call.
import type { ProjectionInputs } from "../engine/model";
import type { DecisionRequest, PlanSettings } from "../engine/plan";

export type AssumptionId =
  | "reserve"
  | "horizonWeeks"
  | "stressDelayDays"
  | "stressSalesDecline"
  | "stressCostShock"
  | "hireCount"
  | "hireWeeklyWage"
  | "marketingMonthly"
  | "ownerDraw"
  | "marketingLiftPct"
  | "recoveryPct"
  | "vendorTermsAskDays"
  | "priceChangePct"
  | "priceElasticity"
  | "equipmentAmount";

export interface Assumption {
  id: AssumptionId;
  label: string;
  value: number; // cents for usd, fraction for pct
  unit: "usd" | "days" | "weeks" | "pct" | "count" | "ratio";
  source: "you" | "default" | "history";
  note: string;
  min: number;
  max: number;
  step: number;
}

export interface SimulationSpec {
  request: DecisionRequest;
  settings: PlanSettings;
  stressRequested: boolean;
}

export function specFromAssumptions(list: Assumption[], stressRequested: boolean): SimulationSpec {
  const v = (id: AssumptionId, fallback = 0) => list.find((a) => a.id === id)?.value ?? fallback;
  const has = (id: AssumptionId) => list.some((a) => a.id === id);
  const hireCount = Math.round(v("hireCount"));
  return {
    stressRequested,
    request: {
      hires: hireCount > 0 ? { count: hireCount, weeklyWage: Math.round(v("hireWeeklyWage")) } : null,
      marketingWeekly: has("marketingMonthly") ? Math.round((v("marketingMonthly") * 12) / 52) : null,
      ownerDraw: has("ownerDraw") ? Math.round(v("ownerDraw")) : null,
      priceChangePct: has("priceChangePct") ? v("priceChangePct") : null,
      oneTime: has("equipmentAmount") && v("equipmentAmount") > 0 ? { label: "Equipment purchase", amount: Math.round(v("equipmentAmount")) } : null,
    },
    settings: {
      reserve: Math.round(v("reserve")),
      horizonWeeks: Math.round(v("horizonWeeks", 13)),
      stressDelayDays: Math.round(v("stressDelayDays", 30)),
      stressSalesDecline: v("stressSalesDecline"),
      stressCostShock: v("stressCostShock"),
      collectOverdue: has("recoveryPct") ? { recoveryPct: v("recoveryPct"), withinDays: 14 } : null,
      vendorTermsAskDays: Math.round(v("vendorTermsAskDays")),
      marketingLiftPct: v("marketingLiftPct"),
      priceElasticity: v("priceElasticity", -1),
    },
  };
}

export function withValue(list: Assumption[], id: AssumptionId, value: number): Assumption[] {
  return list.map((a) => (a.id === id ? { ...a, value: Math.min(a.max, Math.max(a.min, value)), source: "you" } : a));
}

/** Helper for the server: defaults that depend on the books. */
export function defaultDraw(pastDraws: number[]): { value: number; source: "history" | "default" } {
  if (!pastDraws.length) return { value: 1_000_000, source: "default" };
  const s = [...pastDraws].sort((a, b) => a - b);
  const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { value: Math.max(100_000, Math.round(m / 100_000) * 100_000), source: "history" };
}

export function defaultMarketingMonthly(inputs: ProjectionInputs): number {
  const monthlySales = (inputs.weeklyInvoicedSales + inputs.weeklyPosSales) * 4.33;
  return Math.max(50_000, Math.round((monthlySales * 0.02) / 10_000) * 10_000);
}
