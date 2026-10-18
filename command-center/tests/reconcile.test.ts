// Cross-checks the engine against the dataset's own reports for all companies.
import { describe, expect, it } from "vitest";
import { listCompanies, loadCompany } from "../src/lib/data/load";
import { openingCash } from "../src/lib/engine/cash";
import { openBills } from "../src/lib/engine/payables";
import { agingBuckets, openReceivables } from "../src/lib/engine/receivables";

const companies = listCompanies().map((c) => c.id);

describe("engine reconciles with the dataset's reports", () => {
  it.each(companies)("%s: open receivables equal the AR aging report", (id) => {
    const d = loadCompany(id);
    const b = agingBuckets(openReceivables(d));
    expect(b.total).toBe(d.arAging.total);
    for (const k of ["current", "1-30", "31-60", "61-90", "90+"] as const) {
      expect(b[k]).toBe(d.arAging.buckets[k] ?? 0);
    }
  });

  it.each(companies)("%s: open bills equal the AP aging report", (id) => {
    const d = loadCompany(id);
    const total = openBills(d).reduce((s, b) => s + b.open, 0);
    expect(total).toBe(d.apAging.total);
  });

  it.each(companies)("%s: opening cash equals balance-sheet checking", (id) => {
    const d = loadCompany(id);
    const checking = d.balanceSheet.end.lines.find((l) => l.accountId === "acct-checking")?.amount ?? 0;
    expect(openingCash(d).cash).toBe(checking);
  });
});
