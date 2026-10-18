// Plants known anomalies into a COPY of a company's data (never the app's data).
// What is planted is returned and written to the eval report.
import type { CompanyData } from "../src/lib/data/types";
import type { Plant } from "./cases";

export function plantAnomalies(clean: CompanyData): { data: CompanyData; planted: Plant[] } {
  const data: CompanyData = { ...clean, bills: [...clean.bills] };
  const planted: Plant[] = [];
  const asOf = clean.asOfDay;
  const recent = clean.bills.filter((b) => b.day > asOf - 60 && b.day <= asOf - 5 && b.total >= 20_000).sort((a, b) => b.total - a.total);

  // 1. Duplicate: the largest recent bill entered again one day later (same vendor, amount, category).
  const src = recent[0] ?? clean.bills.filter((b) => b.day <= asOf).at(-1)!;
  const dupId = `planted-dup-${src.id}`;
  data.bills.push({ ...src, id: dupId, day: src.day + 1, due: src.due + 1, memo: src.memo });
  planted.push({ companyId: clean.id, kind: "duplicate_bill", plantedId: dupId });

  // 2. Unusual expense: a bill from a vendor/category with steady history at 8x its median.
  const groups = new Map<string, typeof clean.bills>();
  for (const b of clean.bills) {
    if (b.day > asOf || b.category === "income_tax") continue;
    const k = `${b.vendorId}|${b.category}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(b);
  }
  const steady = [...groups.values()].filter((g) => g.length >= 6).sort((a, b) => b.length - a.length)[0];
  if (steady) {
    const amounts = steady.map((b) => b.total).sort((a, b) => a - b);
    const med = amounts[Math.floor(amounts.length / 2)];
    const last = steady[steady.length - 1];
    const spikeId = `planted-spike-${last.id}`;
    data.bills.push({ ...last, id: spikeId, day: asOf - 10, due: asOf - 3, total: Math.max(med * 8, med + 100_000), memo: last.memo });
    planted.push({ companyId: clean.id, kind: "unusual_expense", plantedId: spikeId });
  }
  return { data, planted };
}
