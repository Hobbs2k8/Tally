// Receivables: open balances, aging, customer payment behaviour and expected
// collection timing. Pure functions over CompanyData.
import type { CompanyData, Customer, Invoice } from "../data/types";

export interface OpenInvoice {
  id: string;
  customerId: string;
  customerName: string;
  day: number;
  due: number;
  dueWasMissing: boolean;
  total: number;
  open: number;
  daysPastDue: number; // negative = not yet due
  bucket: "current" | "1-30" | "31-60" | "61-90" | "90+";
}

export function effectiveDue(inv: Invoice, customer: Customer | undefined): number {
  if (inv.due !== null && inv.due !== undefined) return inv.due;
  return inv.day + (customer?.termsDays ?? 30);
}

/** The part of an invoice that becomes an ordinary receivable (excludes deposit drawn down and retainage). */
export function receivablePart(inv: Invoice): number {
  return inv.total - inv.deposit - inv.retainage;
}

/** Retainage still withheld across invoices (collected when projects complete; not in the 90-day projection). */
export function openRetainage(data: CompanyData, asOf = data.asOfDay): number {
  const settled = settledByInvoice(data, asOf);
  let total = 0;
  for (const inv of data.invoices) {
    if (inv.day > asOf || !inv.retainage) continue;
    total += Math.max(0, inv.retainage - (settled.get(inv.id)?.retainagePaid ?? 0));
  }
  return total;
}

export function bucketFor(daysPastDue: number): OpenInvoice["bucket"] {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

interface Settled {
  paid: number; // applied to the receivable
  retainagePaid: number; // retention released against withheld retainage
  writtenOff: number;
  lastDay: number;
}

/**
 * Amount settled per invoice up to and including asOf. Retainage is withheld
 * by the client until a project completes; it sits in its own asset account,
 * so it is tracked apart from the receivable (this matches the AR aging report).
 */
export function settledByInvoice(data: CompanyData, asOf: number): Map<string, Settled> {
  const m = new Map<string, Settled>();
  const get = (id: string) => {
    let r = m.get(id);
    if (!r) m.set(id, (r = { paid: 0, retainagePaid: 0, writtenOff: 0, lastDay: -1 }));
    return r;
  };
  for (const p of data.customerPayments) {
    if (p.day > asOf) continue;
    for (const a of p.apps) {
      const r = get(a.docId);
      if (p.settles === "retainage") {
        r.retainagePaid += a.amount;
        continue;
      }
      r.paid += a.amount;
      r.lastDay = Math.max(r.lastDay, p.day);
    }
  }
  for (const j of data.journal) {
    if (j.day > asOf || !j.documentId) continue;
    if (j.purpose === "bad_debt" || j.purpose === "client_default") {
      const r = get(j.documentId);
      r.writtenOff += j.amount;
      r.lastDay = Math.max(r.lastDay, j.day);
    }
  }
  return m;
}

export function openReceivables(data: CompanyData, asOf = data.asOfDay): OpenInvoice[] {
  const customers = new Map(data.customers.map((c) => [c.id, c]));
  const settled = settledByInvoice(data, asOf);
  const out: OpenInvoice[] = [];
  for (const inv of data.invoices) {
    if (inv.day > asOf) continue;
    const s = settled.get(inv.id);
    const open = receivablePart(inv) - (s?.paid ?? 0) - (s?.writtenOff ?? 0);
    if (open <= 0) continue;
    const c = customers.get(inv.customerId);
    const due = effectiveDue(inv, c);
    const daysPastDue = asOf - due;
    out.push({
      id: inv.id,
      customerId: inv.customerId,
      customerName: c?.name ?? inv.customerId,
      day: inv.day,
      due,
      dueWasMissing: inv.due === null || inv.due === undefined,
      total: inv.total,
      open,
      daysPastDue,
      bucket: bucketFor(daysPastDue),
    });
  }
  return out.sort((a, b) => b.daysPastDue - a.daysPastDue);
}

export function agingBuckets(open: OpenInvoice[]): Record<OpenInvoice["bucket"], number> & { total: number; overdue: number } {
  const b = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, total: 0, overdue: 0 };
  for (const o of open) {
    b[o.bucket] += o.open;
    b.total += o.open;
    if (o.daysPastDue > 0) b.overdue += o.open;
  }
  return b;
}

export interface CustomerBehavior {
  customerId: string;
  customerName: string;
  paidInvoices: number;
  medianDaysLate: number;
  lateShare: number; // share of settled invoices paid after due
  writtenOff: number; // cents written off for this customer
  revenue: number; // invoiced in the period
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** How late each customer pays, from fully settled invoices. */
export function paymentBehavior(data: CompanyData, asOf = data.asOfDay): { byCustomer: Map<string, CustomerBehavior>; companyMedianDaysLate: number; companyLateShare: number } {
  const customers = new Map(data.customers.map((c) => [c.id, c]));
  const settled = settledByInvoice(data, asOf);
  const lates = new Map<string, number[]>();
  const all: number[] = [];
  const revenue = new Map<string, number>();
  const writtenOff = new Map<string, number>();
  for (const inv of data.invoices) {
    if (inv.day > asOf) continue;
    revenue.set(inv.customerId, (revenue.get(inv.customerId) ?? 0) + inv.total);
    const s = settled.get(inv.id);
    if (s?.writtenOff) writtenOff.set(inv.customerId, (writtenOff.get(inv.customerId) ?? 0) + s.writtenOff);
    if (!s || s.paid + s.writtenOff < receivablePart(inv) || s.paid === 0) continue;
    const late = s.lastDay - effectiveDue(inv, customers.get(inv.customerId));
    if (!lates.has(inv.customerId)) lates.set(inv.customerId, []);
    lates.get(inv.customerId)!.push(late);
    all.push(late);
  }
  const byCustomer = new Map<string, CustomerBehavior>();
  for (const c of data.customers) {
    const l = lates.get(c.id) ?? [];
    byCustomer.set(c.id, {
      customerId: c.id,
      customerName: c.name,
      paidInvoices: l.length,
      medianDaysLate: median(l),
      lateShare: l.length ? l.filter((x) => x > 0).length / l.length : 0,
      writtenOff: writtenOff.get(c.id) ?? 0,
      revenue: revenue.get(c.id) ?? 0,
    });
  }
  return {
    byCustomer,
    companyMedianDaysLate: median(all),
    companyLateShare: all.length ? all.filter((x) => x > 0).length / all.length : 0,
  };
}

export interface ExpectedCollection {
  invoiceId: string;
  customerId: string;
  amount: number;
  expectedDay: number;
  atRisk: boolean;
  rule: "customer_pattern" | "overdue_beyond_pattern" | "severely_overdue";
}

export const SEVERE_OVERDUE_DAYS = 90;
export const BEYOND_PATTERN_COLLECT_DAYS = 14;

/**
 * Expected collection day for each open invoice:
 *  - due date plus the customer's median lateness (company median if no history);
 *  - already later than that pattern: assume collected within 14 days (rule);
 *  - more than 90 days past due: at risk, excluded from projected cash.
 */
export function expectedCollections(data: CompanyData, asOf = data.asOfDay): ExpectedCollection[] {
  const open = openReceivables(data, asOf);
  const beh = paymentBehavior(data, asOf);
  return open.map((o) => {
    const b = beh.byCustomer.get(o.customerId);
    const lateness = b && b.paidInvoices >= 2 ? b.medianDaysLate : beh.companyMedianDaysLate;
    const patternDay = o.due + Math.max(0, lateness);
    if (o.daysPastDue > SEVERE_OVERDUE_DAYS) {
      return { invoiceId: o.id, customerId: o.customerId, amount: o.open, expectedDay: asOf + BEYOND_PATTERN_COLLECT_DAYS, atRisk: true, rule: "severely_overdue" };
    }
    if (patternDay <= asOf) {
      return { invoiceId: o.id, customerId: o.customerId, amount: o.open, expectedDay: asOf + BEYOND_PATTERN_COLLECT_DAYS, atRisk: false, rule: "overdue_beyond_pattern" };
    }
    return { invoiceId: o.id, customerId: o.customerId, amount: o.open, expectedDay: patternDay, atRisk: false, rule: "customer_pattern" };
  });
}

/**
 * Collection curve for new invoices: share of an invoice's value collected in
 * week k after it is issued (k = 0..12), from invoices issued 90 to 270 days
 * before asOf (old enough to have resolved). The remainder is the
 * uncollected share (written off or still open after that long).
 */
export function collectionCurve(data: CompanyData, asOf = data.asOfDay): { weekly: number[]; uncollected: number; sampleInvoices: number } {
  const weeks = 13;
  const curve = new Array(weeks).fill(0);
  const lo = asOf - 270;
  const hi = asOf - 90;
  const sample = data.invoices.filter((i) => i.day >= lo && i.day <= hi);
  const ids = new Map(sample.map((i) => [i.id, i]));
  let billed = 0;
  for (const i of sample) billed += receivablePart(i);
  if (!billed) return { weekly: [0, 1, ...new Array(weeks - 2).fill(0)], uncollected: 0, sampleInvoices: 0 };
  for (const p of data.customerPayments) {
    if (p.day > asOf || p.settles === "retainage") continue;
    for (const a of p.apps) {
      const inv = ids.get(a.docId);
      if (!inv) continue;
      const k = Math.min(weeks - 1, Math.max(0, Math.floor((p.day - inv.day) / 7)));
      curve[k] += a.amount;
    }
  }
  const collected = curve.reduce((s, x) => s + x, 0);
  return {
    weekly: curve.map((x) => x / billed),
    uncollected: Math.max(0, 1 - collected / billed),
    sampleInvoices: sample.length,
  };
}
