// Client-safe simulation bundle: scenarios, projections, stress results.
// Runs on the server for the first answer and in the browser on every edit.
import type { Projection, ProjectionInputs, Scenario } from "../engine/model";
import { NO_LEVERS } from "../engine/model";
import type { DecisionRequest } from "../engine/plan";
import { isFeasible, proposedLevers, searchSafestPlan, stressOf } from "../engine/plan";
import { project } from "../engine/projection";
import type { BreakingPoint, StressCell } from "../engine/stress";
import { breakingPoints, firstBreakingCombo, stressed, stressGrid } from "../engine/stress";
import type { SimulationSpec } from "./assumptions";

export interface SimulationResult {
  scenarios: Scenario[];
  projections: Record<string, Projection>;
  stressedProjections: Record<string, Projection>;
  feasible: Record<string, boolean>;
  search: { candidatesEvaluated: number; feasibleCount: number; recommendedFeasible: boolean; changes: string[] } | null;
  stress: {
    grid: StressCell[];
    breakingPoints: BreakingPoint[];
    firstBreak: StressCell | null;
    delaySweep: { delay: number; minCash: Record<string, number> }[];
  } | null;
  computeMs: number;
  recomputed: string[]; // scenario ids actually recomputed (others reused from cache)
}

export function requestHasDecision(r: DecisionRequest): boolean {
  return Boolean((r.hires && r.hires.count > 0) || (r.marketingWeekly ?? 0) > 0 || (r.ownerDraw ?? 0) > 0 || r.priceChangePct || r.oneTime || r.vendorTermsExtraDays);
}

type Cache = Map<string, Projection>;

function cachedProject(cache: Cache | undefined, inputs: ProjectionInputs, sc: Scenario, reserve: number, horizon: number, tag: string, recomputed: Set<string>): Projection {
  const key = `${tag}:${JSON.stringify(sc.levers)}:${reserve}:${horizon}`;
  const hit = cache?.get(key);
  if (hit) return { ...hit, scenarioId: sc.id };
  const p = project(inputs, sc.levers, reserve, horizon, sc.id);
  cache?.set(key, p);
  recomputed.add(sc.id);
  return p;
}

export function simulate(inputs: ProjectionInputs, spec: SimulationSpec, cache?: Cache): SimulationResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { request, settings } = spec;
  const H = settings.horizonWeeks;
  const reserve = settings.reserve;
  const stress = stressOf(settings);
  const recomputed = new Set<string>();

  let scenarios: Scenario[];
  let search: SimulationResult["search"] = null;
  if (requestHasDecision(request)) {
    const r = searchSafestPlan(inputs, request, settings);
    scenarios = [r.current, r.proposed, r.recommended];
    search = { candidatesEvaluated: r.candidatesEvaluated, feasibleCount: r.feasibleCount, recommendedFeasible: r.recommendedFeasible, changes: r.changes };
  } else {
    scenarios = [{ id: "current", name: "Current plan", role: "current", levers: { ...NO_LEVERS, priceElasticity: settings.priceElasticity }, description: "No changes." }];
    // Stress-only questions still benefit from the protective actions as a comparison.
    if (settings.collectOverdue && inputs.openAR.some((a) => a.daysPastDue > 0)) {
      scenarios.push({
        id: "recommended",
        name: "With collections drive",
        role: "recommended",
        levers: { ...proposedLevers(request, settings), collectOverdue: settings.collectOverdue },
        description: `Chase overdue invoices (assumes ${Math.round(settings.collectOverdue.recoveryPct * 100)}% recovered within ${settings.collectOverdue.withinDays} days)`,
      });
    }
  }

  const projections: Record<string, Projection> = {};
  const stressedProjections: Record<string, Projection> = {};
  const feasible: Record<string, boolean> = {};
  for (const sc of scenarios) {
    projections[sc.id] = cachedProject(cache, inputs, sc, reserve, H, "base", recomputed);
    const ss = { ...sc, levers: stressed(sc.levers, stress) };
    stressedProjections[sc.id] = cachedProject(cache, inputs, ss, reserve, H, "stress", recomputed);
    feasible[sc.id] = isFeasible(projections[sc.id], stressedProjections[sc.id], reserve);
  }

  let stressResult: SimulationResult["stress"] = null;
  if (spec.stressRequested) {
    const target = scenarios.find((s) => s.role === "recommended") ?? scenarios[0];
    const grid = stressGrid(inputs, target.levers, reserve, H);
    const delaySweep = [0, 15, 30, 45, 60].map((delay) => ({
      delay,
      minCash: Object.fromEntries(scenarios.map((sc) => [sc.id, project(inputs, { ...sc.levers, paymentDelayDays: sc.levers.paymentDelayDays + delay }, reserve, H).summary.minCash])),
    }));
    stressResult = { grid, breakingPoints: breakingPoints(inputs, target.levers, reserve, H), firstBreak: firstBreakingCombo(grid), delaySweep };
  }

  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { scenarios, projections, stressedProjections, feasible, search, stress: stressResult, computeMs: t1 - t0, recomputed: [...recomputed] };
}
