// Autopilot: turns findings and the recommended plan into ranked, prepared
// actions. Nothing is executed: drafts can only be marked approved.
import type { CompanyData } from "../data/types";
import { dayToDate } from "../data/types";
import type { Finding } from "../engine/detective";
import { usd } from "../engine/format";
import type { Leak } from "../engine/margin";
import { billsNeedingAttention } from "../engine/payables";
import { openReceivables } from "../engine/receivables";

export interface Draft {
  id: string;
  kind: "invoice_reminder";
  to: string;
  toName: string;
  subject: string;
  body: string;
  amount: number;
  invoiceIds: string[];
}

export interface Action {
  id: string;
  kind: "collect" | "pay_bill" | "hold_bill" | "plan_step" | "cost_review";
  title: string;
  detail: string;
  impact: number; // cents of cash or annual profit at stake
  urgency: "now" | "this week" | "this month" | "this quarter";
  confidence: number; // 0..1
  risk: number; // 0..1 downside if wrong
  score: number;
  draftIds?: string[];
  sources: string[];
}

const URGENCY_WEIGHT = { now: 1, "this week": 0.8, "this month": 0.5, "this quarter": 0.3 };

export function score(a: Omit<Action, "score">): number {
  return Math.round((a.impact / 100) * URGENCY_WEIGHT[a.urgency] * a.confidence * (1 - 0.5 * a.risk));
}

export function reminderDrafts(data: CompanyData, limit = 8): Draft[] {
  const customers = new Map(data.customers.map((c) => [c.id, c]));
  const overdue = openReceivables(data).filter((o) => o.daysPastDue > 0);
  const by = new Map<string, typeof overdue>();
  for (const o of overdue) {
    if (!by.has(o.customerId)) by.set(o.customerId, []);
    by.get(o.customerId)!.push(o);
  }
  return [...by.entries()]
    .map(([cid, invs]) => ({ cid, invs, total: invs.reduce((s, o) => s + o.open, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(({ cid, invs, total }) => {
      const c = customers.get(cid);
      const lines = invs
        .sort((a, b) => a.due - b.due)
        .map((o) => `  • Invoice ${o.id}: ${usd(o.open)} (due ${dayToDate(data.openingDate, o.due)}, ${o.daysPastDue} days past due)`)
        .join("\n");
      return {
        id: `draft-${cid}`,
        kind: "invoice_reminder" as const,
        to: c?.email ?? "",
        toName: c?.name ?? cid,
        subject: `Payment reminder: ${usd(total)} outstanding with ${data.name}`,
        body: `Hello,\n\nOur records show the following ${invs.length === 1 ? "invoice is" : "invoices are"} past due:\n\n${lines}\n\nTotal outstanding: ${usd(total)}.\n\nIf payment is already on its way, thank you and please ignore this note. Otherwise, could you let us know when we can expect it? Happy to help if anything on the invoice needs correcting.\n\nThank you,\n${data.name}`,
        amount: total,
        invoiceIds: invs.map((o) => o.id),
      };
    });
}

export function buildActions(
  data: CompanyData,
  opts: { findings: Finding[]; leaks: Leak[]; planChanges: string[]; drafts: Draft[]; recoveryPct: number },
): Action[] {
  const out: Omit<Action, "score">[] = [];
  const overdueAge = new Map(openReceivables(data).map((o) => [o.id, o.daysPastDue]));
  const overdue = openReceivables(data).filter((o) => o.daysPastDue > 0);
  if (overdue.length) {
    const total = overdue.reduce((sum, o) => sum + o.open, 0);
    const ids = overdue.map((o) => o.id);
    const customers = new Set(overdue.map((o) => o.customerId)).size;
    const oldest = Math.max(...ids.map((id) => overdueAge.get(id) ?? 0));
    out.push({
      id: "collect-overdue",
      kind: "collect",
      title: `Chase ${customers} overdue customer${customers === 1 ? "" : "s"} for ${usd(total)}`,
      detail: `${ids.length} invoices, oldest ${oldest} days past due. Reminders for the ${opts.drafts.length} largest balances are drafted in Next steps. Nothing is sent until you approve and send them yourself.`,
      impact: Math.round(total * opts.recoveryPct),
      urgency: oldest > 30 ? "now" : "this week",
      confidence: 0.7,
      risk: 0.1,
      draftIds: opts.drafts.map((d) => d.id),
      sources: ids,
    });
  }
  const dupBills = new Set(opts.findings.filter((f) => f.id.startsWith("dup-")).flatMap((f) => f.sources.map((s) => s.id)));
  const due = billsNeedingAttention(data, 10);
  for (const b of due.filter((x) => dupBills.has(x.id))) {
    out.push({
      id: `hold-${b.id}`,
      kind: "hold_bill",
      title: `Hold ${b.vendorName} bill ${b.id} until checked`,
      detail: `${usd(b.open)} due ${dayToDate(data.openingDate, b.due)}: it looks like a possible duplicate.`,
      impact: b.open,
      urgency: "now",
      confidence: 0.5,
      risk: 0.2,
      sources: [b.id],
    });
  }
  const byVendor = new Map<string, typeof due>();
  for (const b of due.filter((x) => !dupBills.has(x.id))) {
    if (!byVendor.has(b.vendorName)) byVendor.set(b.vendorName, []);
    byVendor.get(b.vendorName)!.push(b);
  }
  for (const [vendor, bills] of byVendor) {
    const total = bills.reduce((s, b) => s + b.open, 0);
    const late = bills.filter((b) => b.daysPastDue > 0);
    const last = Math.max(...bills.map((b) => b.due));
    out.push({
      id: `pay-${vendor}`,
      kind: "pay_bill",
      title: `${late.length ? "Pay overdue" : "Schedule"} ${vendor}: ${bills.length > 1 ? `${bills.length} bills, ` : ""}${usd(total)}`,
      detail: `${bills.map((b) => `${b.id} ${usd(b.open)} due ${dayToDate(data.openingDate, b.due)}`).join("; ")}${late.length ? `. ${late.length} already past due.` : ""}`,
      impact: Math.round(total * 0.1), // cost of a missed payment (late fees, supplier trust): rough weight
      urgency: late.length || last <= data.asOfDay + 3 ? "now" : "this week",
      confidence: 1,
      risk: 0,
      sources: bills.map((b) => b.id),
    });
  }
  opts.planChanges.forEach((c, i) => {
    if (/^Chase overdue/.test(c)) return;
    out.push({ id: `plan-${i}`, kind: "plan_step", title: c, detail: "Part of the recommended plan. Edit the assumptions below to see how it changes.", impact: 0, urgency: "this quarter", confidence: 0.8, risk: 0.2, sources: [] });
  });
  for (const l of opts.leaks.slice(0, 2)) {
    // Impact over the next quarter, to compare with cash actions on the same footing.
    out.push({ id: `review-${l.id}`, kind: "cost_review", title: `Review: ${l.title}`, detail: l.detail, impact: Math.round(l.annualImpact / 4), urgency: "this month", confidence: l.confidence, risk: 0.1, sources: l.sources.map((s) => s.id).slice(0, 6) });
  }
  // Plan steps carry no direct dollar impact; rank them after the dated actions they depend on.
  return out
    .map((a) => ({ ...a, score: a.kind === "plan_step" ? 1 : score(a) }))
    .sort((a, b) => b.score - a.score);
}
