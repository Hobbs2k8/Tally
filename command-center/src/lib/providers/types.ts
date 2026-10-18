// The reasoning layer sits behind this interface. Implementations:
//   GeminiProvider        real, default when GEMINI_API_KEY is set
//   DeterministicProvider rules-based fallback and benchmark baseline (no key needed)
//   SystemOneProvider     stub: see systemone.ts for what it must satisfy
//
// Providers never do arithmetic that reaches the output: numbers come from
// the deterministic engine, and explanations are checked against its facts.
import type { CompanySummary } from "../data/types";
import type { Task } from "../pipeline/task";

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
}

export const NO_USAGE: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, model: null };

export interface CompanyCandidate {
  id: string;
  name: string;
  industry: string;
  profile: string;
}

export interface RankedCompany {
  id: string;
  score: number; // 0..1
  reason: string;
}

/** A named alternative the provider suggests, as bounded lever changes. Engine evaluates it. */
export interface ScenarioProposal {
  name: string;
  rationale: string;
  hireStartWeek?: number | null;
  hireCount?: number | null;
  ownerDrawWeek?: number | null;
  ownerDrawFraction?: number | null;
  marketingFraction?: number | null;
}

export interface ExplainInput {
  mode: "plan" | "answer";
  question: string;
  companyName: string;
  /** Engine-computed facts. The explanation may only cite these values. */
  facts: { label: string; text: string }[];
  draft: string; // deterministic bottom line, used as fallback and as a style guide
}

export interface ReasoningProvider {
  readonly name: "gemini" | "deterministic" | "systemone";
  model(): string | null;
  extractIntent(request: string): Promise<{ task: Task; usage: Usage; attempts: number; fellBack: boolean; error?: string }>;
  rankCompanies(request: string, candidates: CompanyCandidate[]): Promise<{ ranked: RankedCompany[]; usage: Usage }>;
  proposeScenarios(task: Task, summary: string): Promise<{ proposals: ScenarioProposal[]; usage: Usage }>;
  explain(input: ExplainInput): Promise<{ text: string; usage: Usage }>;
}

export function toCandidate(c: CompanySummary): CompanyCandidate {
  return { id: c.id, name: c.name, industry: c.industry, profile: c.profile };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    model: a.model ?? b.model,
  };
}
