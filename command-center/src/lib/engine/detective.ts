// Money Detective: overdue invoices, possible duplicates, unusual amounts and
// sharp cash movements, each linked to source records. Facts read straight
// from the books are "verified"; pattern-based flags are "hypothesis".
import type { CompanyData } from "../data/types";
import { dayToDate } from "../data/types";
import { usd } from "./format";
import { openReceivables, paymentBehavior } from "./receivables";

export interface Finding {
  id: string;
  capability: "detective" | "radar" | "accountant";
  status: "verified" | "hypothesis";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  amount: number | null; // cents
  sources: { id: string; label: string; amount?: number; date?: string }[];
}

export function overdueFindings(data: CompanyData, asOf = data.asOfDay): Finding[] {
  const all = openReceivables(data, asOf);
  const open = all.filter((o) => o.daysPastDue > 0);
  if (!open.length) return [];
  const beh = paymentBehavior(data, asOf);
  const total = open.reduce((s, o) => s + o.open, 0);
  const allOpen = all.reduce((s, o) => s + o.open, 0);
  const byCustomer = new Map<string, typeof open>();
  for (const o of open) {
    if (!byCustomer.has(o.customerId)) byCustomer.set(o.customerId, []);
    byCustomer.get(o.customerId)!.push(o);
  }
  const out: Finding[] = [
    {
      id: "overdue-total",
      capability: "detective",
      status: "verified",
      severity: total > allOpen * 0.3 ? "high" : "medium",
      title: `${usd(total)} of receivables is overdue`,
      detail: `${open.length} open invoices are past due (${Math.round((total / allOpen) * 100)}% of ${usd(allOpen)} outstanding). The oldest is ${open[0].daysPastDue} days late.`,
      amount: total,
      sources: open.slice(0, 12).map((o) => ({
        id: o.id,
        label: `${o.customerName} · ${o.daysPastDue} days past due`,
        amount: o.open,
        date: dayToDate(data.openingDate, o.due),
      })),
    },
  ];
  // Customers whose current delay is far beyond their own history: one grouped hypothesis.
  const unusual: { name: string; days: number; usual: number; amount: number; ids: string[]; due: number }[] = [];
  for (const [cid, invs] of byCustomer) {
    const b = beh.byCustomer.get(cid);
    const worst = invs[0];
    const usual = Math.max(0, b?.medianDaysLate ?? 0);
    if (worst.daysPastDue - usual < 30) continue;
    unusual.push({ name: worst.customerName, days: worst.daysPastDue, usual, amount: invs.reduce((s, o) => s + o.open, 0), ids: invs.map((o) => o.id), due: worst.due });
  }
  if (unusual.length) {
    unusual.sort((a, b) => b.amount - a.amount);
    const amt = unusual.reduce((s, u) => s + u.amount, 0);
    const top = unusual.slice(0, 3).map((u) => `${u.name} (${u.days} days vs usual ${u.usual})`).join(", ");
    out.push({
      id: "unusual-delays",
      capability: "detective",
      status: "hypothesis",
      severity: unusual.some((u) => u.days > 60) ? "high" : "medium",
      title: `${unusual.length} customer${unusual.length === 1 ? " is" : "s are"} paying far later than their own history`,
      detail: `${usd(amt)} sits with customers who are 30+ days behind their usual pattern: ${top}. Could signal disputes or cash trouble on their side.`,
      amount: amt,
      sources: unusual.map((u) => ({ id: u.ids[0], label: `${u.name} · ${u.days} days past due (usually ${u.usual})`, amount: u.amount, date: dayToDate(data.openingDate, u.due) })),
    });
  }
  return out;
}

export function writeOffFindings(data: CompanyData, asOf = data.asOfDay): Finding[] {
  const wos = data.journal.filter((j) => (j.purpose === "bad_debt" || j.purpose === "client_default") && j.day <= asOf);
  if (!wos.length) return [];
  const customers = new Map(data.customers.map((c) => [c.id, c.name]));
  const total = wos.reduce((s, j) => s + j.amount, 0);
  return [
    {
      id: "write-offs",
      capability: "detective",
      status: "verified",
      severity: total > 500_000 ? "medium" : "low",
      title: `${usd(total)} written off as uncollectable this year`,
      detail: `${wos.length} receivable${wos.length === 1 ? " was" : "s were"} written off.`,
      amount: total,
      sources: wos.map((j) => ({
        id: j.documentId ?? j.id,
        label: `${customers.get(j.customerId ?? "") ?? "Customer"} · ${j.purpose.replace("_", " ")} (${j.id})`,
        amount: j.amount,
        date: dayToDate(data.openingDate, j.day),
      })),
    },
  ];
}

/** Same vendor, same amount, within 3 days, outside the vendor's normal cadence. */
export function duplicateFindings(data: CompanyData, asOf = data.asOfDay): Finding[] {
  const vendors = new Map(data.vendors.map((v) => [v.id, v.name]));
  const bills = data.bills.filter((b) => b.day <= asOf).sort((a, b) => a.day - b.day);
  const out: Finding[] = [];
  const seen = new Set<string>();
  const byVendor = new Map<string, typeof bills>();
  for (const b of bills) {
    if (!byVendor.has(b.vendorId)) byVendor.set(b.vendorId, []);
    byVendor.get(b.vendorId)!.push(b);
  }
  for (const [vid, list] of byVendor) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].day - list[i].day <= 3; j++) {
        const a = list[i];
        const b = list[j];
        if (a.total !== b.total || a.category !== b.category || a.total < 10_000) continue;
        // Daily or near-daily identical bills are a pattern (e.g. subcontract installments), not a duplicate.
        const sameAmountNearby = list.filter((x) => x.total === a.total && Math.abs(x.day - a.day) <= 30).length;
        if (sameAmountNearby > 3) continue;
        const key = [a.id, b.id].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `dup-${a.id}-${b.id}`,
          capability: "detective",
          status: "hypothesis",
          severity: a.total > 100_000 ? "high" : "medium",
          title: `Possible duplicate bill from ${vendors.get(vid) ?? vid}`,
          detail: `Two ${a.category.replace(/_/g, " ")} bills of ${usd(a.total)} ${b.day === a.day ? "on the same day" : `${b.day - a.day} day(s) apart`}. Confirm both are genuine before paying.`,
          amount: a.total,
          sources: [a, b].map((x) => ({ id: x.id, label: `${vendors.get(vid) ?? vid} · ${x.memo || x.category}`, amount: x.total, date: dayToDate(data.openingDate, x.day) })),
        });
      }
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Bills far outside the vendor/category's usual amount (robust z-score). */
export function unusualExpenseFindings(data: CompanyData, asOf = data.asOfDay): Finding[] {
  const vendors = new Map(data.vendors.map((v) => [v.id, v.name]));
  const groups = new Map<string, typeof data.bills>();
  for (const b of data.bills) {
    if (b.day > asOf || b.category === "income_tax") continue;
    const k = `${b.vendorId}|${b.category}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(b);
  }
  const out: Finding[] = [];
  for (const [, list] of groups) {
    if (list.length < 6) continue;
    const amounts = list.map((b) => b.total);
    const med = median(amounts);
    const mad = median(amounts.map((a) => Math.abs(a - med))) * 1.4826;
    const scale = Math.max(mad, med * 0.1);
    for (const b of list) {
      if (b.day < asOf - 120) continue; // recent only: older spikes are not actionable
      const z = (b.total - med) / scale;
      if (z < 6 || b.total - med < 50_000) continue;
      out.push({
        id: `unusual-${b.id}`,
        capability: "detective",
        status: "hypothesis",
        severity: b.total - med > 500_000 ? "high" : "medium",
        title: `Unusually large ${b.category.replace(/_/g, " ")} bill from ${vendors.get(b.vendorId) ?? b.vendorId}`,
        detail: `${usd(b.total)} against a typical ${usd(med)} for this vendor (${list.length} bills). Worth checking the invoice before the next payment run.`,
        amount: b.total - Math.round(med),
        sources: [{ id: b.id, label: b.memo || b.category, amount: b.total, date: dayToDate(data.openingDate, b.day) }],
      });
    }
  }
  return out.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 5);
}

/** Weeks in the last quarter where cash fell sharply, explained by their largest outflows. */
export function cashSwingFindings(data: CompanyData, asOf = data.asOfDay): Finding[] {
  const weeks: { end: number; net: number; txns: CompanyData["bank"] }[] = [];
  for (let w = 25; w >= 0; w--) {
    const end = asOf - w * 7;
    const txns = data.bank.filter((t) => t.day > end - 7 && t.day <= end && t.kind !== "opening_equity");
    weeks.push({ end, net: txns.reduce((s, t) => s + t.amount, 0), txns });
  }
  const nets = weeks.map((w) => w.net);
  const med = median(nets);
  const mad = median(nets.map((n) => Math.abs(n - med))) * 1.4826 || 1;
  const out: Finding[] = [];
  for (const w of weeks.slice(-13)) {
    if ((w.net - med) / mad > -3 || w.net > -200_000) continue;
    const outs = w.txns.filter((t) => t.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 3);
    const drivers = outs.map((t) => `${t.memo || t.kind} ${usd(-t.amount)}`).join(", ");
    out.push({
      id: `swing-${w.end}`,
      capability: "detective",
      status: "verified",
      severity: "low",
      title: `Cash fell ${usd(-w.net)} in the week to ${dayToDate(data.openingDate, w.end)}`,
      detail: `Largest outflows: ${drivers}.`,
      amount: -w.net,
      sources: outs.map((t) => ({ id: t.source, label: `${t.kind.replace(/_/g, " ")} · ${t.memo}`, amount: -t.amount, date: dayToDate(data.openingDate, t.day) })),
    });
  }
  return out;
}

export function investigate(data: CompanyData, asOf = data.asOfDay): Finding[] {
  return [
    ...overdueFindings(data, asOf),
    ...duplicateFindings(data, asOf),
    ...unusualExpenseFindings(data, asOf),
    ...writeOffFindings(data, asOf),
    ...cashSwingFindings(data, asOf),
  ];
}
