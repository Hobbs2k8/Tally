// Safest-plan search. Given the decisions the owner asked for, enumerate
// deterministic variants (timing, size, sequencing, plus protective actions
// the owner controls), keep those that are feasible, and pick the one that
// delivers the most of what was asked. Pure and client-safe.
//
// Feasible means: closing cash stays at or above the reserve every week in the
// base case, AND never goes below zero under the payment-delay stress. The
// reserve is the buffer that absorbs the stress, so requiring it to survive
// the stress untouched would double-count.
import type { Hire, Levers, OwnerDraw, Projection, ProjectionInputs, Scenario } from "./model";
import { NO_LEVERS } from "./model";
import { DEFAULT_HORIZON_WEEKS, project } from "./projection";
import { stressed } from "./stress";

export interface DecisionRequest {
  hires: { count: number; weeklyWage: number } | null;
  marketingWeekly: number | null;
  ownerDraw: number | null;
  priceChangePct?: number | null;
  vendorTermsExtraDays?: number | null;
  oneTime?: { label: string; amount: number } | null;
}

export interface PlanSettings {
  reserve: number;
  horizonWeeks: number;
  stressDelayDays: number;
  /** Optional extra shocks in the stress case (fractions). */
  stressSalesDecline?: number;
  stressCostShock?: number;
  collectOverdue: { recoveryPct: number; withinDays: number } | null;
  /** Extra supplier days the plan may ask for (0 disables this protective option). */
  vendorTermsAskDays: number;
  marketingLiftPct: number;
  priceElasticity: number;
}

export interface Candidate {
  levers: Levers;
  value: number; // 0..1 share of the request delivered
  baseMin: number;
  stressMin: number;
  feasible: boolean;
  changes: string[];
}

export interface PlanSearchResult {
  current: Scenario;
  proposed: Scenario;
  recommended: Scenario;
  recommendedFeasible: boolean;
  proposedFeasible: boolean;
  candidatesEvaluated: number;
  feasibleCount: number;
  changes: string[]; // how the recommendation differs from the proposal
}

function baseLevers(req: DecisionRequest, s: PlanSettings): Levers {
  return {
    ...NO_LEVERS,
    marketingLiftPct: s.marketingLiftPct,
    priceElasticity: s.priceElasticity,
    priceChangePct: req.priceChangePct ?? 0,
    vendorTermsExtraDays: req.vendorTermsExtraDays ?? 0,
    oneTime: req.oneTime ? [{ ...req.oneTime, week: 0 }] : [],
  };
}

export function proposedLevers(req: DecisionRequest, s: PlanSettings): Levers {
  return {
    ...baseLevers(req, s),
    hires: req.hires && req.hires.count > 0 ? [{ count: req.hires.count, weeklyWage: req.hires.weeklyWage, startWeek: 0 }] : [],
    marketingWeekly: req.marketingWeekly ?? 0,
    marketingStartWeek: 0,
    ownerDraws: req.ownerDraw ? [{ amount: req.ownerDraw, week: 0 }] : [],
  };
}

interface Option<T> {
  value: T;
  score: number;
  note: string | null;
}

function hireOptions(req: DecisionRequest, H: number): Option<Hire[]>[] {
  const h = req.hires;
  if (!h || h.count <= 0) return [{ value: [], score: 1, note: null }];
  const n = h.count;
  const w = h.weeklyWage;
  const weeks = (hs: Hire[]) => hs.reduce((s, x) => s + x.count * Math.max(0, H - x.startWeek), 0) / (n * H);
  const opts: Hire[][] = [
    [{ count: n, weeklyWage: w, startWeek: 0 }],
    [{ count: n, weeklyWage: w, startWeek: 4 }],
    [{ count: n, weeklyWage: w, startWeek: 8 }],
    [],
  ];
  if (n >= 2) {
    opts.push([
      { count: 1, weeklyWage: w, startWeek: 0 },
      { count: n - 1, weeklyWage: w, startWeek: 6 },
    ]);
    opts.push([{ count: 1, weeklyWage: w, startWeek: 0 }]);
    opts.push([{ count: 1, weeklyWage: w, startWeek: 4 }]);
  }
  return opts.map((hs) => ({ value: hs, score: weeks(hs), note: describeHires(hs, n) }));
}

function describeHires(hs: Hire[], requested: number): string {
  if (!hs.length) return `Hold off on all ${requested} hires for now`;
  const total = hs.reduce((s, x) => s + x.count, 0);
  const parts = hs.map((x) => `${x.count} ${x.startWeek === 0 ? "now" : `in week ${x.startWeek + 1}`}`);
  const prefix = total < requested ? `Hire ${total} of ${requested}: ` : "Hire ";
  return prefix + parts.join(", ");
}

function marketingOptions(req: DecisionRequest): Option<{ weekly: number; start: number }>[] {
  const m = req.marketingWeekly ?? 0;
  if (m <= 0) return [{ value: { weekly: 0, start: 0 }, score: 1, note: null }];
  return [
    { value: { weekly: m, start: 0 }, score: 1, note: null },
    { value: { weekly: m, start: 4 }, score: 9 / 13, note: "Start the marketing increase in week 5" },
    { value: { weekly: Math.round(m / 2), start: 0 }, score: 0.5, note: "Start marketing at half the planned increase" },
    { value: { weekly: 0, start: 0 }, score: 0, note: "Defer the marketing increase" },
  ];
}

function drawOptions(req: DecisionRequest, H: number): Option<OwnerDraw[]>[] {
  const d = req.ownerDraw ?? 0;
  if (d <= 0) return [{ value: [], score: 1, note: null }];
  const late = Math.min(H - 1, 6);
  const end = H - 1;
  const half = Math.round(d / 2);
  return [
    { value: [{ amount: d, week: 0 }], score: 1, note: null },
    { value: [{ amount: d, week: late }], score: 0.95, note: `Take the owner draw in week ${late + 1}, after overdue invoices are chased` },
    { value: [{ amount: d, week: end }], score: 0.9, note: `Take the owner draw at the end of the quarter (week ${end + 1})` },
    { value: [{ amount: half, week: 0 }, { amount: d - half, week: end }], score: 0.95, note: `Split the owner draw: half now, half in week ${end + 1}` },
    { value: [{ amount: half, week: late }], score: 0.5, note: `Take half the owner draw, in week ${late + 1}` },
    { value: [], score: 0, note: "Skip the owner draw this quarter" },
  ];
}

export function searchSafestPlan(inputs: ProjectionInputs, req: DecisionRequest, s: PlanSettings): PlanSearchResult & { candidates: Candidate[] } {
  const H = s.horizonWeeks || DEFAULT_HORIZON_WEEKS;
  const weights = {
    hires: req.hires && req.hires.count > 0 ? 1 : 0,
    marketing: (req.marketingWeekly ?? 0) > 0 ? 1 : 0,
    draw: (req.ownerDraw ?? 0) > 0 ? 1 : 0,
  };
  const wsum = weights.hires + weights.marketing + weights.draw || 1;
  const hasOverdue = inputs.openAR.some((a) => a.daysPastDue > 0);
  const base = baseLevers(req, s);
  const stress = stressOf(s);

  // Protective option: ask suppliers for longer terms. Small value penalty so
  // the plan only leans on a negotiation when it needs to.
  const vendorOpts = [{ days: 0, penalty: 0 }];
  if (s.vendorTermsAskDays > 0 && inputs.variableCostRatio > 0.05) vendorOpts.push({ days: s.vendorTermsAskDays, penalty: 0.05 });

  const candidates: Candidate[] = [];
  for (const h of hireOptions(req, H))
    for (const m of marketingOptions(req))
      for (const d of drawOptions(req, H))
        for (const v of vendorOpts) {
          const levers: Levers = {
            ...base,
            hires: h.value,
            marketingWeekly: m.value.weekly,
            marketingStartWeek: m.value.start,
            ownerDraws: d.value,
            collectOverdue: hasOverdue ? s.collectOverdue : null,
            vendorTermsExtraDays: base.vendorTermsExtraDays + v.days,
          };
          const pBase = project(inputs, levers, s.reserve, H);
          const pStress = project(inputs, stressed(levers, stress), s.reserve, H);
          const value = (weights.hires * h.score + weights.marketing * m.score + weights.draw * d.score) / wsum - v.penalty;
          const notes = [h.note, m.note, d.note].filter((x): x is string => Boolean(x) && !/^Hire \d+ now$/.test(x as string));
          if (v.days) notes.push(`Ask suppliers for ${v.days} more days on new bills (assumes they agree)`);
          candidates.push({
            levers,
            value,
            baseMin: pBase.summary.minCash,
            stressMin: pStress.summary.minCash,
            feasible: isFeasible(pBase, pStress, s.reserve),
            changes: notes,
          });
        }

  const feasible = candidates.filter((c) => c.feasible);
  const pool = feasible.length ? feasible : candidates;
  const best = [...pool].sort((a, b) =>
    feasible.length ? b.value - a.value || b.stressMin - a.stressMin : b.stressMin - a.stressMin || b.value - a.value,
  )[0];

  const proposed = proposedLevers(req, s);
  const pp = project(inputs, proposed, s.reserve, H);
  const ppS = project(inputs, stressed(proposed, stress), s.reserve, H);
  const changes = [...best.changes];
  if (best.levers.collectOverdue) {
    changes.unshift(`Chase overdue invoices first (assumes ${Math.round(best.levers.collectOverdue.recoveryPct * 100)}% recovered within ${best.levers.collectOverdue.withinDays} days)`);
  }

  return {
    current: { id: "current", name: "Current plan", role: "current", levers: { ...NO_LEVERS }, description: "No changes: today's run-rate, open invoices and bills." },
    proposed: { id: "proposed", name: "Your proposal", role: "proposed", levers: proposed, description: "Everything you asked for, starting now." },
    recommended: { id: "recommended", name: "Recommended plan", role: "recommended", levers: best.levers, description: changes.join(". ") },
    recommendedFeasible: best.feasible,
    proposedFeasible: isFeasible(pp, ppS, s.reserve),
    candidatesEvaluated: candidates.length,
    feasibleCount: feasible.length,
    changes,
    candidates,
  };
}

/** Short phrases for how a recommended plan differs from the request (for one-line summaries). */
export function shortChanges(levers: Levers, req: DecisionRequest, fmt: (c: number) => string): string[] {
  const out: string[] = [];
  if (levers.collectOverdue) out.push("chase overdue invoices first");
  const n = req.hires?.count ?? 0;
  if (n > 0) {
    const total = levers.hires.reduce((s, h) => s + h.count, 0);
    if (!total) out.push("hold off on hiring");
    else if (levers.hires.length === 1 && total === n && levers.hires[0].startWeek > 0) out.push(`${n === 1 ? "make the hire" : n === 2 ? "hire both" : `hire all ${n}`} in week ${levers.hires[0].startWeek + 1}`);
    else if (levers.hires.length > 1) out.push(`stagger hires (${levers.hires.map((h) => `${h.count} ${h.startWeek ? `in week ${h.startWeek + 1}` : "now"}`).join(", ")})`);
    else if (total < n) out.push(`hire ${total} of ${n}${levers.hires[0].startWeek ? ` in week ${levers.hires[0].startWeek + 1}` : " now"}`);
  }
  const m = req.marketingWeekly ?? 0;
  if (m > 0) {
    if (!levers.marketingWeekly) out.push("defer the marketing increase");
    else if (levers.marketingWeekly < m) out.push("start marketing at half the increase");
    else if (levers.marketingStartWeek > 0) out.push(`start marketing in week ${levers.marketingStartWeek + 1}`);
  }
  const d = req.ownerDraw ?? 0;
  if (d > 0) {
    const draws = levers.ownerDraws;
    const total = draws.reduce((s, x) => s + x.amount, 0);
    if (!total) out.push("skip the owner draw this quarter");
    else if (draws.length > 1) out.push(`split the ${fmt(d)} draw (${draws.map((x) => `${fmt(x.amount)} in week ${x.week + 1}`).join(", ")})`);
    else if (total < d) out.push(`take ${fmt(total)} of the draw in week ${draws[0].week + 1}`);
    else if (draws[0].week > 0) out.push(`take the ${fmt(d)} draw in week ${draws[0].week + 1}`);
  }
  if (levers.vendorTermsExtraDays > (req.vendorTermsExtraDays ?? 0)) out.push(`ask suppliers for ${levers.vendorTermsExtraDays - (req.vendorTermsExtraDays ?? 0)} more days`);
  return out;
}

export function stressOf(s: PlanSettings) {
  return { salesDecline: s.stressSalesDecline ?? 0, paymentDelayDays: s.stressDelayDays, costShock: s.stressCostShock ?? 0 };
}

export function isFeasible(base: Projection, stress: Projection, reserve: number): boolean {
  return base.summary.minCash >= reserve && stress.summary.minCash >= 0;
}

export function projectAll(inputs: ProjectionInputs, scenarios: Scenario[], reserve: number, horizon: number): Record<string, Projection> {
  const out: Record<string, Projection> = {};
  for (const sc of scenarios) out[sc.id] = project(inputs, sc.levers, reserve, horizon, sc.id);
  return out;
}
