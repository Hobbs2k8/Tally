// Weekly cash-flow projection. Pure and client-safe: depends only on
// ProjectionInputs and Levers, so the browser can rerun it instantly.
import type { Levers, Projection, ProjectionInputs, ProjectionSummary, Scenario, WeekRow } from "./model";

export const DEFAULT_HORIZON_WEEKS = 13; // ~90 days

/** Week index for a day: week 0 covers days asOf+1 .. asOf+7. Past days land in week 0. */
export function weekOf(asOf: number, day: number): number {
  return Math.max(0, Math.floor((day - asOf - 1) / 7));
}

function addFractional(arr: number[], pos: number, amount: number) {
  const lo = Math.floor(pos);
  const f = pos - lo;
  if (lo >= 0 && lo < arr.length) arr[lo] += amount * (1 - f);
  if (f > 0 && lo + 1 >= 0 && lo + 1 < arr.length) arr[lo + 1] += amount * f;
}

function emptyRow(week: number, asOf: number): WeekRow {
  return {
    week,
    startDay: asOf + 1 + week * 7,
    endDay: asOf + 7 + week * 7,
    opening: 0,
    inflows: { openAR: 0, newSales: 0, pos: 0, recovered: 0 },
    outflows: { payroll: 0, newHires: 0, recurring: 0, openAP: 0, variable: 0, overhead: 0, marketing: 0, ownerDraws: 0, oneTime: 0 },
    net: 0,
    closing: 0,
    revenue: 0,
    operatingCost: 0,
  };
}

export function project(inputs: ProjectionInputs, levers: Levers, reserve: number, horizonWeeks = DEFAULT_HORIZON_WEEKS, scenarioId = "custom"): Projection {
  const asOf = inputs.asOfDay;
  const H = Math.max(1, Math.round(horizonWeeks));
  const rows = Array.from({ length: H }, (_, w) => emptyRow(w, asOf));
  const delayWeeks = Math.max(0, levers.paymentDelayDays) / 7;
  const costFactor = 1 + levers.costShockPct;

  // --- Inflows: open receivables -------------------------------------------
  const recovery = levers.collectOverdue;
  for (const a of inputs.openAR) {
    let remaining = a.amount;
    if (recovery && a.daysPastDue > 0) {
      const recovered = Math.round(a.amount * recovery.recoveryPct);
      remaining -= recovered;
      const day = asOf + recovery.withinDays + levers.paymentDelayDays;
      const w = weekOf(asOf, day);
      if (w < H) rows[w].inflows.recovered += recovered;
    }
    if (a.atRisk && !levers.includeAtRisk) continue;
    const w = weekOf(asOf, a.expectedDay + levers.paymentDelayDays);
    if (w < H) rows[w].inflows.openAR += remaining;
  }

  // --- Sales volume and revenue per week -----------------------------------
  const priceFactor = 1 + levers.priceChangePct;
  const volumeFromPrice = Math.max(0, 1 + levers.priceElasticity * levers.priceChangePct);
  const volume: number[] = [];
  for (let w = 0; w < H; w++) {
    const lift = levers.marketingWeekly > 0 && w >= levers.marketingStartWeek + levers.marketingLiftLagWeeks ? levers.marketingLiftPct : 0;
    volume.push(Math.max(0, (1 + levers.salesChangePct) * volumeFromPrice * (1 + lift)));
  }

  // Invoiced sales collect along the historical curve, shifted by any delay.
  // An early-payment discount moves the adopting share into the issue week at a discount.
  // (Flows are accumulated straight into per-week arrays: the plan search calls this hundreds of times.)
  const disc = levers.earlyPayDiscount;
  const adopt = disc ? Math.min(1, Math.max(0, disc.adoptionPct)) : 0;
  const newSales = new Array<number>(H).fill(0);
  const curve = inputs.collectionCurve;
  for (let w = 0; w < H; w++) {
    const invoiced = inputs.weeklyInvoicedSales * volume[w] * priceFactor;
    const pos = inputs.weeklyPosSales * volume[w] * priceFactor;
    rows[w].revenue += invoiced + pos;
    rows[w].inflows.pos += pos;
    if (adopt > 0 && disc) {
      addFractional(newSales, w + 1 + delayWeeks, invoiced * adopt * (1 - disc.discountPct)); // pays within ~10 days
      rows[w].revenue -= invoiced * adopt * disc.discountPct;
    }
    const normal = invoiced * (1 - adopt);
    if (normal) for (let k = 0; k < curve.length; k++) if (curve[k]) addFractional(newSales, w + k + delayWeeks, normal * curve[k]);
  }
  for (let w = 0; w < H; w++) rows[w].inflows.newSales += newSales[w];

  // --- Outflows ----------------------------------------------------------------
  for (const b of inputs.openAP) {
    const w = weekOf(asOf, b.dueDay);
    if (w < H) rows[w].outflows.openAP += b.amount;
  }
  for (const r of inputs.recurring) {
    for (let day = r.nextDay; day <= asOf + H * 7 + r.intervalDays; day += r.intervalDays) {
      if (day <= asOf - r.payLagDays) continue;
      const w = weekOf(asOf, day + r.payLagDays);
      if (w < H) rows[w].outflows.recurring += r.amount * costFactor;
    }
  }
  const varLagWeeks = (inputs.variableCostLagDays + levers.vendorTermsExtraDays) / 7;
  const variable = new Array<number>(H).fill(0);
  for (let w = 0; w < H; w++) {
    const baseVolumeSales = (inputs.weeklyInvoicedSales + inputs.weeklyPosSales) * volume[w];
    const varCost = baseVolumeSales * inputs.variableCostRatio * costFactor;
    rows[w].operatingCost += varCost;
    addFractional(variable, w + varLagWeeks, varCost);

    rows[w].outflows.payroll += inputs.weeklyPayroll;
    for (const h of levers.hires) if (w >= h.startWeek) rows[w].outflows.newHires += h.count * h.weeklyWage;
    rows[w].outflows.overhead += inputs.weeklyOverhead * costFactor;
    if (w >= levers.marketingStartWeek) rows[w].outflows.marketing += levers.marketingWeekly;
  }
  for (let w = 0; w < H; w++) rows[w].outflows.variable += variable[w];
  for (const d of levers.ownerDraws) if (d.week >= 0 && d.week < H) rows[d.week].outflows.ownerDraws += d.amount;
  for (const o of levers.oneTime) if (o.week >= 0 && o.week < H) rows[o.week].outflows.oneTime += o.amount;

  // --- Roll forward --------------------------------------------------------
  let cash = inputs.openingCash;
  for (const r of rows) {
    const o = r.outflows;
    // Accrual costs incurred this week (variable already added above).
    r.operatingCost += o.payroll + o.newHires + o.overhead + o.marketing;
    const inflow = r.inflows.openAR + r.inflows.newSales + r.inflows.pos + r.inflows.recovered;
    const outflow = o.payroll + o.newHires + o.recurring + o.openAP + o.variable + o.overhead + o.marketing + o.ownerDraws + o.oneTime;
    r.opening = Math.round(cash);
    r.net = Math.round(inflow - outflow);
    cash += inflow - outflow;
    r.closing = Math.round(cash);
  }
  // Recurring fixed costs are part of operating cost in the accrual view too.
  for (const r of rows) r.operatingCost += r.outflows.recurring;

  return { scenarioId, reserve, weeks: rows, summary: summarize(rows, reserve) };
}

export function summarize(rows: WeekRow[], reserve: number): ProjectionSummary {
  let minCash = Infinity;
  let minWeek = 0;
  let below = 0;
  let breach: number | null = null;
  let negative: number | null = null;
  let totalIn = 0;
  let totalOut = 0;
  let revenue = 0;
  let cost = 0;
  for (const r of rows) {
    if (r.closing < minCash) {
      minCash = r.closing;
      minWeek = r.week;
    }
    if (r.closing < reserve) {
      below++;
      if (breach === null) breach = r.week;
    }
    if (r.closing < 0 && negative === null) negative = r.week;
    const inflow = r.inflows.openAR + r.inflows.newSales + r.inflows.pos + r.inflows.recovered;
    totalIn += inflow;
    totalOut += inflow - r.net;
    revenue += r.revenue;
    cost += r.operatingCost;
  }
  const last = rows[rows.length - 1];
  return {
    endingCash: last ? last.closing : 0,
    minCash: rows.length ? minCash : 0,
    minWeek,
    weeksBelowReserve: below,
    firstBreachWeek: breach,
    firstNegativeWeek: negative,
    totalIn: Math.round(totalIn),
    totalOut: Math.round(totalOut),
    revenue: Math.round(revenue),
    operatingProfit: Math.round(revenue - cost),
    margin: revenue > 0 ? (revenue - cost) / revenue : null,
  };
}

export function projectScenario(inputs: ProjectionInputs, s: Scenario, reserve: number, horizonWeeks = DEFAULT_HORIZON_WEEKS): Projection {
  return project(inputs, s.levers, reserve, horizonWeeks, s.id);
}

export interface ScenarioDiff {
  scenarioId: string;
  vsId: string;
  endingCash: number;
  minCash: number;
  weeksBelowReserve: number;
  operatingProfit: number;
  margin: number | null;
}

export function diffProjections(a: Projection, base: Projection): ScenarioDiff {
  return {
    scenarioId: a.scenarioId,
    vsId: base.scenarioId,
    endingCash: a.summary.endingCash - base.summary.endingCash,
    minCash: a.summary.minCash - base.summary.minCash,
    weeksBelowReserve: a.summary.weeksBelowReserve - base.summary.weeksBelowReserve,
    operatingProfit: a.summary.operatingProfit - base.summary.operatingProfit,
    margin: a.summary.margin !== null && base.summary.margin !== null ? a.summary.margin - base.summary.margin : null,
  };
}

/** Reserve constraint check: does the plan keep closing cash at or above the reserve every week? */
export function checkReserve(p: Projection): { ok: boolean; firstBreachWeek: number | null; shortfall: number } {
  return {
    ok: p.summary.firstBreachWeek === null,
    firstBreachWeek: p.summary.firstBreachWeek,
    shortfall: Math.max(0, p.reserve - p.summary.minCash),
  };
}
