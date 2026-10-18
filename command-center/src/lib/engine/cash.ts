// Cash position, weekly cash history, categorized flows and runway.
import type { CompanyData } from "../data/types";

export function openingCash(data: CompanyData, asOf = data.asOfDay): { cash: number; sourceId: string | null } {
  let last: CompanyData["bank"][number] | null = null;
  for (const t of data.bank) if (t.day <= asOf && (!last || t.day >= last.day)) last = t;
  return { cash: last?.balance ?? 0, sourceId: last?.id ?? null };
}

/** Closing balance at the end of each of the last `weeks` weeks ending at asOf. */
export function weeklyCashHistory(data: CompanyData, weeks = 26, asOf = data.asOfDay): { endDay: number; closing: number }[] {
  const out: { endDay: number; closing: number }[] = [];
  const sorted = [...data.bank].sort((a, b) => a.day - b.day);
  for (let w = weeks - 1; w >= 0; w--) {
    const endDay = asOf - w * 7;
    let bal = 0;
    for (const t of sorted) {
      if (t.day > endDay) break;
      bal = t.balance;
    }
    out.push({ endDay, closing: bal });
  }
  return out;
}

export type FlowCategory =
  | "collections"
  | "deposits"
  | "payroll"
  | "supplier_payments"
  | "owner_draws"
  | "financing"
  | "tax"
  | "other";

export function categorize(kind: string, billCategory?: string): FlowCategory {
  switch (kind) {
    case "customer_payment":
    case "sales_receipt":
    case "card_settlement":
      return "collections";
    case "deposit_receipt":
      return "deposits";
    case "wage_payment":
      return "payroll";
    case "owner_distribution":
      return "owner_draws";
    case "financing":
      return "financing";
    case "bill_payment":
      return billCategory === "income_tax" ? "tax" : "supplier_payments";
    default:
      return "other";
  }
}

/** Sum of bank flows by category over (from, to]. */
export function flowsByCategory(data: CompanyData, from: number, to: number): Record<FlowCategory, number> {
  const billCat = new Map(data.bills.map((b) => [b.id, b.category]));
  const payCat = new Map<string, string>();
  for (const p of data.billPayments) payCat.set(p.id, billCat.get(p.apps[0]?.docId ?? "") ?? "");
  const out: Record<FlowCategory, number> = {
    collections: 0, deposits: 0, payroll: 0, supplier_payments: 0, owner_draws: 0, financing: 0, tax: 0, other: 0,
  };
  for (const t of data.bank) {
    if (t.day <= from || t.day > to || t.kind === "opening_equity") continue;
    out[categorize(t.kind, payCat.get(t.source))] += t.amount;
  }
  return out;
}

export interface Runway {
  cash: number;
  weeklyOperatingNet: number; // trailing average, excludes owner draws and financing
  weeks: number | null; // null = cash-generative (no burn)
  windowWeeks: number;
}

/** Runway from trailing operating cash flow. Owner draws and financing are excluded. */
export function runway(data: CompanyData, asOf = data.asOfDay, windowWeeks = 13): Runway {
  const { cash } = openingCash(data, asOf);
  const f = flowsByCategory(data, asOf - windowWeeks * 7, asOf);
  const net = f.collections + f.deposits + f.payroll + f.supplier_payments + f.tax + f.other;
  return runwayFrom(cash, Math.round(net / windowWeeks), windowWeeks);
}

export function runwayFrom(cash: number, weeklyOperatingNet: number, windowWeeks = 13): Runway {
  let weeks: number | null;
  if (weeklyOperatingNet >= 0) weeks = null;
  else if (cash <= 0) weeks = 0;
  else weeks = cash / -weeklyOperatingNet;
  return { cash, weeklyOperatingNet, weeks, windowWeeks };
}
