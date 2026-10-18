// Plain-LLM baseline: Gemini receives the same retrieved records our engine
// uses (as a compact text summary) and answers directly, with no engine.
import { z } from "zod";
import type { CompanyData } from "../src/lib/data/types";
import { dayToDate } from "../src/lib/data/types";
import type { ProjectionInputs } from "../src/lib/engine/model";
import type { GenerateClient } from "../src/lib/providers/gemini";
import { geminiSchema } from "../src/lib/providers/gemini";
import type { Usage } from "../src/lib/providers/types";

const d$ = (c: number) => (c / 100).toFixed(2);

/** The records our pipeline retrieves, as text. Same inputs, no engine. */
export function recordsSummary(d: CompanyData, inputs: ProjectionInputs): string {
  const date = (day: number) => dayToDate(d.openingDate, day);
  const lines: string[] = [];
  lines.push(`Company: ${d.name} (${d.industry}). Books as of ${date(d.asOfDay)}. Amounts in USD.`);
  lines.push(`Bank balance (checking) on ${date(d.asOfDay)}: ${d$(inputs.openingCash)}`);
  lines.push(`\nOpen customer invoices (id, customer, due date, open balance):`);
  for (const a of inputs.openAR) lines.push(`${a.invoiceId}, ${a.customerName}, ${date(a.expectedDay - 0)} expected / ${a.daysPastDue} days past due, ${d$(a.amount)}`);
  lines.push(`\nOpen vendor bills (id, vendor, category, due date, amount):`);
  for (const b of inputs.openAP) lines.push(`${b.billId}, ${b.vendorName}, ${b.category}, ${date(b.dueDay)}, ${d$(b.amount)}`);
  lines.push(`\nEmployees (active): ${d.employees.filter((e) => e.released === null).map((e) => `${e.name} ${e.title} ${d$(e.weeklyWage)}/week`).join("; ")}`);
  lines.push(`\nRecurring bills: ${inputs.recurring.map((r) => `${r.vendorName} ${r.category} ${d$(r.amount)} every ${r.intervalDays} days`).join("; ")}`);
  lines.push(`\nLast 13 weeks: invoiced sales ${d$(inputs.weeklyInvoicedSales)}/week, register sales ${d$(inputs.weeklyPosSales)}/week, supplier purchases ${(inputs.variableCostRatio * 100).toFixed(1)}% of sales.`);
  lines.push(`\nWeekly closing bank balance, last 26 weeks: ${inputs.history.map((h) => `${date(h.endDay)} ${d$(h.closing)}`).join("; ")}`);
  lines.push(`\nMonthly P&L (month, revenue, COGS, wages, opex, net):`);
  for (const m of d.pnl.monthly) lines.push(`${m.monthEnd}${m.full ? "" : " (partial)"}, ${d$(m.revenue)}, ${d$(m.cogs)}, ${d$(m.wages)}, ${d$(m.opex)}, ${d$(m.net)}`);
  lines.push(`\nBalance sheet ${d.balanceSheet.end.date}: ${d.balanceSheet.end.lines.map((l) => `${l.name} ${d$(l.amount)}`).join("; ")}`);
  lines.push(`\nOwner draws this year: ${d.journal.filter((j) => j.purpose === "owner_distribution").map((j) => `${date(j.day)} ${d$(j.amount)}`).join("; ") || "none"}`);
  return lines.join("\n");
}

const AnswerSchema = z.object({
  answerText: z.string(),
  cash: z.number().nullable().describe("Current bank balance in dollars"),
  totalReceivables: z.number().nullable(),
  overdueReceivables: z.number().nullable(),
  netProfitYear: z.number().nullable(),
  planIsSafe: z.boolean().nullable().describe("For decisions: true if your recommended plan keeps cash above the reserve and never below zero if customers pay 30 days late"),
  plan: z
    .object({
      hireCount: z.number().int().nullable(),
      hireStartWeek: z.number().int().nullable().describe("1 = first week"),
      ownerDrawAmount: z.number().nullable(),
      ownerDrawWeek: z.number().int().nullable(),
      marketingMonthly: z.number().nullable(),
    })
    .nullable(),
});

const SYSTEM = `You are a financial analyst for a small business. Answer the owner's question using ONLY the records provided.
Report the requested figures in dollars. If the owner asks for a plan, give a concrete plan for the next 13 weeks (hires and start week, owner draw amount and week, marketing per month) that keeps cash above a reserve of about 4 weeks of fixed costs (or the reserve the owner states) and never below zero even if customers pay 30 days late.`;

export async function plainLlmCase(client: GenerateClient, model: string, d: CompanyData, inputs: ProjectionInputs, question: string) {
  const r = await client.generate({ model, system: SYSTEM, user: `RECORDS:\n${recordsSummary(d, inputs)}\n\nQUESTION: ${question}`, jsonSchema: geminiSchema(AnswerSchema), maxOutputTokens: 1500 });
  const answer = AnswerSchema.parse(JSON.parse(r.text));
  const usage: Usage = { calls: 1, inputTokens: r.inputTokens, outputTokens: r.outputTokens, model };
  return { answer, usage };
}

const AnomalySchema = z.object({ suspiciousBillIds: z.array(z.string()), notes: z.string() });

export async function plainLlmAnomalies(client: GenerateClient, model: string, d: CompanyData) {
  const vendors = new Map(d.vendors.map((v) => [v.id, v.name]));
  const bills = d.bills.filter((b) => b.day > d.asOfDay - 120 && b.day <= d.asOfDay).sort((a, b) => a.day - b.day);
  const list = bills.map((b) => `${b.id}, ${dayToDate(d.openingDate, b.day)}, ${vendors.get(b.vendorId) ?? b.vendorId}, ${b.category}, ${d$(b.total)}`).join("\n");
  const r = await client.generate({
    model,
    system: "You review a small business's vendor bills for possible duplicates and unusually large charges. Return the ids of suspicious bills only.",
    user: `Bills from the last 120 days (id, date, vendor, category, amount):\n${list}`,
    jsonSchema: geminiSchema(AnomalySchema),
    maxOutputTokens: 800,
  });
  const parsed = AnomalySchema.parse(JSON.parse(r.text));
  return { ids: parsed.suspiciousBillIds, usage: { calls: 1, inputTokens: r.inputTokens, outputTokens: r.outputTokens, model } as Usage };
}
