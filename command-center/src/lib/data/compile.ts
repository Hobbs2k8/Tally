// Compiles one company's realized-world YAML into the compact CompanyData JSON.
// Node only (used by scripts/build-data.ts and as a fallback by the loader).
// Never reads a hidden/ folder: that is simulation ground truth, not books.
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type {
  AgingReport,
  BalanceSnapshot,
  CompanyData,
  CompanySummary,
  PnlMonth,
} from "./types";
import { dateToDay } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export function cents(s: string | number | null | undefined): number {
  if (s === null || s === undefined || s === "") return 0;
  const str = String(s).trim();
  const neg = str.startsWith("-");
  const [whole, frac = ""] = str.replace("-", "").split(".");
  const c = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -c : c;
}

export function worldDir(sourceDir: string, companyId: string): string {
  const base = path.join(sourceDir, companyId, "rwm-v4");
  const worlds = fs.readdirSync(base).filter((d) => d.startsWith("world-"));
  if (!worlds.length) throw new Error(`No world folder under ${base}`);
  return path.join(base, worlds[0]);
}

function load(dir: string, name: string): any {
  if (name.split("/").includes("hidden")) throw new Error("hidden/ is off limits");
  const file = path.join(dir, `${name}.yaml`);
  if (!fs.existsSync(file)) return [];
  return yaml.load(fs.readFileSync(file, "utf8")) ?? [];
}

const KEEP_JOURNAL = new Set([
  "opening_equity",
  "owner_distribution",
  "interest_accrual",
  "depreciation",
  "bad_debt",
  "inventory_disposal",
  "financing_draw",
  "financing_repayment",
  "deposit_receipt",
  "deposit_refund",
  "client_default",
  "project_wind_down",
]);

function pnlLines(lines: Row[]) {
  const get = (line: string) => cents(lines.find((l) => l.line === line)?.amount);
  return {
    revenue: get("Revenue"),
    cogs: get("Cost of goods and job costs"),
    wages: get("Wages"),
    opex: get("Operating expenses"),
    depreciation: get("Depreciation"),
    badDebt: get("Bad debts"),
    interest: get("Interest"),
    tax: get("Income tax"),
  };
}

function snapshot(s: Row): BalanceSnapshot {
  const lines: BalanceSnapshot["lines"] = [];
  for (const [section, rows] of Object.entries(s.sections ?? {})) {
    for (const r of rows as Row[]) {
      lines.push({ section, accountId: r.account_id, name: r.name, amount: cents(r.amount) });
    }
  }
  return { day: s.as_of_sim_day, date: s.as_of_date, lines };
}

function aging(r: Row, openingDate: string): AgingReport {
  const buckets: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.buckets ?? {})) buckets[k] = cents(v as string);
  return {
    buckets,
    total: cents(r.total_outstanding),
    rows: (r.rows ?? []).map((x: Row) => ({
      documentId: x.document_id,
      party: x.party,
      dueDay: dateToDay(openingDate, x.due_date),
      daysPastDue: x.days_past_due,
      bucket: x.bucket,
      balance: cents(x.balance),
    })),
  };
}

export function compileCompany(sourceDir: string, companyId: string, indexRow?: Row): CompanyData {
  const dir = worldDir(sourceDir, companyId);
  const companyRaw = load(dir, "company");
  const company: Row = Array.isArray(companyRaw) ? companyRaw[0] : companyRaw;
  const openingDate: string = company.opening_date;

  const items: Row[] = load(dir, "items");
  const itemCost = new Map(items.map((i) => [i.id, cents(i.unit_cost_amount)]));

  const pnlRaw: Row = load(dir, "reports/profit_and_loss");
  const bsRaw: Row = load(dir, "reports/balance_sheet");
  const asOfDay = dateToDay(openingDate, pnlRaw.period_end_date);

  const monthly: PnlMonth[] = (pnlRaw.monthly ?? []).map((m: Row) => ({
    monthEnd: m.month_end_date,
    monthEndDay: m.month_end_sim_day,
    full: m.full_calendar_month,
    days: m.days_covered,
    ...pnlLines(m.lines),
    net: cents(m.net_profit),
  }));

  return {
    id: companyId,
    name: company.trade_name,
    legalName: company.legal_name,
    industry: company.industry_title,
    profile: indexRow?.profile ?? "unknown",
    sizeTier: indexRow?.size_tier ?? "unknown",
    distressed: Boolean(indexRow?.distressed),
    status: indexRow?.business_status ?? "unknown",
    openingDate,
    asOfDay,
    customers: (load(dir, "customers") as Row[]).map((c) => ({
      id: c.id,
      name: c.display_name,
      termsDays: c.payment_terms_days ?? 0,
      creditLimit: cents(c.credit_limit_amount),
      email: c.email ?? "",
      ended: c.ended_sim_day ?? null,
    })),
    vendors: (load(dir, "vendors") as Row[]).map((v) => ({
      id: v.id,
      name: v.display_name,
      role: v.supply_role,
      termsDays: v.payment_terms_days ?? 0,
    })),
    employees: (load(dir, "employees") as Row[]).map((e) => ({
      id: e.id,
      name: e.display_name,
      title: e.job_title,
      weeklyWage: cents(e.weekly_wage_amount),
      hired: e.hired_sim_day,
      released: e.released_sim_day ?? null,
    })),
    invoices: (load(dir, "invoices") as Row[]).map((i) => {
      const line = i.lines?.[0];
      const unitCost = line ? itemCost.get(line.item_id) : undefined;
      return {
        id: i.id,
        customerId: i.customer_id,
        day: i.txn_sim_day,
        due: i.due_sim_day,
        total: cents(i.total_amount),
        retainage: cents(i.retainage_amount),
        deposit: cents(i.deposit_applied_amount),
        projectId: i.project_id ?? null,
        item: line?.item_name ?? "",
        estCost: unitCost && line ? Math.round(unitCost * Number(line.quantity)) : null,
      };
    }),
    customerPayments: (load(dir, "customer_payments") as Row[]).map((p) => ({
      id: p.id,
      customerId: p.customer_id,
      day: p.txn_sim_day,
      amount: cents(p.amount),
      settles: p.settles,
      apps: (p.applications ?? []).map((a: Row) => ({ docId: a.document_id, amount: cents(a.amount) })),
    })),
    salesReceipts: (load(dir, "sales_receipts") as Row[]).map((s) => ({
      id: s.id,
      day: s.txn_sim_day,
      total: cents(s.total_amount),
    })),
    bills: (load(dir, "bills") as Row[]).map((b) => ({
      id: b.id,
      vendorId: b.vendor_id,
      kind: b.expense_kind,
      category: b.cost_category,
      day: b.txn_sim_day,
      due: b.due_sim_day,
      total: cents(b.total_amount),
      projectId: b.project_id ?? null,
      memo: b.memo ?? "",
    })),
    billPayments: (load(dir, "bill_payments") as Row[]).map((p) => ({
      id: p.id,
      vendorId: p.vendor_id,
      day: p.txn_sim_day,
      amount: cents(p.amount),
      apps: (p.applications ?? []).map((a: Row) => ({ docId: a.document_id, amount: cents(a.amount) })),
    })),
    bank: (load(dir, "bank_transactions") as Row[]).map((t) => ({
      id: t.id,
      day: t.sim_day,
      amount: cents(t.amount),
      balance: cents(t.running_balance_amount),
      source: t.source_document_id,
      kind: t.kind,
      memo: t.memo ?? "",
    })),
    journal: (load(dir, "journal_entries") as Row[])
      .filter((j) => KEEP_JOURNAL.has(j.purpose))
      .map((j) => {
        const lines: Row[] = j.lines ?? [];
        const withCustomer = lines.find((l) => l.customer_id);
        const withDoc = lines.find((l) => l.document_id);
        return {
          id: j.id,
          purpose: j.purpose,
          day: j.txn_sim_day,
          amount: lines.reduce((s, l) => s + cents(l.debit_amount), 0),
          memo: j.memo ?? "",
          customerId: withCustomer?.customer_id ?? null,
          documentId: withDoc?.document_id ?? null,
        };
      }),
    payroll: (load(dir, "payroll_runs") as Row[]).map((r) => ({
      id: r.id,
      day: r.sim_day,
      total: cents(r.total_amount),
      lines: (r.lines ?? []).map((l: Row) => ({ employeeId: l.employee_id, amount: cents(l.gross_amount) })),
    })),
    pnl: {
      full: { ...pnlLines(pnlRaw.full_period?.lines ?? []), net: cents(pnlRaw.full_period?.net_profit) },
      monthly,
    },
    balanceSheet: {
      end: snapshot(bsRaw.period_end),
      quarters: (bsRaw.quarter_end ?? []).map(snapshot),
    },
    arAging: aging(load(dir, "reports/ar_aging"), openingDate),
    apAging: aging(load(dir, "reports/ap_aging"), openingDate),
  };
}

export function summarize(row: Row, data?: CompanyData): CompanySummary {
  const f = row.financials_cents ?? {};
  return {
    id: row.company_id,
    name: row.display_name,
    industry: row.industry_title,
    profile: row.profile,
    sizeTier: row.size_tier,
    distressed: Boolean(row.distressed),
    status: row.business_status,
    cash: f.cash ?? 0,
    revenue: f.revenue ?? 0,
    profit: f.profit ?? 0,
    receivables: f.receivables ?? 0,
    payables: f.payables ?? 0,
    employees: data ? data.employees.filter((e) => e.released === null).length : 0,
  };
}
