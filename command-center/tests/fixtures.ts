// Minimal synthetic CompanyData builder for edge-case tests.
import type { CompanyData } from "../src/lib/data/types";

export function emptyCompany(overrides: Partial<CompanyData> = {}): CompanyData {
  return {
    id: "test-co",
    name: "Test Co",
    legalName: "Test Co LLC",
    industry: "Testing",
    profile: "wholesale",
    sizeTier: "small",
    distressed: false,
    status: "open",
    openingDate: "2025-10-06",
    asOfDay: 365,
    customers: [],
    vendors: [],
    employees: [],
    invoices: [],
    customerPayments: [],
    salesReceipts: [],
    bills: [],
    billPayments: [],
    bank: [],
    journal: [],
    payroll: [],
    pnl: {
      full: { revenue: 0, cogs: 0, wages: 0, opex: 0, depreciation: 0, badDebt: 0, interest: 0, tax: 0, net: 0 },
      monthly: [],
    },
    balanceSheet: { end: { day: 365, date: "2026-10-06", lines: [] }, quarters: [] },
    arAging: { buckets: {}, total: 0, rows: [] },
    apAging: { buckets: {}, total: 0, rows: [] },
    ...overrides,
  };
}

export function bank(day: number, amount: number, balance: number, kind = "customer_payment", id = `b-${day}-${amount}`) {
  return { id, day, amount, balance, source: id, kind, memo: "" };
}
