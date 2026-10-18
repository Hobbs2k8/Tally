// Derives ProjectionInputs (the drivers of the cash model) from the books.
import type { CompanyData } from "../data/types";
import { openingCash, weeklyCashHistory } from "./cash";
import type { ProjectionInputs } from "./model";
import { openBills } from "./payables";
import { collectionCurve, expectedCollections, openReceivables, receivablePart } from "./receivables";
import { detectRecurring, payrollPicture } from "./recurring";

export const TRAILING_WEEKS = 13;
export const RESERVE_WEEKS = 4;

/** Costs that scale with sales volume. */
export const VARIABLE_CATEGORIES = new Set([
  "purchase",
  "materials",
  "freight",
  "subcontract",
  "variable_services",
  "supplies",
  "practice_supplies",
  "project_equipment_rental",
  "project_owned_equipment",
  "program_services",
  "event_costs",
  "estimating_service",
]);
/** One-off or annual items that would distort a weekly run-rate unless they recur. */
export const LUMPY_CATEGORIES = new Set(["income_tax", "permit", "equipment", "owned_equipment"]);
export const MARKETING_CATEGORIES = new Set(["growth", "outreach"]);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function buildInputs(data: CompanyData, asOf = data.asOfDay): ProjectionInputs {
  const from = asOf - TRAILING_WEEKS * 7;
  const cash = openingCash(data, asOf);
  const open = openReceivables(data, asOf);
  const daysPastDue = new Map(open.map((o) => [o.id, o.daysPastDue]));
  const names = new Map(open.map((o) => [o.id, o.customerName]));
  const ar = expectedCollections(data, asOf).map((e) => ({
    invoiceId: e.invoiceId,
    customerId: e.customerId,
    customerName: names.get(e.invoiceId) ?? e.customerId,
    amount: e.amount,
    expectedDay: e.expectedDay,
    daysPastDue: daysPastDue.get(e.invoiceId) ?? 0,
    atRisk: e.atRisk,
  }));
  const ap = openBills(data, asOf).map((b) => ({
    billId: b.id,
    vendorName: b.vendorName,
    category: b.category,
    amount: b.open,
    dueDay: b.due,
  }));

  const recurring = detectRecurring(data, asOf);
  const fixed = recurring.filter((r) => r.fixed);
  const fixedKeys = new Set(fixed.map((r) => r.key));

  let invoiced = 0;
  for (const i of data.invoices) if (i.day > from && i.day <= asOf) invoiced += receivablePart(i);
  let pos = 0;
  for (const s of data.salesReceipts) if (s.day > from && s.day <= asOf) pos += s.total;

  let variable = 0;
  let overhead = 0;
  let marketing = 0;
  const variableLags: number[] = [];
  for (const b of data.bills) {
    if (b.day <= from || b.day > asOf) continue;
    if (fixedKeys.has(`${b.vendorId}|${b.category}`)) continue;
    if (b.kind === "product" || VARIABLE_CATEGORIES.has(b.category)) {
      variable += b.total;
      variableLags.push(b.due - b.day);
    } else if (!LUMPY_CATEGORIES.has(b.category)) {
      overhead += b.total;
      if (MARKETING_CATEGORIES.has(b.category)) marketing += b.total;
    }
  }
  const sales = invoiced + pos;
  const payroll = payrollPicture(data, asOf);
  const curve = collectionCurve(data, asOf);
  const weeklyFixed = fixed.reduce((s, r) => s + (r.amount * 7) / r.intervalDays, 0);
  const weeklyOverhead = Math.round(overhead / TRAILING_WEEKS);
  const reserveRaw = RESERVE_WEEKS * (payroll.weeklyPayroll + weeklyFixed + weeklyOverhead);

  return {
    companyId: data.id,
    companyName: data.name,
    openingDate: data.openingDate,
    asOfDay: asOf,
    openingCash: cash.cash,
    openingCashSource: cash.sourceId,
    openAR: ar,
    openAP: ap,
    weeklyInvoicedSales: Math.round(invoiced / TRAILING_WEEKS),
    weeklyPosSales: Math.round(pos / TRAILING_WEEKS),
    collectionCurve: curve.weekly,
    uncollectedShare: curve.uncollected,
    variableCostRatio: sales > 0 ? variable / sales : 0,
    variableCostLagDays: Math.round(median(variableLags)),
    weeklyPayroll: payroll.weeklyPayroll,
    medianWeeklyWage: payroll.medianWeeklyWage,
    recurring: fixed.map((r) => ({
      key: r.key,
      vendorName: r.vendorName,
      category: r.category,
      amount: r.amount,
      intervalDays: r.intervalDays,
      nextDay: r.nextDay,
      payLagDays: r.payLagDays,
      billIds: r.billIds.slice(-6),
    })),
    weeklyOverhead,
    weeklyMarketingHistorical: Math.round(marketing / TRAILING_WEEKS),
    defaultReserve: Math.max(0, Math.round(reserveRaw / 100_000) * 100_000),
    history: weeklyCashHistory(data, 26, asOf),
    trailingWeeks: TRAILING_WEEKS,
  };
}
