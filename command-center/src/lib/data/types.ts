// Compact, typed view of one company's books, compiled from the hackathon YAML.
// Money is integer cents. Dates are simulation days (day 0 = books open);
// `dayToDate` converts back to calendar dates for display.

export type Cents = number;

export interface CompanySummary {
  id: string;
  name: string;
  industry: string;
  profile: string; // wholesale | construction | mixed | recurring | pos | appointment | nonprofit
  sizeTier: string;
  distressed: boolean;
  status: string;
  cash: Cents;
  revenue: Cents;
  profit: Cents;
  receivables: Cents;
  payables: Cents;
  employees: number;
}

export interface Customer {
  id: string;
  name: string;
  termsDays: number;
  creditLimit: Cents;
  email: string;
  ended: number | null;
}

export interface Vendor {
  id: string;
  name: string;
  role: string; // product | subcontract | premises | utility | insurance | lender | government | operating
  termsDays: number;
}

export interface Employee {
  id: string;
  name: string;
  title: string;
  weeklyWage: Cents;
  hired: number;
  released: number | null;
}

export interface Invoice {
  id: string;
  customerId: string;
  day: number;
  /** Due day; null when the source record has none (engine falls back to customer terms). */
  due: number | null;
  total: Cents;
  retainage: Cents;
  deposit: Cents;
  projectId: string | null;
  item: string;
  /** Item cost per unit times quantity where the item carries a unit cost; null otherwise. */
  estCost: Cents | null;
}

export interface Application {
  docId: string;
  amount: Cents;
}

export interface CustomerPayment {
  id: string;
  customerId: string;
  day: number;
  amount: Cents;
  settles: string; // receivable | retainage
  apps: Application[];
}

export interface SalesReceipt {
  id: string;
  day: number;
  total: Cents;
}

export interface Bill {
  id: string;
  vendorId: string;
  kind: string; // product | operating
  category: string; // purchase, utilities, growth, income_tax, ...
  day: number;
  due: number;
  total: Cents;
  projectId: string | null;
  memo: string;
}

export interface BillPayment {
  id: string;
  vendorId: string;
  day: number;
  amount: Cents;
  apps: Application[];
}

export interface BankTxn {
  id: string;
  day: number;
  amount: Cents; // signed: + into checking, - out
  balance: Cents;
  source: string;
  kind: string;
  memo: string;
}

export interface JournalEvent {
  id: string;
  purpose: string;
  day: number;
  amount: Cents; // total debits
  memo: string;
  customerId: string | null;
  documentId: string | null;
}

export interface PayrollRun {
  id: string;
  day: number;
  total: Cents;
  lines: { employeeId: string; amount: Cents }[];
}

export interface PnlMonth {
  monthEnd: string;
  monthEndDay: number;
  full: boolean;
  days: number;
  revenue: Cents;
  cogs: Cents;
  wages: Cents;
  opex: Cents;
  depreciation: Cents;
  badDebt: Cents;
  interest: Cents;
  tax: Cents;
  net: Cents;
}

export interface BalanceSnapshot {
  day: number;
  date: string;
  lines: { section: string; accountId: string; name: string; amount: Cents }[];
}

export interface AgingRow {
  documentId: string;
  party: string;
  dueDay: number;
  daysPastDue: number;
  bucket: string;
  balance: Cents;
}

export interface AgingReport {
  buckets: Record<string, Cents>;
  total: Cents;
  rows: AgingRow[];
}

export interface CompanyData {
  id: string;
  name: string;
  legalName: string;
  industry: string;
  profile: string;
  sizeTier: string;
  distressed: boolean;
  status: string;
  openingDate: string; // calendar date of day 0
  asOfDay: number; // observation day (final simulation day)
  customers: Customer[];
  vendors: Vendor[];
  employees: Employee[];
  invoices: Invoice[];
  customerPayments: CustomerPayment[];
  salesReceipts: SalesReceipt[];
  bills: Bill[];
  billPayments: BillPayment[];
  bank: BankTxn[];
  journal: JournalEvent[];
  payroll: PayrollRun[];
  pnl: { full: Omit<PnlMonth, "monthEnd" | "monthEndDay" | "full" | "days">; monthly: PnlMonth[] };
  balanceSheet: { end: BalanceSnapshot; quarters: BalanceSnapshot[] };
  arAging: AgingReport;
  apAging: AgingReport;
}

const DAY_MS = 86_400_000;

export function dayToDate(openingDate: string, day: number): string {
  const t = Date.parse(openingDate + "T00:00:00Z") + day * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

export function dateToDay(openingDate: string, date: string): number {
  return Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(openingDate + "T00:00:00Z")) / DAY_MS);
}
