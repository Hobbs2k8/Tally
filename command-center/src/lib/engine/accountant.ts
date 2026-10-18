// Future Accountant: evidence-grounded answers computed from the books.
// Each answer returns facts (with sources) that an explanation may cite.
import type { CompanyData } from "../data/types";
import { dayToDate } from "../data/types";
import { flowsByCategory, openingCash } from "./cash";
import { openBills } from "./payables";
import { agingBuckets, openReceivables, paymentBehavior } from "./receivables";

export interface Fact {
  key: string;
  label: string;
  value: number; // cents unless unit says otherwise
  unit: "usd" | "days" | "pct" | "count";
  source: string; // record id, report name, or "calculated: ..."
}

export interface Answer {
  kind: string;
  headline: string;
  facts: Fact[];
  table?: { columns: string[]; rows: (string | number)[][] };
}

/** Why profit and cash differ: an exact bridge from the balance sheet (books open with cash only). */
export function profitVsCash(data: CompanyData): Answer {
  const bs = data.balanceSheet.end;
  const opening = data.journal.find((j) => j.purpose === "opening_equity")?.amount ?? 0;
  const endCash = openingCash(data).cash;
  const profit = data.pnl.full.net;
  const nonCash = bs.lines.filter((l) => l.section === "Assets" && l.accountId !== "acct-checking");
  const liabilities = bs.lines.filter((l) => l.section === "Liabilities");
  const draws = bs.lines.find((l) => l.accountId === "acct-owner-distributions")?.amount ?? 0;
  const otherEquity = bs.lines.filter((l) => l.section === "Equity" && !["acct-opening-equity", "acct-owner-distributions", "retained-earnings"].includes(l.accountId));
  const facts: Fact[] = [
    { key: "profit", label: "Net profit for the year", value: profit, unit: "usd", source: "report:profit_and_loss" },
    ...nonCash.map((l) => ({ key: `asset:${l.accountId}`, label: `Cash tied up in ${l.name}`, value: -l.amount, unit: "usd" as const, source: `balance_sheet:${l.accountId}` })),
    ...liabilities.map((l) => ({ key: `liab:${l.accountId}`, label: `Not yet paid: ${l.name}`, value: l.amount, unit: "usd" as const, source: `balance_sheet:${l.accountId}` })),
    ...(draws ? [{ key: "draws", label: "Owner distributions taken", value: draws, unit: "usd" as const, source: "balance_sheet:acct-owner-distributions" }] : []),
    ...otherEquity.map((l) => ({ key: `eq:${l.accountId}`, label: l.name, value: l.amount, unit: "usd" as const, source: `balance_sheet:${l.accountId}` })),
  ];
  const bridge = facts.reduce((s, f) => s + f.value, 0);
  facts.push({ key: "cash_change", label: "Change in cash over the year", value: endCash - opening, unit: "usd", source: `calculated: ending cash ${data.bank.at(-1)?.id} minus opening contribution` });
  facts.push({ key: "bridge_check", label: "Bridge total (should equal change in cash)", value: bridge, unit: "usd", source: "calculated: sum of the lines above" });
  const biggest = facts.filter((f) => f.key !== "profit" && !["cash_change", "bridge_check"].includes(f.key)).sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
  return {
    kind: "profit_vs_cash",
    headline: `Profit was ${fmt(profit)} but cash changed by ${fmt(endCash - opening)}. The biggest gap: ${biggest?.label.toLowerCase() ?? "n/a"} (${fmt(biggest?.value ?? 0)}).`,
    facts,
  };
}

export function topDebtors(data: CompanyData, n = 8): Answer {
  const open = openReceivables(data);
  const beh = paymentBehavior(data);
  const by = new Map<string, { name: string; open: number; overdue: number; oldest: number; ids: string[] }>();
  for (const o of open) {
    const r = by.get(o.customerId) ?? { name: o.customerName, open: 0, overdue: 0, oldest: 0, ids: [] };
    r.open += o.open;
    if (o.daysPastDue > 0) r.overdue += o.open;
    r.oldest = Math.max(r.oldest, o.daysPastDue);
    r.ids.push(o.id);
    by.set(o.customerId, r);
  }
  const rows = [...by.entries()].sort((a, b) => b[1].open - a[1].open).slice(0, n);
  const aging = agingBuckets(open);
  return {
    kind: "top_debtors",
    headline: rows.length
      ? `${rows[0][1].name} owes the most (${fmt(rows[0][1].open)}). ${fmt(aging.overdue)} of ${fmt(aging.total)} outstanding is overdue.`
      : "No customer owes you anything right now.",
    facts: [
      { key: "ar_total", label: "Total receivables", value: aging.total, unit: "usd", source: "report:ar_aging" },
      { key: "ar_overdue", label: "Overdue receivables", value: aging.overdue, unit: "usd", source: "calculated: open invoices past due" },
      ...rows.map(([id, r]) => ({ key: `debtor:${id}`, label: `${r.name} owes`, value: r.open, unit: "usd" as const, source: r.ids.slice(0, 5).join(",") })),
    ],
    table: {
      columns: ["Customer", "Owes", "Overdue", "Oldest (days past due)", "Usual lateness (days)"],
      rows: rows.map(([id, r]) => [r.name, fmt(r.open), fmt(r.overdue), Math.max(0, r.oldest), beh.byCustomer.get(id)?.medianDaysLate ?? 0]),
    },
  };
}

export function topExpenses(data: CompanyData, days = 91): Answer {
  const from = data.asOfDay - days;
  const vendors = new Map(data.vendors.map((v) => [v.id, v.name]));
  const by = new Map<string, { total: number; ids: string[] }>();
  for (const b of data.bills) {
    if (b.day <= from || b.day > data.asOfDay) continue;
    const k = `${vendors.get(b.vendorId) ?? b.vendorId} · ${b.category.replace(/_/g, " ")}`;
    const r = by.get(k) ?? { total: 0, ids: [] };
    r.total += b.total;
    r.ids.push(b.id);
    by.set(k, r);
  }
  const f = flowsByCategory(data, from, data.asOfDay);
  const rows = [...by.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 8);
  return {
    kind: "top_expenses",
    headline: rows.length ? `Your largest cost over the last 13 weeks is ${rows[0][0]} (${fmt(rows[0][1].total)}); payroll paid was ${fmt(-f.payroll)}.` : "No bills in the last 13 weeks.",
    facts: [
      { key: "payroll_13w", label: "Payroll paid, last 13 weeks", value: -f.payroll, unit: "usd", source: "bank:wage_payment" },
      ...rows.map(([k, r]) => ({ key: `exp:${k}`, label: k, value: r.total, unit: "usd" as const, source: r.ids.slice(0, 5).join(",") })),
    ],
    table: { columns: ["Vendor · category", "Billed (13 weeks)", "Bills"], rows: rows.map(([k, r]) => [k, fmt(r.total), r.ids.length]) },
  };
}

export function cashPosition(data: CompanyData): Answer {
  const c = openingCash(data);
  const ap = openBills(data).reduce((s, b) => s + b.open, 0);
  const ar = agingBuckets(openReceivables(data));
  return {
    kind: "cash_position",
    headline: `You have ${fmt(c.cash)} in checking as of ${dayToDate(data.openingDate, data.asOfDay)}, with ${fmt(ar.total)} owed to you and ${fmt(ap)} of bills to pay.`,
    facts: [
      { key: "cash", label: "Cash in checking", value: c.cash, unit: "usd", source: c.sourceId ?? "bank" },
      { key: "ar_total", label: "Owed to you", value: ar.total, unit: "usd", source: "report:ar_aging" },
      { key: "ap_total", label: "Bills to pay", value: ap, unit: "usd", source: "report:ap_aging" },
    ],
  };
}

export function revenueTrend(data: CompanyData): Answer {
  const months = data.pnl.monthly.filter((m) => m.full);
  const first = months.slice(0, 3).reduce((s, m) => s + m.revenue, 0) / Math.max(1, Math.min(3, months.length));
  const last = months.slice(-3).reduce((s, m) => s + m.revenue, 0) / Math.max(1, Math.min(3, months.length));
  return {
    kind: "revenue_trend",
    headline: `Average monthly revenue went from ${fmt(first)} (first three full months) to ${fmt(last)} (last three).`,
    facts: [
      { key: "rev_first3", label: "Avg monthly revenue, first 3 full months", value: Math.round(first), unit: "usd", source: "report:profit_and_loss" },
      { key: "rev_last3", label: "Avg monthly revenue, last 3 full months", value: Math.round(last), unit: "usd", source: "report:profit_and_loss" },
      { key: "rev_year", label: "Revenue for the year", value: data.pnl.full.revenue, unit: "usd", source: "report:profit_and_loss" },
    ],
    table: {
      columns: ["Month", "Revenue", "Net profit"],
      rows: months.map((m) => [m.monthEnd.slice(0, 7), fmt(m.revenue), fmt(m.net)]),
    },
  };
}

function fmt(c: number): string {
  const v = Math.round(c / 100);
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US")}`;
}
