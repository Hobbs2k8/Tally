// The structured task every request is turned into (by Gemini or the
// deterministic parser), validated with Zod before anything runs.
import { z } from "zod";

export const DECISION_TYPES = [
  "growth_plan",
  "hiring",
  "marketing",
  "owner_draw",
  "pricing",
  "equipment",
  "payment_terms",
  "cash_question",
  "profit_question",
  "receivables_question",
  "expense_question",
  "anomaly_check",
  "counterfactual",
  "stress_test",
  "general_question",
] as const;

export const QUESTION_KINDS = [
  "none",
  "profit_vs_cash",
  "top_debtors",
  "top_expenses",
  "cash_position",
  "runway",
  "revenue_trend",
  "margin",
] as const;

export const RECORD_TYPES = [
  "invoices",
  "customer_payments",
  "bills",
  "bill_payments",
  "bank",
  "payroll",
  "employees",
  "pnl",
  "balance_sheet",
  "journal",
] as const;

export const CAPABILITIES = [
  "flight_simulator",
  "money_detective",
  "autopilot",
  "profit_leak_radar",
  "future_accountant",
  "time_machine",
  "negotiation_coach",
  "chaos_simulator",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const money = z.number().nonnegative().nullable(); // dollars (not cents) as stated by the user

export const TaskSchema = z.object({
  objective: z.string().min(1).describe("One sentence: what the owner wants to decide or learn."),
  decisionType: z.enum(DECISION_TYPES),
  questionKind: z.enum(QUESTION_KINDS).describe("For plain questions; 'none' for decisions."),
  decisions: z.object({
    hireCount: z.number().int().min(0).max(50).nullable().describe("Number of people to hire, if hiring."),
    hireAnnualSalary: money.describe("Salary per hire per year in dollars, if stated."),
    marketingMonthlyIncrease: money.describe("Extra marketing spend per month in dollars, if stated."),
    marketingIncreaseRequested: z.boolean().describe("True if the owner wants to increase marketing at all."),
    ownerDrawAmount: money.describe("Owner draw / distribution in dollars, if stated."),
    ownerDrawRequested: z.boolean(),
    priceChangePct: z.number().min(-0.5).max(0.5).nullable().describe("Price change as a fraction, e.g. 0.05 for +5%."),
    equipmentAmount: money.describe("One-time equipment or capital purchase in dollars."),
    vendorTermsExtraDays: z.number().int().min(0).max(120).nullable(),
    earlyPayDiscountPct: z.number().min(0).max(0.2).nullable(),
  }),
  stress: z.object({
    requested: z.boolean().describe("True if the owner asks what happens under bad conditions."),
    paymentDelayDays: z.number().int().min(0).max(180).nullable(),
    salesDropPct: z.number().min(0).max(1).nullable(),
    costShockPct: z.number().min(0).max(1).nullable(),
  }),
  wantsInvestigation: z.boolean().describe("Owner asks to investigate, flag problems, or check the books."),
  wantsProfitLeaks: z.boolean(),
  wantsAnomalies: z.boolean(),
  counterfactual: z
    .object({ customerName: z.string().nullable(), kind: z.enum(["on_time_payment"]) })
    .nullable(),
  constraints: z.object({
    minCashReserve: money,
    horizonDays: z.number().int().min(7).max(365).nullable(),
  }),
  companyHint: z.string().nullable().describe("Company or business named in the request, if any."),
  requiredRecords: z.array(z.enum(RECORD_TYPES)),
  missingInfo: z.array(z.string()).describe("Details the owner did not give that the plan had to assume."),
  desiredComparisons: z.array(z.string()),
});

export type Task = z.infer<typeof TaskSchema>;

export function taskJsonSchema(): object {
  return z.toJSONSchema(TaskSchema, { target: "openapi-3.0" });
}

export function emptyTask(objective: string): Task {
  return {
    objective,
    decisionType: "general_question",
    questionKind: "none",
    decisions: {
      hireCount: null,
      hireAnnualSalary: null,
      marketingMonthlyIncrease: null,
      marketingIncreaseRequested: false,
      ownerDrawAmount: null,
      ownerDrawRequested: false,
      priceChangePct: null,
      equipmentAmount: null,
      vendorTermsExtraDays: null,
      earlyPayDiscountPct: null,
    },
    stress: { requested: false, paymentDelayDays: null, salesDropPct: null, costShockPct: null },
    wantsInvestigation: false,
    wantsProfitLeaks: false,
    wantsAnomalies: false,
    counterfactual: null,
    constraints: { minCashReserve: null, horizonDays: null },
    companyHint: null,
    requiredRecords: [],
    missingInfo: [],
    desiredComparisons: [],
  };
}

export function hasDecision(t: Task): boolean {
  const d = t.decisions;
  return Boolean(
    (d.hireCount ?? 0) > 0 ||
      d.marketingIncreaseRequested ||
      d.ownerDrawRequested ||
      d.priceChangePct ||
      d.equipmentAmount ||
      d.vendorTermsExtraDays ||
      d.earlyPayDiscountPct,
  );
}
