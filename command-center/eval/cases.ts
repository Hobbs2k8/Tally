// Known-answer evaluation cases. Expected values are what a careful human
// would extract from the prompt; numbers are checked against the dataset's own
// reports (balance sheet, aging, P&L), not against our engine.
//
// split: "tune" cases were used while building the rules; "holdout" cases were
// written before the first eval run and are never used to change the rules.
import type { Capability, Task } from "../src/lib/pipeline/task";

export type Tag = "paraphrase" | "ambiguous" | "missing_data" | "conflicting" | "delayed_payments" | "interacting" | "question" | "counterfactual" | "terms" | "simple";

export interface Expect {
  /** Expected company id, or "clarify" when the request should trigger a question. Only checked when companyId is null. */
  company?: string | "clarify";
  decisionType?: Task["decisionType"];
  questionKind?: Task["questionKind"];
  hireCount?: number | null;
  hireAnnualSalary?: number | null;
  ownerDrawRequested?: boolean;
  ownerDrawAmount?: number | null;
  marketingIncreaseRequested?: boolean;
  marketingMonthlyIncrease?: number | null;
  priceChangePct?: number | null;
  equipmentAmount?: number | null;
  stressRequested?: boolean;
  paymentDelayDays?: number | null;
  salesDropPct?: number | null;
  wantsInvestigation?: boolean;
  counterfactualCustomer?: string | null;
  minCashReserve?: number | null;
  horizonDays?: number | null;
  /** Record types that must be retrieved. */
  records?: Task["requiredRecords"];
  /** Capabilities that must be engaged; `notCapabilities` must not be. */
  capabilities?: Capability[];
  notCapabilities?: Capability[];
  /** For decision cases: true if a feasible plan should exist, false if constraints conflict. */
  feasiblePlanExists?: boolean;
}

export interface EvalCase {
  id: string;
  split: "tune" | "holdout";
  companyId: string | null; // selected in the UI, or null to test matching
  prompt: string;
  tags: Tag[];
  expect: Expect;
}

const SIM_RECORDS: Task["requiredRecords"] = ["bank", "invoices", "customer_payments", "bills", "bill_payments", "employees"];

export const CASES: EvalCase[] = [
  // ---------------- tune ----------------
  {
    id: "hero-roastline",
    split: "tune",
    companyId: "company-002",
    prompt: "I want to hire two employees, increase marketing spend, and take an owner draw. Investigate my finances, flag problems I should fix first, test what happens if customer payments are delayed, and give me the safest plan for the next 90 days.",
    tags: ["interacting", "delayed_payments", "missing_data"],
    expect: { decisionType: "growth_plan", hireCount: 2, ownerDrawRequested: true, ownerDrawAmount: null, marketingIncreaseRequested: true, stressRequested: true, wantsInvestigation: true, horizonDays: 90, records: [...SIM_RECORDS, "payroll", "journal"], capabilities: ["flight_simulator", "chaos_simulator", "money_detective", "profit_leak_radar", "autopilot"], feasiblePlanExists: true },
  },
  {
    id: "profit-vs-cash-roastline",
    split: "tune",
    companyId: "company-002",
    prompt: "Why is my profit different from my cash?",
    tags: ["question", "simple"],
    expect: { decisionType: "profit_question", questionKind: "profit_vs_cash", stressRequested: false, records: ["pnl", "balance_sheet", "bank"], capabilities: ["future_accountant"], notCapabilities: ["chaos_simulator", "flight_simulator"] },
  },
  {
    id: "debtors-roastline",
    split: "tune",
    companyId: "company-002",
    prompt: "Which customers owe me the most, and who is paying late?",
    tags: ["question"],
    expect: { decisionType: "receivables_question", questionKind: "top_debtors", stressRequested: false, records: ["invoices", "customer_payments"], capabilities: ["future_accountant"], notCapabilities: ["chaos_simulator"] },
  },
  {
    id: "hire-salary-draw",
    split: "tune",
    companyId: "company-001",
    prompt: "Can I hire 3 people at $45,000/year and take a $15k draw?",
    tags: ["interacting"],
    expect: { decisionType: "growth_plan", hireCount: 3, hireAnnualSalary: 45000, ownerDrawRequested: true, ownerDrawAmount: 15000, stressRequested: false, records: [...SIM_RECORDS, "payroll"], capabilities: ["flight_simulator", "autopilot"], notCapabilities: ["chaos_simulator"] },
  },
  {
    id: "counterfactual-customer",
    split: "tune",
    companyId: "company-002",
    prompt: "What if Bright Works Inc. had paid on time?",
    tags: ["counterfactual"],
    expect: { decisionType: "counterfactual", counterfactualCustomer: "Bright Works Inc.", records: ["invoices", "customer_payments", "bank"], capabilities: ["time_machine"], notCapabilities: ["flight_simulator"] },
  },
  {
    id: "price-hearthloaf-named",
    split: "tune",
    companyId: null,
    prompt: "Should I raise prices 5% for Hearthloaf Bakeries?",
    tags: ["simple"],
    expect: { company: "company-001", decisionType: "pricing", priceChangePct: 0.05, capabilities: ["negotiation_coach"] },
  },
  {
    id: "marketing-sales-drop",
    split: "tune",
    companyId: "company-021",
    prompt: "Increase marketing by $2,000 a month and stress test a 20% sales drop",
    tags: ["interacting"],
    expect: { decisionType: "marketing", marketingIncreaseRequested: true, marketingMonthlyIncrease: 2000, stressRequested: true, salesDropPct: 0.2, capabilities: ["flight_simulator", "chaos_simulator"] },
  },
  {
    id: "ambiguous-bakery",
    split: "tune",
    companyId: null,
    prompt: "How is my bakery doing?",
    tags: ["ambiguous"],
    expect: { company: "clarify" },
  },
  {
    id: "supplier-terms",
    split: "tune",
    companyId: "company-002",
    prompt: "Should I ask suppliers for net 30 terms?",
    tags: ["terms"],
    expect: { decisionType: "payment_terms", capabilities: ["negotiation_coach"], notCapabilities: ["chaos_simulator"] },
  },
  {
    id: "cash-position-cafe",
    split: "tune",
    companyId: "company-073",
    prompt: "How much cash do I have right now?",
    tags: ["question", "simple"],
    expect: { decisionType: "cash_question", questionKind: "cash_position", records: ["bank"], capabilities: ["future_accountant"], notCapabilities: ["flight_simulator"] },
  },
  {
    id: "delay-45-dental",
    split: "tune",
    companyId: "company-087",
    prompt: "What happens to my cash if patients and insurers pay 45 days late?",
    tags: ["delayed_payments"],
    expect: { decisionType: "stress_test", stressRequested: true, paymentDelayDays: 45, capabilities: ["chaos_simulator", "flight_simulator"] },
  },
  {
    id: "conflict-reserve-draw",
    split: "tune",
    companyId: "company-002",
    prompt: "I need to keep at least $150,000 in the bank but I also want to take a $50,000 owner draw this quarter.",
    tags: ["conflicting"],
    expect: { decisionType: "owner_draw", ownerDrawRequested: true, ownerDrawAmount: 50000, minCashReserve: 150000, feasiblePlanExists: false },
  },
  {
    id: "duplicates-check",
    split: "tune",
    companyId: "company-021",
    prompt: "Are there any duplicate or suspicious charges in my books?",
    tags: ["simple"],
    expect: { decisionType: "anomaly_check", capabilities: ["money_detective"], notCapabilities: ["flight_simulator", "chaos_simulator"], records: ["bills", "bank"] },
  },
  {
    id: "margin-leaks",
    split: "tune",
    companyId: "company-003",
    prompt: "Where am I losing money? Are my margins shrinking?",
    tags: ["question"],
    expect: { decisionType: "profit_question", capabilities: ["profit_leak_radar"], records: ["pnl", "bills"] },
  },
  {
    id: "hire-missing-count",
    split: "tune",
    companyId: "company-058",
    prompt: "Can I afford to hire someone new?",
    tags: ["missing_data"],
    expect: { decisionType: "hiring", hireCount: 1, hireAnnualSalary: null, capabilities: ["flight_simulator"] },
  },
  {
    id: "runway-nonprofit",
    split: "tune",
    companyId: "company-098",
    prompt: "How long until we run out of money?",
    tags: ["question"],
    expect: { decisionType: "cash_question", questionKind: "runway", capabilities: ["future_accountant"] },
  },

  // ---------------- holdout ----------------
  {
    id: "ho-coffee-ambiguous",
    split: "holdout",
    companyId: null,
    prompt: "Give me a plan for my coffee roasting company for next quarter.",
    tags: ["ambiguous"],
    expect: { company: "clarify" },
  },
  {
    id: "ho-named-company-draw",
    split: "holdout",
    companyId: null,
    prompt: "For Copper Kettle Cafe: can I pay myself a $10,000 distribution next month?",
    tags: ["simple"],
    expect: { company: "company-073", decisionType: "owner_draw", ownerDrawRequested: true, ownerDrawAmount: 10000 },
  },
  {
    id: "ho-equipment-delay",
    split: "holdout",
    companyId: "company-024",
    prompt: "We want to buy new equipment for $25k. Test what happens if clients pay 30 days late.",
    tags: ["delayed_payments", "interacting"],
    expect: { decisionType: "equipment", equipmentAmount: 25000, stressRequested: true, paymentDelayDays: 30, capabilities: ["flight_simulator", "chaos_simulator"] },
  },
  {
    id: "ho-expenses",
    split: "holdout",
    companyId: "company-080",
    prompt: "What are my biggest expenses?",
    tags: ["question", "simple"],
    expect: { decisionType: "expense_question", questionKind: "top_expenses", records: ["bills"], capabilities: ["future_accountant"], notCapabilities: ["chaos_simulator"] },
  },
  {
    id: "ho-hire-price",
    split: "holdout",
    companyId: "company-054",
    prompt: "If I raise prices by 8% can I afford to hire two technicians?",
    tags: ["interacting"],
    expect: { decisionType: "growth_plan", hireCount: 2, priceChangePct: 0.08, capabilities: ["flight_simulator", "negotiation_coach"] },
  },
  {
    id: "ho-overdue-law",
    split: "holdout",
    companyId: "company-092",
    prompt: "Who hasn't paid me? List my overdue invoices.",
    tags: ["question"],
    expect: { questionKind: "top_debtors", capabilities: ["future_accountant", "autopilot"], notCapabilities: ["flight_simulator"] },
  },
  {
    id: "ho-health-check",
    split: "holdout",
    companyId: "company-010",
    prompt: "Do a health check on my finances and flag anything I should fix.",
    tags: ["simple"],
    expect: { wantsInvestigation: true, capabilities: ["money_detective", "profit_leak_radar"], notCapabilities: ["chaos_simulator"] },
  },
  {
    id: "ho-conflict-hire-reserve",
    split: "holdout",
    companyId: "company-087",
    prompt: "I want to hire 4 people at $60,000 a year each while never dropping below $100,000 in cash.",
    tags: ["conflicting"],
    expect: { decisionType: "hiring", hireCount: 4, hireAnnualSalary: 60000, minCashReserve: 100000, feasiblePlanExists: false },
  },
  {
    id: "ho-revenue-trend",
    split: "holdout",
    companyId: "company-064",
    prompt: "Is my revenue growing?",
    tags: ["question", "simple"],
    expect: { questionKind: "revenue_trend", capabilities: ["future_accountant"], notCapabilities: ["flight_simulator"] },
  },
  {
    id: "ho-all-ontime",
    split: "holdout",
    companyId: "company-030",
    prompt: "What if all my customers had paid me on time this year?",
    tags: ["counterfactual"],
    expect: { decisionType: "counterfactual", counterfactualCustomer: null, capabilities: ["time_machine"] },
  },
  {
    id: "ho-marketing-delay-days",
    split: "holdout",
    companyId: "company-019",
    prompt: "Double our marketing and take a $20k draw; what if customers pay 15 days late?",
    tags: ["interacting", "delayed_payments", "missing_data"],
    expect: { marketingIncreaseRequested: true, ownerDrawRequested: true, ownerDrawAmount: 20000, stressRequested: true, paymentDelayDays: 15, capabilities: ["flight_simulator", "chaos_simulator"], feasiblePlanExists: true },
  },
  {
    id: "ho-no-company",
    split: "holdout",
    companyId: null,
    prompt: "Can I afford a new hire?",
    tags: ["ambiguous", "missing_data"],
    expect: { company: "clarify" },
  },

  // ---------- paraphrase holdout ----------
  // Written after the System One stand-in was built and before these were ever run;
  // never used to change rules or thresholds. Wording deliberately avoids the parser's keywords.
  {
    id: "pp-barista",
    split: "holdout",
    companyId: "company-073",
    prompt: "Can I afford to bring on a new barista?",
    tags: ["paraphrase", "missing_data"],
    expect: { decisionType: "hiring", hireCount: 1, capabilities: ["flight_simulator"] },
  },
  {
    id: "pp-ads",
    split: "holdout",
    companyId: "company-021",
    prompt: "Is it worth putting more money into ads this quarter?",
    tags: ["paraphrase"],
    expect: { marketingIncreaseRequested: true, capabilities: ["flight_simulator"] },
  },
  {
    id: "pp-billed-twice",
    split: "holdout",
    companyId: "company-001",
    prompt: "Did anyone bill me twice recently?",
    tags: ["paraphrase"],
    expect: { decisionType: "anomaly_check", capabilities: ["money_detective"], notCapabilities: ["flight_simulator"] },
  },
  {
    id: "pp-money-left",
    split: "holdout",
    companyId: "company-087",
    prompt: "If nothing changes, when does the money run dry?",
    tags: ["paraphrase", "question"],
    expect: { questionKind: "runway", capabilities: ["future_accountant"] },
  },
  {
    id: "pp-month-later",
    split: "holdout",
    companyId: "company-024",
    prompt: "How would we cope if clients started settling their invoices a month later than usual?",
    tags: ["paraphrase", "delayed_payments"],
    expect: { stressRequested: true, capabilities: ["chaos_simulator"] },
  },
];

/** Anomalies planted into copies of company data (never into the app's data). */
export interface Plant {
  companyId: string;
  kind: "duplicate_bill" | "unusual_expense";
  plantedId: string;
}

export const PLANT_COMPANIES = ["company-002", "company-021", "company-024", "company-073", "company-087", "company-058"];
