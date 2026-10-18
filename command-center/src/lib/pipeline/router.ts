// Routes a validated task to the minimum set of capabilities it needs.
// A plain question gets an answer, not a stress test.
import type { Capability, Task } from "./task";
import { hasDecision } from "./task";

export interface Route {
  capabilities: Capability[];
  mode: "plan" | "answer";
  reasons: Partial<Record<Capability, string>>;
}

export function route(task: Task): Route {
  const caps = new Map<Capability, string>();
  const decision = hasDecision(task);
  const d = task.decisions;

  const spendDecision = Boolean((d.hireCount ?? 0) > 0 || d.marketingIncreaseRequested || d.ownerDrawRequested || d.priceChangePct || d.equipmentAmount);
  if (spendDecision) {
    caps.set("flight_simulator", "the request changes future cash (hiring, spending, draws or prices)");
  }
  if (decision) {
    caps.set("autopilot", "decisions turn into an ordered action list");
  }
  if (task.stress.requested) {
    caps.set("chaos_simulator", "the owner asked what happens under bad conditions");
    caps.set("flight_simulator", caps.get("flight_simulator") ?? "stress tests run on the cash projection");
  }
  if (task.wantsInvestigation) {
    caps.set("money_detective", "the owner asked to investigate and flag problems");
    caps.set("profit_leak_radar", "flagging problems includes margin and cost leaks");
    caps.set("autopilot", caps.get("autopilot") ?? "problems found become prepared actions");
  }
  if (task.wantsAnomalies) caps.set("money_detective", "the owner asked about unusual or duplicate transactions");
  if (task.wantsProfitLeaks) caps.set("profit_leak_radar", "the owner asked about margins or losing money");
  if (task.counterfactual) caps.set("time_machine", "a what-if about the past");
  if (d.vendorTermsExtraDays || d.earlyPayDiscountPct || d.priceChangePct || task.decisionType === "payment_terms" || task.decisionType === "pricing") {
    caps.set("negotiation_coach", "terms, discounts or prices trade liquidity against margin");
  }
  if (task.questionKind !== "none") caps.set("future_accountant", `a direct question (${task.questionKind.replace(/_/g, " ")})`);
  if (task.questionKind === "top_debtors") caps.set("autopilot", caps.get("autopilot") ?? "overdue customers get reminder drafts");
  if (!caps.size) caps.set("future_accountant", "general question: answer from the books");

  const mode: Route["mode"] = decision || task.stress.requested || task.wantsInvestigation ? "plan" : "answer";
  const order: Capability[] = ["future_accountant", "money_detective", "profit_leak_radar", "flight_simulator", "chaos_simulator", "negotiation_coach", "time_machine", "autopilot"];
  const capabilities = order.filter((c) => caps.has(c));
  return { capabilities, mode, reasons: Object.fromEntries(capabilities.map((c) => [c, caps.get(c)!])) };
}
