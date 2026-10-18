// Time Machine: historical counterfactuals. The historical series is fact;
// the counterfactual series is an estimate that replays the bank feed with
// one assumption changed. They are always returned (and shown) separately.
import type { CompanyData } from "../data/types";
import { effectiveDue } from "./receivables";

export interface CounterfactualResult {
  kind: "on_time_payment";
  customerId: string | null; // null = all customers
  customerName: string;
  weekly: { endDay: number; historical: number; counterfactual: number }[];
  historicalMin: { day: number; cash: number };
  counterfactualMin: { day: number; cash: number };
  paymentsMoved: number;
  amountMoved: number;
  avgDaysEarlier: number;
  sources: string[];
}

/** What if this customer (or every customer) had paid each invoice on its due date? */
export function onTimePaymentCounterfactual(data: CompanyData, customerId: string | null, asOf = data.asOfDay): CounterfactualResult {
  const customers = new Map(data.customers.map((c) => [c.id, c]));
  const invoices = new Map(data.invoices.map((i) => [i.id, i]));
  const shifts = new Map<number, number>(); // day -> cash delta
  let moved = 0;
  let amount = 0;
  let daysSum = 0;
  const sources: string[] = [];
  for (const p of data.customerPayments) {
    if (p.day > asOf || p.settles === "retainage") continue;
    if (customerId && p.customerId !== customerId) continue;
    for (const a of p.apps) {
      const inv = invoices.get(a.docId);
      if (!inv) continue;
      const due = effectiveDue(inv, customers.get(inv.customerId));
      if (p.day <= due) continue;
      shifts.set(due, (shifts.get(due) ?? 0) + a.amount);
      shifts.set(p.day, (shifts.get(p.day) ?? 0) - a.amount);
      moved++;
      amount += a.amount;
      daysSum += (p.day - due) * a.amount;
      sources.push(p.id);
    }
  }
  // Daily balances, historical and shifted.
  const end = new Map<number, number>();
  for (const t of [...data.bank].sort((a, b) => a.day - b.day)) end.set(t.day, t.balance);
  let hist = 0;
  let delta = 0;
  const daily: { day: number; h: number; c: number }[] = [];
  for (let d = 0; d <= asOf; d++) {
    if (end.has(d)) hist = end.get(d)!;
    delta += shifts.get(d) ?? 0;
    daily.push({ day: d, h: hist, c: hist + delta });
  }
  const hMin = daily.slice(1).reduce((m, x) => (x.h < m.cash ? { day: x.day, cash: x.h } : m), { day: 0, cash: Infinity });
  const cMin = daily.slice(1).reduce((m, x) => (x.c < m.cash ? { day: x.day, cash: x.c } : m), { day: 0, cash: Infinity });
  const weekly = daily.filter((x) => (asOf - x.day) % 7 === 0).map((x) => ({ endDay: x.day, historical: x.h, counterfactual: Math.round(x.c) }));
  return {
    kind: "on_time_payment",
    customerId,
    customerName: customerId ? customers.get(customerId)?.name ?? customerId : "all customers",
    weekly,
    historicalMin: hMin,
    counterfactualMin: { day: cMin.day, cash: Math.round(cMin.cash) },
    paymentsMoved: moved,
    amountMoved: amount,
    avgDaysEarlier: amount ? daysSum / amount : 0,
    sources: sources.slice(0, 25),
  };
}
