import { describe, expect, it } from "vitest";
import type { Invoice } from "../src/lib/data/types";
import { loadCompany } from "../src/lib/data/load";
import { profitVsCash, topDebtors } from "../src/lib/engine/accountant";
import { buildInputs } from "../src/lib/engine/baseline";
import { openingCash, runway, runwayFrom, weeklyCashHistory } from "../src/lib/engine/cash";
import { duplicateFindings, investigate, overdueFindings } from "../src/lib/engine/detective";
import { profitLeaks } from "../src/lib/engine/margin";
import type { Levers, ProjectionInputs } from "../src/lib/engine/model";
import { NO_LEVERS } from "../src/lib/engine/model";
import { compareTermOptions } from "../src/lib/engine/negotiation";
import { openBills } from "../src/lib/engine/payables";
import { searchSafestPlan } from "../src/lib/engine/plan";
import { checkReserve, diffProjections, project, weekOf } from "../src/lib/engine/projection";
import {
  agingBuckets,
  bucketFor,
  collectionCurve,
  effectiveDue,
  expectedCollections,
  openReceivables,
  paymentBehavior,
} from "../src/lib/engine/receivables";
import { detectRecurring, payrollPicture } from "../src/lib/engine/recurring";
import { breakingPoints, firstBreakingCombo, stressGrid } from "../src/lib/engine/stress";
import { onTimePaymentCounterfactual } from "../src/lib/engine/timemachine";
import { bank, emptyCompany } from "./fixtures";

const inv = (o: Partial<Invoice> & { id: string }): Invoice => ({
  customerId: "c1",
  day: 300,
  due: 330,
  total: 100_000,
  retainage: 0,
  deposit: 0,
  projectId: null,
  item: "Widget",
  estCost: null,
  ...o,
});

function inputs(o: Partial<ProjectionInputs> = {}): ProjectionInputs {
  return {
    companyId: "t",
    companyName: "T",
    openingDate: "2025-10-06",
    asOfDay: 365,
    openingCash: 100_000_00,
    openingCashSource: null,
    openAR: [],
    openAP: [],
    weeklyInvoicedSales: 0,
    weeklyPosSales: 0,
    collectionCurve: [0, 1],
    uncollectedShare: 0,
    variableCostRatio: 0,
    variableCostLagDays: 0,
    weeklyPayroll: 0,
    medianWeeklyWage: 100_000,
    recurring: [],
    weeklyOverhead: 0,
    weeklyMarketingHistorical: 0,
    defaultReserve: 0,
    history: [],
    trailingWeeks: 13,
    ...o,
  };
}

describe("cash and runway", () => {
  it("opening cash is the last bank balance on or before asOf", () => {
    const d = emptyCompany({ bank: [bank(1, 500, 500), bank(10, -200, 300), bank(400, 50, 350)] });
    expect(openingCash(d).cash).toBe(300);
  });

  it("zero cash: no bank activity gives zero cash and zero runway when burning", () => {
    const d = emptyCompany();
    expect(openingCash(d).cash).toBe(0);
    expect(runwayFrom(0, -1000).weeks).toBe(0);
  });

  it("negative runway inputs: negative cash with burn reports zero weeks, never negative", () => {
    expect(runwayFrom(-5000, -1000).weeks).toBe(0);
  });

  it("cash-generative business has no runway limit", () => {
    expect(runwayFrom(10_000, 500).weeks).toBeNull();
  });

  it("runway divides cash by trailing weekly operating burn", () => {
    const d = emptyCompany({
      bank: [bank(0, 13_000_00, 13_000_00, "opening_equity"), ...Array.from({ length: 13 }, (_, i) => bank(365 - i * 7, -1000_00, 13_000_00 - (i + 1) * 1000_00, "wage_payment", `w${i}`))],
    });
    // Balances in fixture are illustrative; runway uses the last balance and the flows.
    const r = runway(d);
    expect(r.weeklyOperatingNet).toBe(-1000_00);
    expect(r.weeks).toBeCloseTo(r.cash / 1000_00, 5);
  });

  it("owner draws are excluded from runway burn", () => {
    const d = emptyCompany({ bank: [bank(0, 50_000, 50_000, "opening_equity"), bank(360, -40_000, 10_000, "owner_distribution")] });
    expect(runway(d).weeks).toBeNull();
  });

  it("weekly history returns one point per week ending at asOf", () => {
    const d = emptyCompany({ bank: [bank(0, 100, 100), bank(364, 50, 150)] });
    const h = weeklyCashHistory(d, 4);
    expect(h).toHaveLength(4);
    expect(h[3]).toEqual({ endDay: 365, closing: 150 });
  });
});

describe("receivables", () => {
  const customers = [{ id: "c1", name: "Acme", termsDays: 15, creditLimit: 0, email: "", ended: null }];

  it("buckets by days past due", () => {
    expect(bucketFor(0)).toBe("current");
    expect(bucketFor(1)).toBe("1-30");
    expect(bucketFor(45)).toBe("31-60");
    expect(bucketFor(75)).toBe("61-90");
    expect(bucketFor(91)).toBe("90+");
  });

  it("invoice with no due date falls back to the customer's terms", () => {
    const i = inv({ id: "i1", day: 340, due: null });
    expect(effectiveDue(i, customers[0])).toBe(355);
    expect(effectiveDue(i, undefined)).toBe(370); // default 30 days
    const d = emptyCompany({ customers, invoices: [i] });
    const open = openReceivables(d);
    expect(open[0].dueWasMissing).toBe(true);
    expect(open[0].daysPastDue).toBe(10);
  });

  it("partial payments, write-offs and retainage reduce the open receivable", () => {
    const d = emptyCompany({
      customers,
      invoices: [inv({ id: "i1", total: 1000, retainage: 100 }), inv({ id: "i2", total: 500 })],
      customerPayments: [
        { id: "p1", customerId: "c1", day: 340, amount: 300, settles: "receivable", apps: [{ docId: "i1", amount: 300 }] },
        { id: "p2", customerId: "c1", day: 341, amount: 100, settles: "retainage", apps: [{ docId: "i1", amount: 100 }] },
      ],
      journal: [{ id: "j1", purpose: "bad_debt", day: 350, amount: 500, memo: "", customerId: "c1", documentId: "i2" }],
    });
    const open = openReceivables(d);
    expect(open).toHaveLength(1);
    expect(open[0].open).toBe(600);
    expect(agingBuckets(open).overdue).toBe(600);
  });

  it("payments after asOf are ignored", () => {
    const d = emptyCompany({
      customers,
      invoices: [inv({ id: "i1" })],
      customerPayments: [{ id: "p1", customerId: "c1", day: 366, amount: 100_000, settles: "receivable", apps: [{ docId: "i1", amount: 100_000 }] }],
    });
    expect(openReceivables(d)).toHaveLength(1);
  });

  it("payment behaviour uses settled invoices only", () => {
    const d = emptyCompany({
      customers,
      invoices: [inv({ id: "i1", due: 100 }), inv({ id: "i2", due: 200 }), inv({ id: "i3", due: 300 })],
      customerPayments: [
        { id: "p1", customerId: "c1", day: 110, amount: 100_000, settles: "receivable", apps: [{ docId: "i1", amount: 100_000 }] },
        { id: "p2", customerId: "c1", day: 220, amount: 100_000, settles: "receivable", apps: [{ docId: "i2", amount: 100_000 }] },
      ],
    });
    const b = paymentBehavior(d).byCustomer.get("c1")!;
    expect(b.paidInvoices).toBe(2);
    expect(b.medianDaysLate).toBe(15);
    expect(b.lateShare).toBe(1);
  });

  it("expected collections: pattern, beyond-pattern and severely overdue rules", () => {
    const d = emptyCompany({
      customers,
      invoices: [
        inv({ id: "old1", day: 10, due: 20 }),
        inv({ id: "old2", day: 30, due: 40 }),
        inv({ id: "fresh", day: 360, due: 375 }),
        inv({ id: "late", day: 300, due: 340 }),
        inv({ id: "ancient", day: 200, due: 210 }),
      ],
      customerPayments: [
        { id: "p1", customerId: "c1", day: 30, amount: 100_000, settles: "receivable", apps: [{ docId: "old1", amount: 100_000 }] },
        { id: "p2", customerId: "c1", day: 50, amount: 100_000, settles: "receivable", apps: [{ docId: "old2", amount: 100_000 }] },
      ],
    });
    const e = new Map(expectedCollections(d).map((x) => [x.invoiceId, x]));
    expect(e.get("fresh")).toMatchObject({ rule: "customer_pattern", expectedDay: 385, atRisk: false });
    expect(e.get("late")).toMatchObject({ rule: "overdue_beyond_pattern", expectedDay: 379 });
    expect(e.get("ancient")).toMatchObject({ rule: "severely_overdue", atRisk: true });
  });

  it("collection curve sums with uncollected share to 1", () => {
    const d = loadCompany("company-002");
    const c = collectionCurve(d);
    const total = c.weekly.reduce((s, x) => s + x, 0) + c.uncollected;
    expect(total).toBeCloseTo(1, 6);
    expect(c.sampleInvoices).toBeGreaterThan(100);
  });
});

describe("payables, recurring and payroll", () => {
  it("open bills subtract payments up to asOf", () => {
    const d = emptyCompany({
      vendors: [{ id: "v1", name: "Landlord", role: "premises", termsDays: 0 }],
      bills: [{ id: "b1", vendorId: "v1", kind: "operating", category: "premises", day: 360, due: 367, total: 1000, projectId: null, memo: "" }],
      billPayments: [{ id: "bp1", vendorId: "v1", day: 362, amount: 400, apps: [{ docId: "b1", amount: 400 }] }],
    });
    expect(openBills(d)).toMatchObject([{ id: "b1", open: 600, daysPastDue: -2 }]);
  });

  it("detects a fixed weekly bill and ignores a stopped one", () => {
    const weekly = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, vendorId: "v1", kind: "operating", category: "premises", day: 300 + i * 7, due: 300 + i * 7, total: 50_000, projectId: null, memo: "" }));
    const stopped = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, vendorId: "v2", kind: "operating", category: "software", day: 10 + i * 30, due: 10 + i * 30, total: 9_900, projectId: null, memo: "" }));
    const d = emptyCompany({ vendors: [{ id: "v1", name: "Landlord", role: "premises", termsDays: 0 }], bills: [...weekly, ...stopped] });
    const r = detectRecurring(d);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ cadence: "weekly", amount: 50_000, fixed: true, nextDay: 300 + 9 * 7 + 7 });
  });

  it("payroll counts only employees active at asOf", () => {
    const d = emptyCompany({
      employees: [
        { id: "e1", name: "A", title: "x", weeklyWage: 100_000, hired: 0, released: null },
        { id: "e2", name: "B", title: "x", weeklyWage: 80_000, hired: 0, released: 200 },
        { id: "e3", name: "C", title: "x", weeklyWage: 90_000, hired: 400, released: null },
      ],
    });
    const p = payrollPicture(d);
    expect(p.weeklyPayroll).toBe(100_000);
    expect(p.activeEmployees.map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("projection", () => {
  it("week 0 covers the 7 days after asOf; past days land in week 0", () => {
    expect(weekOf(365, 366)).toBe(0);
    expect(weekOf(365, 372)).toBe(0);
    expect(weekOf(365, 373)).toBe(1);
    expect(weekOf(365, 100)).toBe(0);
  });

  it("flat business: cash rolls forward exactly", () => {
    const p = project(inputs({ openingCash: 10_000, weeklyPayroll: 1_000 }), NO_LEVERS, 0, 4);
    expect(p.weeks.map((w) => w.closing)).toEqual([9_000, 8_000, 7_000, 6_000]);
    expect(p.summary).toMatchObject({ endingCash: 6_000, minCash: 6_000, minWeek: 3, totalOut: 4_000 });
  });

  it("zero cash and zero activity stays at zero, never breaching a zero reserve", () => {
    const p = project(inputs({ openingCash: 0 }), NO_LEVERS, 0, 13);
    expect(p.summary.endingCash).toBe(0);
    expect(checkReserve(p).ok).toBe(true);
  });

  it("a scenario that breaches the reserve on day 1 is flagged in week 0", () => {
    const levers: Levers = { ...NO_LEVERS, ownerDraws: [{ amount: 9_500, week: 0 }] };
    const p = project(inputs({ openingCash: 10_000 }), levers, 5_000, 13);
    expect(p.summary.firstBreachWeek).toBe(0);
    expect(p.summary.weeksBelowReserve).toBe(13);
    expect(checkReserve(p)).toMatchObject({ ok: false, firstBreachWeek: 0, shortfall: 4_500 });
  });

  it("negative cash is reported with its first week", () => {
    const p = project(inputs({ openingCash: 2_500, weeklyPayroll: 1_000 }), NO_LEVERS, 0, 5);
    expect(p.summary.firstNegativeWeek).toBe(2);
    expect(p.summary.minCash).toBe(-2_500);
  });

  it("open receivables and payables land in their weeks; payment delay shifts receivables", () => {
    const base = inputs({
      openingCash: 0,
      openAR: [{ invoiceId: "i", customerId: "c", customerName: "C", amount: 700, expectedDay: 368, daysPastDue: -3, atRisk: false }],
      openAP: [{ billId: "b", vendorName: "V", category: "x", amount: 300, dueDay: 380 }],
    });
    const p = project(base, NO_LEVERS, 0, 4);
    expect(p.weeks[0].inflows.openAR).toBe(700);
    expect(p.weeks[2].outflows.openAP).toBe(300);
    const late = project(base, { ...NO_LEVERS, paymentDelayDays: 14 }, 0, 4);
    expect(late.weeks[0].inflows.openAR).toBe(0);
    expect(late.weeks[2].inflows.openAR).toBe(700);
  });

  it("at-risk receivables are excluded unless included; collection drive recovers a share", () => {
    const base = inputs({
      openingCash: 0,
      openAR: [{ invoiceId: "i", customerId: "c", customerName: "C", amount: 1_000, expectedDay: 379, daysPastDue: 120, atRisk: true }],
    });
    expect(project(base, NO_LEVERS, 0, 4).summary.totalIn).toBe(0);
    expect(project(base, { ...NO_LEVERS, includeAtRisk: true }, 0, 4).summary.totalIn).toBe(1_000);
    const drive = project(base, { ...NO_LEVERS, collectOverdue: { recoveryPct: 0.5, withinDays: 7 } }, 0, 4);
    expect(drive.weeks[0].inflows.recovered).toBe(500);
    expect(drive.summary.totalIn).toBe(500);
  });

  it("new sales collect along the curve and variable costs follow volume", () => {
    const base = inputs({ openingCash: 0, weeklyInvoicedSales: 1_000, collectionCurve: [0, 1], variableCostRatio: 0.5 });
    const p = project(base, NO_LEVERS, 0, 3);
    expect(p.weeks.map((w) => Math.round(w.inflows.newSales))).toEqual([0, 1_000, 1_000]);
    expect(p.weeks.map((w) => Math.round(w.outflows.variable))).toEqual([500, 500, 500]);
    const down = project(base, { ...NO_LEVERS, salesChangePct: -0.2 }, 0, 3);
    expect(Math.round(down.weeks[1].inflows.newSales)).toBe(800);
    expect(Math.round(down.weeks[1].outflows.variable)).toBe(400);
  });

  it("hires start in their week; recurring costs follow cadence with cost shock", () => {
    const base = inputs({
      openingCash: 0,
      recurring: [{ key: "k", vendorName: "L", category: "premises", amount: 1_000, intervalDays: 14, nextDay: 367, payLagDays: 0, billIds: [] }],
    });
    const levers: Levers = { ...NO_LEVERS, hires: [{ count: 2, weeklyWage: 100, startWeek: 1 }], costShockPct: 0.1 };
    const p = project(base, levers, 0, 4);
    expect(p.weeks.map((w) => w.outflows.newHires)).toEqual([0, 200, 200, 200]);
    expect(p.weeks.map((w) => Math.round(w.outflows.recurring))).toEqual([1_100, 0, 1_100, 0]);
  });

  it("price change raises revenue but not unit costs; elasticity cuts volume", () => {
    const base = inputs({ openingCash: 0, weeklyPosSales: 1_000, variableCostRatio: 0.5 });
    const p = project(base, { ...NO_LEVERS, priceChangePct: 0.1, priceElasticity: -1 }, 0, 1);
    expect(Math.round(p.weeks[0].inflows.pos)).toBe(990); // 0.9 volume x 1.1 price
    expect(Math.round(p.weeks[0].outflows.variable)).toBe(450);
  });

  it("scenario diff subtracts summaries", () => {
    const base = inputs({ openingCash: 10_000 });
    const a = project(base, { ...NO_LEVERS, ownerDraws: [{ amount: 1_000, week: 2 }] }, 0, 4, "a");
    const b = project(base, NO_LEVERS, 0, 4, "b");
    expect(diffProjections(a, b)).toMatchObject({ endingCash: -1_000, minCash: -1_000, scenarioId: "a", vsId: "b" });
  });

  it("owner draws are cash, not operating cost (profit unchanged)", () => {
    const base = inputs({ openingCash: 10_000, weeklyPosSales: 1_000 });
    const a = project(base, { ...NO_LEVERS, ownerDraws: [{ amount: 5_000, week: 1 }] }, 0, 4);
    const b = project(base, NO_LEVERS, 0, 4);
    expect(a.summary.operatingProfit).toBe(b.summary.operatingProfit);
    expect(a.summary.endingCash).toBe(b.summary.endingCash - 5_000);
  });
});

describe("stress and planning", () => {
  const base = inputs({ openingCash: 20_000, weeklyInvoicedSales: 5_000, collectionCurve: [0, 0, 1], weeklyPayroll: 3_000, variableCostRatio: 0.3 });

  it("stress grid covers every combination and is monotone in payment delay", () => {
    const cells = stressGrid(base, NO_LEVERS, 10_000);
    expect(cells).toHaveLength(4 * 4 * 3);
    const byDelay = cells.filter((c) => c.salesDecline === 0 && c.costShock === 0).map((c) => c.minCash);
    for (let i = 1; i < byDelay.length; i++) expect(byDelay[i]).toBeLessThanOrEqual(byDelay[i - 1]);
  });

  it("breaking points find the smallest breaching shock per axis", () => {
    const bp = breakingPoints(base, NO_LEVERS, 10_000);
    const delay = bp.find((b) => b.axis === "paymentDelayDays")!;
    expect(delay.breaksReserveAt).not.toBeNull();
    const at = delay.breaksReserveAt!;
    if (at > 0) {
      const before = project(base, { ...NO_LEVERS, paymentDelayDays: at - 5 }, 10_000);
      expect(before.summary.firstBreachWeek).toBeNull();
    }
    expect(firstBreakingCombo(stressGrid(base, NO_LEVERS, 10_000))?.breachesReserve).toBe(true);
  });

  it("safest plan stays feasible and never delivers more than requested", () => {
    const r = searchSafestPlan(
      base,
      { hires: { count: 2, weeklyWage: 1_000 }, marketingWeekly: 500, ownerDraw: 8_000 },
      { reserve: 5_000, horizonWeeks: 13, stressDelayDays: 14, collectOverdue: null, vendorTermsAskDays: 0, marketingLiftPct: 0, priceElasticity: -1 },
    );
    const rec = r.candidates.find((c) => c.levers === r.recommended.levers)!;
    if (r.recommendedFeasible) {
      expect(rec.baseMin).toBeGreaterThanOrEqual(5_000);
      expect(rec.stressMin).toBeGreaterThanOrEqual(0);
    }
    const hires = r.recommended.levers.hires.reduce((s, h) => s + h.count, 0);
    expect(hires).toBeLessThanOrEqual(2);
    const draw = r.recommended.levers.ownerDraws.reduce((s, d) => s + d.amount, 0);
    expect(draw).toBeLessThanOrEqual(8_000);
  });

  it("when nothing is feasible the plan maximises stressed minimum cash", () => {
    const tiny = inputs({ openingCash: 1_000, weeklyPayroll: 2_000 });
    const r = searchSafestPlan(
      tiny,
      { hires: { count: 1, weeklyWage: 500 }, marketingWeekly: null, ownerDraw: 500 },
      { reserve: 5_000, horizonWeeks: 13, stressDelayDays: 30, collectOverdue: null, vendorTermsAskDays: 0, marketingLiftPct: 0, priceElasticity: -1 },
    );
    expect(r.recommendedFeasible).toBe(false);
    const maxStress = Math.max(...r.candidates.map((c) => c.stressMin));
    expect(r.candidates.find((c) => c.levers === r.recommended.levers)!.stressMin).toBe(maxStress);
    expect(r.recommended.levers.hires).toEqual([]);
  });
});

describe("capabilities on real data (demo company)", () => {
  const d = loadCompany("company-002");

  it("baseline inputs are internally consistent", () => {
    const i = buildInputs(d);
    expect(i.openingCash).toBe(openingCash(d).cash);
    expect(i.openAR.reduce((s, a) => s + a.amount, 0)).toBe(agingBuckets(openReceivables(d)).total);
    expect(i.weeklyPayroll).toBe(525_000);
    expect(i.defaultReserve % 100_000).toBe(0);
  });

  it("detective flags the overdue receivables as verified, patterns as hypotheses", () => {
    const f = overdueFindings(d);
    const b = d.arAging.buckets;
    const overdue = b["1-30"] + b["31-60"] + b["61-90"] + b["90+"];
    expect(f[0]).toMatchObject({ id: "overdue-total", status: "verified", amount: overdue });
    expect(f.filter((x) => x.id !== "overdue-total").every((x) => x.status === "hypothesis")).toBe(true);
    expect(investigate(d).length).toBeGreaterThan(0);
  });

  it("planted duplicate bill is detected", () => {
    const b = d.bills.find((x) => x.category === "purchase")!;
    const planted = { ...d, bills: [...d.bills, { ...b, id: "planted-dup", day: b.day + 1 }] };
    expect(duplicateFindings(planted).some((f) => f.sources.some((s) => s.id === "planted-dup"))).toBe(true);
    expect(duplicateFindings(d).some((f) => f.sources.some((s) => s.id === "planted-dup"))).toBe(false);
  });

  it("profit vs cash bridge reconciles exactly", () => {
    const a = profitVsCash(d);
    const change = a.facts.find((f) => f.key === "cash_change")!.value;
    const bridge = a.facts.find((f) => f.key === "bridge_check")!.value;
    expect(bridge).toBe(change);
  });

  it("top debtors total matches receivables", () => {
    const a = topDebtors(d);
    expect(a.facts.find((f) => f.key === "ar_total")!.value).toBe(d.arAging.total);
  });

  it("profit leaks are ranked by score", () => {
    const l = profitLeaks(d);
    for (let i = 1; i < l.length; i++) expect(l[i].score).toBeLessThanOrEqual(l[i - 1].score);
  });

  it("on-time counterfactual moves only late payments and never lowers the minimum", () => {
    const cf = onTimePaymentCounterfactual(d, null);
    expect(cf.paymentsMoved).toBeGreaterThan(0);
    expect(cf.counterfactualMin.cash).toBeGreaterThanOrEqual(cf.historicalMin.cash);
    expect(cf.weekly.at(-1)!.historical).toBe(cf.weekly.at(-1)!.counterfactual);
  });

  it("negotiation options label their behaviour assumptions", () => {
    const i = buildInputs(d);
    const o = compareTermOptions(i, NO_LEVERS, i.defaultReserve, 13);
    expect(o.length).toBe(3);
    for (const x of o) expect(x.behaviorAssumption).toMatch(/Assumes/);
    expect(o.find((x) => x.id === "vendor-terms")!.minCashDelta).toBeGreaterThanOrEqual(0);
  });
});
