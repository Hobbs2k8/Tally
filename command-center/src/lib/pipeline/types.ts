// The consolidated result of one request. Plain JSON (sent to the browser).
import type { CompanySummary } from "../data/types";
import type { Answer } from "../engine/accountant";
import type { Finding } from "../engine/detective";
import type { Leak } from "../engine/margin";
import type { ProjectionInputs } from "../engine/model";
import type { NegotiationOption } from "../engine/negotiation";
import type { Figure } from "../engine/provenance";
import type { CounterfactualResult } from "../engine/timemachine";
import type { Usage } from "../providers/types";
import type { Action, Draft } from "./actions";
import type { Assumption } from "./assumptions";
import type { Route } from "./router";
import type { SimulationResult } from "./simulate";
import type { Capability, Task } from "./task";

export interface SituationItem {
  key: string;
  label: string;
  figure: Figure;
  hint?: string;
}

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PlanResult {
  kind: "plan";
  requestId: string;
  request: string;
  createdAt: string;
  provider: { name: string; model: string | null; intentSource: "model" | "fallback" | "rules"; notes: string[] };
  company: CompanySummary & { asOfDate: string; openingDate: string };
  task: Task;
  route: Route;
  capabilities: Capability[];
  mode: "plan" | "answer";
  bottomLine: { text: string; source: "model" | "template"; rejected?: string };
  situation: SituationItem[];
  findings: Finding[];
  leaks: Leak[];
  answer: Answer | null;
  simulation: {
    inputs: ProjectionInputs;
    assumptions: Assumption[];
    stressRequested: boolean;
    result: SimulationResult;
  } | null;
  actions: Action[];
  drafts: Draft[];
  counterfactual: CounterfactualResult | null;
  negotiation: NegotiationOption[] | null;
  validation: ValidationCheck[];
  timings: Record<string, number>;
  totalMs: number;
  usage: Usage & { costUsd: number | null };
  cache: { intent: "hit" | "miss"; context: "hit" | "miss" };
}

export interface ClarifyResult {
  kind: "clarify";
  requestId: string;
  request: string;
  question: string;
  candidates: { id: string; name: string; industry: string; reason: string }[];
  task: Task;
  timings: Record<string, number>;
}

export type PipelineResult = PlanResult | ClarifyResult;
