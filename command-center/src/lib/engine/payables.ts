// Payables: open vendor bills and when they fall due.
import type { CompanyData } from "../data/types";

export interface OpenBill {
  id: string;
  vendorId: string;
  vendorName: string;
  category: string;
  kind: string;
  day: number;
  due: number;
  open: number;
  daysPastDue: number;
}

export function openBills(data: CompanyData, asOf = data.asOfDay): OpenBill[] {
  const vendors = new Map(data.vendors.map((v) => [v.id, v]));
  const paid = new Map<string, number>();
  for (const p of data.billPayments) {
    if (p.day > asOf) continue;
    for (const a of p.apps) paid.set(a.docId, (paid.get(a.docId) ?? 0) + a.amount);
  }
  const out: OpenBill[] = [];
  for (const b of data.bills) {
    if (b.day > asOf) continue;
    const open = b.total - (paid.get(b.id) ?? 0);
    if (open <= 0) continue;
    out.push({
      id: b.id,
      vendorId: b.vendorId,
      vendorName: vendors.get(b.vendorId)?.name ?? b.vendorId,
      category: b.category,
      kind: b.kind,
      day: b.day,
      due: b.due,
      open,
      daysPastDue: asOf - b.due,
    });
  }
  return out.sort((a, b) => a.due - b.due);
}

/** Bills due within `days` of asOf (or already past due), soonest first. */
export function billsNeedingAttention(data: CompanyData, days = 14, asOf = data.asOfDay): OpenBill[] {
  return openBills(data, asOf).filter((b) => b.due <= asOf + days);
}
