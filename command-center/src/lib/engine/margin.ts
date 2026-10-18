// Margins and Profit Leak Radar. Leaks carry an estimated annual dollar
// impact and are ranked by benefit x feasibility x confidence.
import type { CompanyData } from "../data/types";
import { dayToDate } from "../data/types";
import { usd } from "./format";
import { detectRecurring } from "./recurring";
import { paymentBehavior } from "./receivables";

export interface MonthMargin {
  month: string;
  revenue: number;
  grossMargin: number | null;
  netMargin: number | null;
}

export function monthlyMargins(data: CompanyData): MonthMargin[] {
  return data.pnl.monthly
    .filter((m) => m.full)
    .map((m) => ({
      month: m.monthEnd.slice(0, 7),
      revenue: m.revenue,
      grossMargin: m.revenue > 0 ? (m.revenue - m.cogs) / m.revenue : null,
      netMargin: m.revenue > 0 ? m.net / m.revenue : null,
    }));
}

export interface CustomerMargin {
  customerId: string;
  name: string;
  revenue: number;
  estCost: number | null;
  grossMargin: number | null;
  writtenOff: number;
  medianDaysLate: number;
}

/** Margin by customer where items carry a unit cost (product companies); revenue only otherwise. */
export function marginByCustomer(data: CompanyData, asOf = data.asOfDay): CustomerMargin[] {
  const beh = paymentBehavior(data, asOf);
  const agg = new Map<string, { revenue: number; cost: number; costed: number }>();
  for (const i of data.invoices) {
    if (i.day > asOf) continue;
    const a = agg.get(i.customerId) ?? { revenue: 0, cost: 0, costed: 0 };
    a.revenue += i.total;
    if (i.estCost !== null) {
      a.cost += i.estCost;
      a.costed += i.total;
    }
    agg.set(i.customerId, a);
  }
  const names = new Map(data.customers.map((c) => [c.id, c.name]));
  return [...agg.entries()]
    .map(([id, a]) => {
      const b = beh.byCustomer.get(id);
      const costed = a.costed > a.revenue * 0.9;
      return {
        customerId: id,
        name: names.get(id) ?? id,
        revenue: a.revenue,
        estCost: costed ? a.cost : null,
        grossMargin: costed && a.revenue > 0 ? (a.revenue - a.cost) / a.revenue : null,
        writtenOff: b?.writtenOff ?? 0,
        medianDaysLate: b?.medianDaysLate ?? 0,
      };
    })
    .sort((x, y) => y.revenue - x.revenue);
}

export interface Leak {
  id: string;
  title: string;
  detail: string;
  annualImpact: number; // cents, estimated
  feasibility: number; // 0..1: how controllable
  confidence: number; // 0..1: how solid the evidence
  score: number;
  status: "verified" | "hypothesis";
  sources: { id: string; label: string; amount?: number; date?: string }[];
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function profitLeaks(data: CompanyData, asOf = data.asOfDay): Leak[] {
  const leaks: Omit<Leak, "score">[] = [];
  const annualRevenue = data.pnl.full.revenue;

  // 1. Gross margin decline: last three full months vs first three.
  const mm = monthlyMargins(data).filter((m) => m.grossMargin !== null);
  if (mm.length >= 6) {
    const first = avg(mm.slice(0, 3).map((m) => m.grossMargin!));
    const last = avg(mm.slice(-3).map((m) => m.grossMargin!));
    const drop = first - last;
    if (drop > 0.02) {
      leaks.push({
        id: "gross-margin-decline",
        title: `Gross margin slipped from ${(first * 100).toFixed(1)}% to ${(last * 100).toFixed(1)}%`,
        detail: `Comparing the first three and last three full months of the P&L. At this year's revenue that is about ${usd(drop * annualRevenue)} a year. Check supplier price increases against your own price list.`,
        annualImpact: Math.round(drop * annualRevenue),
        feasibility: 0.6,
        confidence: 0.8,
        status: "verified",
        sources: mm.map((m) => ({ id: `pnl:${m.month}`, label: `P&L ${m.month}: gross margin ${((m.grossMargin ?? 0) * 100).toFixed(1)}%`, amount: m.revenue })),
      });
    }
  }

  // 2. Recurring cost creep: same vendor, latest amount vs six months earlier.
  for (const r of detectRecurring(data, asOf)) {
    const bills = data.bills.filter((b) => `${b.vendorId}|${b.category}` === r.key && b.day <= asOf).sort((a, b) => a.day - b.day);
    const old = bills.filter((b) => b.day <= asOf - 150 && b.day > asOf - 240).map((b) => b.total);
    const recent = bills.filter((b) => b.day > asOf - 60).map((b) => b.total);
    if (old.length < 1 || recent.length < 1) continue;
    const before = avg(old);
    const now = avg(recent);
    if (before <= 0 || now / before < 1.15) continue;
    const perYear = (365 / r.intervalDays) * (now - before);
    if (perYear < 50_000) continue;
    leaks.push({
      id: `creep-${r.key}`,
      title: `${r.vendorName} ${r.category.replace(/_/g, " ")} costs are up ${Math.round((now / before - 1) * 100)}%`,
      detail: `Average bill rose from ${usd(before)} to ${usd(now)} per ${r.cadence.replace("ly", "")} cycle, about ${usd(perYear)} a year more. Ask for a rate review or compare providers.`,
      annualImpact: Math.round(perYear),
      feasibility: r.category === "income_tax" ? 0.1 : 0.5,
      confidence: 0.7,
      status: "verified",
      sources: bills.slice(-6).map((b) => ({ id: b.id, label: `${r.vendorName} bill`, amount: b.total, date: dayToDate(data.openingDate, b.day) })),
    });
  }

  // 3. Rising cost categories (non-recurring): last 13 weeks vs the 13 before, normalised by revenue.
  const win = (from: number, to: number) => {
    const cat = new Map<string, number>();
    for (const b of data.bills) if (b.day > from && b.day <= to) cat.set(b.category, (cat.get(b.category) ?? 0) + b.total);
    let rev = 0;
    for (const i of data.invoices) if (i.day > from && i.day <= to) rev += i.total;
    for (const s of data.salesReceipts) if (s.day > from && s.day <= to) rev += s.total;
    return { cat, rev };
  };
  const recentW = win(asOf - 91, asOf);
  const priorW = win(asOf - 182, asOf - 91);
  if (recentW.rev > 0 && priorW.rev > 0) {
    for (const [cat, amt] of recentW.cat) {
      if (["income_tax", "permit", "equipment", "owned_equipment"].includes(cat)) continue;
      const prior = priorW.cat.get(cat) ?? 0;
      const shareNow = amt / recentW.rev;
      const shareBefore = prior / priorW.rev;
      if (prior <= 0 || shareNow - shareBefore < 0.02) continue;
      const impact = (shareNow - shareBefore) * annualRevenue;
      leaks.push({
        id: `category-${cat}`,
        title: `${cat.replace(/_/g, " ")} costs are taking a bigger share of sales`,
        detail: `${(shareBefore * 100).toFixed(1)}% of sales in the prior quarter vs ${(shareNow * 100).toFixed(1)}% in the last quarter, roughly ${usd(impact)} a year if it persists.`,
        annualImpact: Math.round(impact),
        feasibility: 0.5,
        confidence: 0.6,
        status: "hypothesis",
        sources: data.bills
          .filter((b) => b.category === cat && b.day > asOf - 91 && b.day <= asOf)
          .slice(-8)
          .map((b) => ({ id: b.id, label: `${cat} bill`, amount: b.total, date: dayToDate(data.openingDate, b.day) })),
      });
    }
  }

  // 4. Bad debt by customer.
  const cm = marginByCustomer(data, asOf);
  for (const c of cm.filter((c) => c.writtenOff > 0)) {
    leaks.push({
      id: `baddebt-${c.customerId}`,
      title: `${c.name}: ${usd(c.writtenOff)} written off`,
      detail: `Uncollectable sales are pure margin loss. Consider tighter terms or deposits for this customer (median ${c.medianDaysLate} days late).`,
      annualImpact: c.writtenOff,
      feasibility: 0.7,
      confidence: 0.9,
      status: "verified",
      sources: data.journal
        .filter((j) => j.customerId === c.customerId && (j.purpose === "bad_debt" || j.purpose === "client_default"))
        .map((j) => ({ id: j.documentId ?? j.id, label: "write-off", amount: j.amount, date: dayToDate(data.openingDate, j.day) })),
    });
  }

  // 5. Low-margin customers (only where item costs exist).
  const costed = cm.filter((c) => c.grossMargin !== null && c.revenue > 0);
  if (costed.length >= 5) {
    const tot = costed.reduce((s, c) => s + c.revenue, 0);
    const avgMargin = costed.reduce((s, c) => s + (c.grossMargin ?? 0) * c.revenue, 0) / tot;
    for (const c of costed) {
      const gap = avgMargin - (c.grossMargin ?? 0);
      if (gap < 0.08 || c.revenue < tot * 0.02) continue;
      leaks.push({
        id: `lowmargin-${c.customerId}`,
        title: `${c.name} buys at a thin margin`,
        detail: `Estimated gross margin ${((c.grossMargin ?? 0) * 100).toFixed(1)}% vs ${(avgMargin * 100).toFixed(1)}% across customers (item costs at current unit cost).`,
        annualImpact: Math.round(gap * c.revenue),
        feasibility: 0.4,
        confidence: 0.5,
        status: "hypothesis",
        sources: data.invoices.filter((i) => i.customerId === c.customerId).slice(-6).map((i) => ({ id: i.id, label: i.item, amount: i.total, date: dayToDate(data.openingDate, i.day) })),
      });
    }
  }

  return leaks
    .map((l) => ({ ...l, score: (l.annualImpact / 100) * l.feasibility * l.confidence }))
    .sort((a, b) => b.score - a.score);
}
