// Recurring expense and payroll detection from bill and employee history.
import type { CompanyData } from "../data/types";

export interface RecurringExpense {
  key: string; // vendorId|category
  vendorId: string;
  vendorName: string;
  category: string;
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly";
  intervalDays: number;
  amount: number; // median of the last three bills, cents
  amountCv: number; // coefficient of variation of recent amounts
  fixed: boolean; // regular cadence and stable amount
  lastDay: number;
  nextDay: number;
  payLagDays: number; // median days from bill to due
  occurrences: number;
  billIds: string[];
}

const CADENCES: { name: RecurringExpense["cadence"]; days: number; lo: number; hi: number }[] = [
  { name: "weekly", days: 7, lo: 5, hi: 9 },
  { name: "biweekly", days: 14, lo: 12, hi: 16 },
  { name: "monthly", days: 30, lo: 26, hi: 35 },
  { name: "quarterly", days: 91, lo: 80, hi: 100 },
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function cv(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  if (!mean) return 0;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}

export function detectRecurring(data: CompanyData, asOf = data.asOfDay): RecurringExpense[] {
  const vendors = new Map(data.vendors.map((v) => [v.id, v]));
  const groups = new Map<string, typeof data.bills>();
  for (const b of data.bills) {
    if (b.day > asOf || b.projectId) continue; // job costs are not recurring overhead
    const key = `${b.vendorId}|${b.category}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }
  const out: RecurringExpense[] = [];
  for (const [key, bills] of groups) {
    bills.sort((a, b) => a.day - b.day);
    if (bills.length < 3) continue;
    const intervals = bills.slice(1).map((b, i) => b.day - bills[i].day);
    const med = median(intervals);
    const cadence = CADENCES.find((c) => med >= c.lo && med <= c.hi);
    if (!cadence) continue;
    const regular = intervals.filter((d) => Math.abs(d - med) <= med * 0.4).length / intervals.length;
    if (regular < 0.7) continue;
    const last = bills[bills.length - 1];
    if (last.day < asOf - cadence.days * 1.5) continue; // stopped
    const recent = bills.slice(-8).map((b) => b.total);
    const amount = Math.round(median(bills.slice(-3).map((b) => b.total)));
    const amountCv = cv(recent);
    out.push({
      key,
      vendorId: last.vendorId,
      vendorName: vendors.get(last.vendorId)?.name ?? last.vendorId,
      category: last.category,
      cadence: cadence.name,
      intervalDays: Math.round(med),
      amount,
      amountCv,
      fixed: amountCv < 0.25,
      lastDay: last.day,
      nextDay: last.day + Math.round(med),
      payLagDays: Math.max(0, Math.round(median(bills.map((b) => b.due - b.day)))),
      occurrences: bills.length,
      billIds: bills.map((b) => b.id),
    });
  }
  return out.sort((a, b) => b.amount / b.intervalDays - a.amount / a.intervalDays);
}

export interface PayrollPicture {
  activeEmployees: { id: string; name: string; title: string; weeklyWage: number }[];
  weeklyPayroll: number; // from current wage rates
  trailing4WeekAvg: number; // from actual payroll runs, for cross-checking
  medianWeeklyWage: number;
  runIds: string[];
}

export function payrollPicture(data: CompanyData, asOf = data.asOfDay): PayrollPicture {
  const active = data.employees.filter((e) => e.hired <= asOf && (e.released === null || e.released > asOf));
  const weekly = active.reduce((s, e) => s + e.weeklyWage, 0);
  const recentRuns = data.payroll.filter((r) => r.day > asOf - 28 && r.day <= asOf);
  const wages = active.map((e) => e.weeklyWage);
  return {
    activeEmployees: active.map((e) => ({ id: e.id, name: e.name, title: e.title, weeklyWage: e.weeklyWage })),
    weeklyPayroll: weekly,
    trailing4WeekAvg: Math.round(recentRuns.reduce((s, r) => s + r.total, 0) / 4),
    medianWeeklyWage: wages.length ? Math.round(median(wages)) : 0,
    runIds: recentRuns.map((r) => r.id),
  };
}
