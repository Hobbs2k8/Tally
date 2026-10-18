// Resolves a source record id to a readable record plus related records, for
// the evidence drawer. Server-side; scoped to one company.
import type { CompanyData } from "./data/types";
import { dayToDate } from "./data/types";
import { usd } from "./engine/format";
import { effectiveDue } from "./engine/receivables";

export interface EvidenceRecord {
  id: string;
  type: string;
  title: string;
  fields: [string, string][];
  related: { id: string; label: string }[];
}

export function lookupEvidence(data: CompanyData, id: string): EvidenceRecord | null {
  const date = (d: number) => dayToDate(data.openingDate, d);
  const customers = new Map(data.customers.map((c) => [c.id, c]));
  const vendors = new Map(data.vendors.map((v) => [v.id, v]));

  const inv = data.invoices.find((i) => i.id === id);
  if (inv) {
    const pays = data.customerPayments.filter((p) => p.apps.some((a) => a.docId === id));
    const wo = data.journal.filter((j) => j.documentId === id);
    const paid = pays.reduce((s, p) => s + p.apps.filter((a) => a.docId === id && p.day <= data.asOfDay && p.settles !== "retainage").reduce((x, a) => x + a.amount, 0), 0);
    const due = effectiveDue(inv, customers.get(inv.customerId));
    const open = inv.total - inv.deposit - inv.retainage - paid - wo.reduce((s, j) => s + j.amount, 0);
    return {
      id,
      type: "Invoice",
      title: `Invoice ${id} · ${customers.get(inv.customerId)?.name ?? inv.customerId}`,
      fields: [
        ["Customer", customers.get(inv.customerId)?.name ?? inv.customerId],
        ["Issued", date(inv.day)],
        ["Due", `${date(due)}${inv.due === null ? " (no due date on record: customer terms used)" : ""}`],
        ["Item", inv.item],
        ["Total", usd(inv.total)],
        ...(inv.deposit ? ([["Deposit applied", usd(inv.deposit)]] as [string, string][]) : []),
        ...(inv.retainage ? ([["Retainage withheld", usd(inv.retainage)]] as [string, string][]) : []),
        ["Paid to date", usd(paid)],
        ["Open balance", usd(Math.max(0, open))],
        ["Status", open > 0 ? (data.asOfDay > due ? `Open, ${data.asOfDay - due} days past due` : "Open, not yet due") : "Settled"],
      ],
      related: [
        ...pays.map((p) => ({ id: p.id, label: `Payment ${usd(p.amount)} on ${date(p.day)}` })),
        ...wo.map((j) => ({ id: j.id, label: `Write-off ${usd(j.amount)} on ${date(j.day)}` })),
      ],
    };
  }

  const pay = data.customerPayments.find((p) => p.id === id);
  if (pay) {
    const bank = data.bank.find((t) => t.source === id);
    return {
      id,
      type: "Customer payment",
      title: `Payment ${id} · ${customers.get(pay.customerId)?.name ?? pay.customerId}`,
      fields: [
        ["Customer", customers.get(pay.customerId)?.name ?? pay.customerId],
        ["Settled", date(pay.day)],
        ["Amount", usd(pay.amount)],
        ["Settles", pay.settles],
      ],
      related: [...pay.apps.map((a) => ({ id: a.docId, label: `Applied ${usd(a.amount)} to ${a.docId}` })), ...(bank ? [{ id: bank.id, label: `Bank line ${bank.id}` }] : [])],
    };
  }

  const bill = data.bills.find((b) => b.id === id);
  if (bill) {
    const pays = data.billPayments.filter((p) => p.apps.some((a) => a.docId === id));
    return {
      id,
      type: "Bill",
      title: `Bill ${id} · ${vendors.get(bill.vendorId)?.name ?? bill.vendorId}`,
      fields: [
        ["Vendor", vendors.get(bill.vendorId)?.name ?? bill.vendorId],
        ["Category", bill.category.replace(/_/g, " ")],
        ["Received", date(bill.day)],
        ["Due", date(bill.due)],
        ["Total", usd(bill.total)],
        ["Memo", bill.memo || "—"],
      ],
      related: pays.map((p) => ({ id: p.id, label: `Paid ${usd(p.amount)} on ${date(p.day)}` })),
    };
  }

  const bp = data.billPayments.find((p) => p.id === id);
  if (bp) {
    return {
      id,
      type: "Bill payment",
      title: `Bill payment ${id} · ${vendors.get(bp.vendorId)?.name ?? bp.vendorId}`,
      fields: [
        ["Vendor", vendors.get(bp.vendorId)?.name ?? bp.vendorId],
        ["Paid", date(bp.day)],
        ["Amount", usd(bp.amount)],
      ],
      related: bp.apps.map((a) => ({ id: a.docId, label: `Applied ${usd(a.amount)} to ${a.docId}` })),
    };
  }

  const bank = data.bank.find((t) => t.id === id);
  if (bank) {
    return {
      id,
      type: "Bank transaction",
      title: `Bank line ${id}`,
      fields: [
        ["Date", date(bank.day)],
        ["Amount", usd(bank.amount, { sign: true })],
        ["Balance after", usd(bank.balance)],
        ["Kind", bank.kind.replace(/_/g, " ")],
        ["Memo", bank.memo],
      ],
      related: [{ id: bank.source, label: `Source document ${bank.source}` }],
    };
  }

  const je = data.journal.find((j) => j.id === id);
  if (je) {
    return {
      id,
      type: "Journal entry",
      title: `Journal entry ${id}`,
      fields: [
        ["Purpose", je.purpose.replace(/_/g, " ")],
        ["Date", date(je.day)],
        ["Amount", usd(je.amount)],
        ["Memo", je.memo],
      ],
      related: je.documentId ? [{ id: je.documentId, label: `Document ${je.documentId}` }] : [],
    };
  }

  const emp = data.employees.find((e) => e.id === id);
  if (emp) {
    return {
      id,
      type: "Employee",
      title: emp.name,
      fields: [
        ["Role", emp.title],
        ["Weekly wage", usd(emp.weeklyWage)],
        ["Hired", date(emp.hired)],
        ["Released", emp.released === null ? "active" : date(emp.released)],
      ],
      related: [],
    };
  }

  const run = data.payroll.find((r) => r.id === id);
  if (run) {
    return { id, type: "Payroll run", title: `Payroll run ${id}`, fields: [["Date", date(run.day)], ["Total", usd(run.total)]], related: run.lines.map((l) => ({ id: l.employeeId, label: `${l.employeeId}: ${usd(l.amount)}` })) };
  }

  if (id.startsWith("pnl:")) {
    const month = id.slice(4);
    const m = data.pnl.monthly.find((x) => x.monthEnd.startsWith(month));
    if (m) {
      return {
        id,
        type: "P&L month",
        title: `Profit and loss · ${month}${m.full ? "" : ` (partial: ${m.days} days)`}`,
        fields: [
          ["Revenue", usd(m.revenue)],
          ["Cost of goods", usd(m.cogs)],
          ["Gross margin", m.revenue ? `${(((m.revenue - m.cogs) / m.revenue) * 100).toFixed(1)}%` : "—"],
          ["Wages", usd(m.wages)],
          ["Operating expenses", usd(m.opex)],
          ["Bad debts", usd(m.badDebt)],
          ["Income tax", usd(m.tax)],
          ["Net profit", usd(m.net)],
        ],
        related: [],
      };
    }
  }

  if (id.startsWith("balance_sheet:")) {
    const acct = id.slice("balance_sheet:".length);
    const l = data.balanceSheet.end.lines.find((x) => x.accountId === acct);
    if (l) return { id, type: "Balance sheet line", title: `${l.name} (${l.section})`, fields: [["As of", data.balanceSheet.end.date], ["Balance", usd(l.amount)]], related: [] };
  }

  if (id.startsWith("report:")) {
    const r = id.slice(7);
    const f = data.pnl.full;
    if (r === "profit_and_loss") return { id, type: "Report", title: "Profit and loss, full year", fields: [["Revenue", usd(f.revenue)], ["Cost of goods", usd(f.cogs)], ["Wages", usd(f.wages)], ["Operating expenses", usd(f.opex)], ["Net profit", usd(f.net)]], related: [] };
    if (r === "ar_aging") return { id, type: "Report", title: "Accounts receivable aging", fields: Object.entries(data.arAging.buckets).map(([k, v]) => [k, usd(v)] as [string, string]).concat([["Total", usd(data.arAging.total)]]), related: data.arAging.rows.slice(0, 15).map((x) => ({ id: x.documentId, label: `${x.party} · ${usd(x.balance)}` })) };
    if (r === "ap_aging") return { id, type: "Report", title: "Accounts payable aging", fields: Object.entries(data.apAging.buckets).map(([k, v]) => [k, usd(v)] as [string, string]).concat([["Total", usd(data.apAging.total)]]), related: data.apAging.rows.slice(0, 15).map((x) => ({ id: x.documentId, label: `${x.party} · ${usd(x.balance)}` })) };
  }
  return null;
}
