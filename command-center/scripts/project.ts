// Prints the 90-day baseline cash projection for a company.
//   npm run project               # demo company
//   npm run project -- company-021
import { loadCompany } from "../src/lib/data/load";
import { dayToDate } from "../src/lib/data/types";
import { buildInputs } from "../src/lib/engine/baseline";
import { runway } from "../src/lib/engine/cash";
import { usd } from "../src/lib/engine/format";
import { NO_LEVERS } from "../src/lib/engine/model";
import { project } from "../src/lib/engine/projection";
import { agingBuckets, openReceivables } from "../src/lib/engine/receivables";
import { DEMO_COMPANY_ID } from "../src/lib/demo";

const id = process.argv[2] ?? DEMO_COMPANY_ID;
const data = loadCompany(id);
const inputs = buildInputs(data);
const p = project(inputs, NO_LEVERS, inputs.defaultReserve);
const aging = agingBuckets(openReceivables(data));
const rw = runway(data);
const d = (day: number) => dayToDate(data.openingDate, day);

console.log(`\n${data.name} (${id}) · ${data.industry} · as of ${d(data.asOfDay)}`);
console.log(`Opening cash ${usd(inputs.openingCash)} · reserve ${usd(inputs.defaultReserve)} (4 weeks of fixed costs)`);
console.log(`Runway: ${rw.weeks === null ? "cash-generative over the last 13 weeks" : rw.weeks.toFixed(1) + " weeks"} (weekly operating net ${usd(rw.weeklyOperatingNet)})`);
console.log(`Receivables ${usd(aging.total)} · overdue ${usd(aging.overdue)} · 90+ ${usd(aging["90+"])}`);
console.log(`Weekly drivers: invoiced sales ${usd(inputs.weeklyInvoicedSales)}, POS ${usd(inputs.weeklyPosSales)}, payroll ${usd(inputs.weeklyPayroll)}, overhead ${usd(inputs.weeklyOverhead)}, variable cost ratio ${(inputs.variableCostRatio * 100).toFixed(1)}%`);
console.log(`Recurring: ${inputs.recurring.map((r) => `${r.vendorName} ${r.category} ${usd(r.amount)}/${r.intervalDays}d`).join("; ")}\n`);
console.log("week  ending      opening      in        out     closing");
for (const w of p.weeks) {
  const inflow = w.inflows.openAR + w.inflows.newSales + w.inflows.pos + w.inflows.recovered;
  console.log(
    `${String(w.week + 1).padStart(4)}  ${d(w.endDay)}  ${usd(w.opening).padStart(9)} ${usd(inflow).padStart(9)} ${usd(inflow - w.net).padStart(9)} ${usd(w.closing).padStart(9)}${w.closing < p.reserve ? "  < reserve" : ""}`,
  );
}
const s = p.summary;
console.log(`\nEnding cash ${usd(s.endingCash)} · minimum ${usd(s.minCash)} (week ${s.minWeek + 1}) · weeks below reserve ${s.weeksBelowReserve}`);
console.log(`Projected revenue ${usd(s.revenue)} · operating profit ${usd(s.operatingProfit)} · margin ${s.margin === null ? "n/a" : (s.margin * 100).toFixed(1) + "%"}\n`);
