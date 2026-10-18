// SystemOneProvider: System One-style reasoning (choice and yes/no questions
// answered with probabilities) for intent classification and company matching.
//
// Transport, picked from the environment:
//   TYPESAFE_API_KEY set -> the real TypeSafe System One API (POST /v1/systemone, model jev-latest).
//                           Written to the official contract; NOT verified live (no key yet).
//   otherwise            -> a LOCAL STAND-IN: an open-source zero-shot NLI model answering the
//                           same questions in-process (systemone-api/local.ts). Labelled as a stand-in
//                           everywhere; never presented as System One.
//
// System One classifies and scores; it does not write text. So:
//   - numbers, amounts and names still come from the deterministic parser;
//   - System One decides the categorical parts (what kind of request, which capabilities'
//     flags apply) where the rules found nothing, and picks between candidate companies;
//   - the bottom line stays the engine's deterministic template.
import type { Task } from "../pipeline/task";
import { hasDecision } from "../pipeline/task";
import { decisionTypeFor, parseTask, rankByOverlap, requiredRecordsFor } from "./deterministic";
import type { NoulQuestion, Question, SystemOneResponse, SystemOneTransport } from "./systemone-api/contract";
import { httpTransport } from "./systemone-api/http";
import type { CompanyCandidate, ExplainInput, RankedCompany, ReasoningProvider, ScenarioProposal, Usage } from "./types";
import { NO_USAGE } from "./types";

export const SYSTEM_ONE_MODEL = process.env.TYPESAFE_MODEL || "jev-latest";

/** Yes/no questions: one per intent flag. The "true" criterion doubles as the stand-in's hypothesis. */
const FLAGS: Record<string, NoulQuestion> = {
  hire: { type: "noul", instructions: "Does the owner want to hire someone?", criteria: { true: "The owner wants to hire new employees.", false: "Hiring is not part of the request." } },
  marketing: { type: "noul", instructions: "Does the owner want to spend more on marketing?", criteria: { true: "The owner wants to spend more on marketing or advertising.", false: "Marketing spend is not part of the request." } },
  draw: { type: "noul", instructions: "Does the owner want to take money out of the business?", criteria: { true: "The owner wants to pay themselves or take an owner draw.", false: "No owner draw is requested." } },
  price: { type: "noul", instructions: "Does the owner want to change prices?", criteria: { true: "The owner wants to change the prices they charge.", false: "Prices are not part of the request." } },
  stress: { type: "noul", instructions: "Does the owner ask what happens under bad conditions?", criteria: { true: "The owner asks what would happen if customers paid late.", false: "No bad-case scenario is asked about." } },
  investigate: { type: "noul", instructions: "Does the owner ask to investigate the books or flag problems?", criteria: { true: "The owner asks to review the books and find problems.", false: "No review of the books is requested." } },
  leaks: { type: "noul", instructions: "Does the owner ask about margins or losing money?", criteria: { true: "The owner asks why their profit margin is shrinking.", false: "Margins are not asked about." } },
  anomalies: { type: "noul", instructions: "Does the owner ask about duplicate or suspicious charges?", criteria: { true: "The owner thinks a bill was charged twice.", false: "No suspicious charges are asked about." } },
  counterfactual: { type: "noul", instructions: "Is this a what-if about payments in the past?", criteria: { true: "The owner asks how things would have been if customers had paid on time.", false: "No what-if about past payments." } },
};

const QUESTION_KIND: Question = {
  type: "choice",
  instructions: "Which kind of question is this?",
  criteria: {
    none: "The owner is making a business decision, not asking a question.",
    profit_vs_cash: "The owner asks why profit and cash differ.",
    top_debtors: "The owner asks who owes them money or who pays late.",
    top_expenses: "The owner asks what their biggest expenses are.",
    cash_position: "The owner asks how much cash they have.",
    runway: "The owner asks how long until they run out of money.",
    revenue_trend: "The owner asks whether revenue or sales are growing.",
    margin: "The owner asks about their profit margins.",
  },
};

/** A flag must clear this probability to be added when the rules did not find it. */
export const FLAG_THRESHOLD = 0.8;
export const CHOICE_THRESHOLD = 0.5;
export const COMPANY_CONFIDENCE = 0.75;

export class SystemOneProvider implements ReasoningProvider {
  readonly name = "systemone" as const;
  /** Last decision per field: where each part of the task came from (rules or System One). */
  lastSources: Record<string, string> = {};

  constructor(private readonly transport: SystemOneTransport | null = process.env.TYPESAFE_API_KEY ? httpTransport(process.env.TYPESAFE_API_KEY) : null) {}

  get transportKind(): SystemOneTransport["kind"] | "none" {
    return this.transport?.kind ?? "none";
  }

  model(): string | null {
    if (!this.transport) return null;
    return this.transport.kind === "typesafe" ? SYSTEM_ONE_MODEL : this.transport.label;
  }

  async preload() {
    await this.transport?.preload?.();
  }

  private usageOf(r: SystemOneResponse): Usage {
    return { calls: 1, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, model: this.model() };
  }

  async extractIntent(request: string): Promise<{ task: Task; usage: Usage; attempts: number; fellBack: boolean; error?: string }> {
    const task = parseTask(request);
    if (!this.transport) return { task, usage: NO_USAGE, attempts: 0, fellBack: true, error: "No System One transport configured" };
    let r: SystemOneResponse;
    try {
      r = await this.transport.ask({ model: SYSTEM_ONE_MODEL, state: request, questions: { ...FLAGS, question_kind: QUESTION_KIND } });
    } catch (e) {
      return { task, usage: NO_USAGE, attempts: 1, fellBack: true, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
    }
    return { task: mergeSystemOne(task, request, r), usage: this.usageOf(r), attempts: 1, fellBack: false };
  }

  async rankCompanies(request: string, candidates: CompanyCandidate[]): Promise<{ ranked: RankedCompany[]; usage: Usage }> {
    const overlap = rankByOverlap(request, candidates);
    // Decisive or no lead at all: no call. (With no lead, the pipeline asks the owner.)
    if (overlap.length <= 1 || overlap[0].score - overlap[1].score >= 0.3 || !this.transport) return { ranked: overlap, usage: NO_USAGE };
    const pool = candidates.filter((c) => overlap.some((o) => o.id === c.id)).slice(0, 12);
    try {
      const r = await this.transport.ask({
        model: SYSTEM_ONE_MODEL,
        state: request,
        questions: { company: { type: "choice", instructions: "Which company does the owner mean?", criteria: Object.fromEntries(pool.map((c) => [c.id, `The owner means ${c.name}, a ${c.industry.toLowerCase()} business.`])) } },
      });
      const a = r.answers.company;
      if (!a || a.type !== "choice") return { ranked: overlap, usage: this.usageOf(r) };
      // Only break a tie with a confident answer; otherwise keep the tie so the owner is asked.
      if (a.confidence < COMPANY_CONFIDENCE) return { ranked: overlap, usage: this.usageOf(r) };
      const ids = new Set(pool.map((c) => c.id)); // access control: only ids we offered
      const ranked = Object.entries(a.probabilities)
        .filter(([id]) => ids.has(id))
        .map(([id, p]) => ({ id, score: p, reason: `System One choice probability ${p.toFixed(2)}` }))
        .sort((x, y) => y.score - x.score);
      return { ranked, usage: this.usageOf(r) };
    } catch {
      return { ranked: overlap, usage: NO_USAGE };
    }
  }

  async proposeScenarios(): Promise<{ proposals: ScenarioProposal[]; usage: Usage }> {
    return { proposals: [], usage: NO_USAGE };
  }

  async explain(input: ExplainInput): Promise<{ text: string; usage: Usage }> {
    // System One does not generate text: the engine's template stands.
    return { text: input.draft, usage: NO_USAGE };
  }
}

/**
 * Merge System One answers into the rules' task. The rules are high-precision
 * (they fire on explicit wording and carry the numbers), so System One only
 * fills gaps: it can add a flag the rules missed (probability >= 0.8), or
 * classify the question kind when the rules found none and the request is not a decision. It never removes
 * what the rules extracted.
 */
export function mergeSystemOne(rules: Task, request: string, r: SystemOneResponse): Task {
  const t: Task = structuredClone(rules);
  const p = (name: string) => {
    const a = r.answers[name];
    return a && a.type === "noul" ? a.noul : 0;
  };
  const add = (cond: boolean, name: string) => cond && p(name) >= FLAG_THRESHOLD;
  const d = t.decisions;
  if (add(!d.hireCount, "hire")) {
    d.hireCount = 1;
    t.missingInfo.push("how many people to hire (assumed 1)");
  }
  if (add(!d.marketingIncreaseRequested, "marketing")) {
    d.marketingIncreaseRequested = true;
    t.missingInfo.push("size of the marketing increase");
  }
  if (add(!d.ownerDrawRequested, "draw")) {
    d.ownerDrawRequested = true;
    t.missingInfo.push("owner draw amount");
  }
  if (add(d.priceChangePct === null, "price")) {
    d.priceChangePct = 0.05;
    t.missingInfo.push("size of the price change (assumed +5%)");
  }
  if (add(!t.stress.requested, "stress")) t.stress.requested = true;
  if (add(!t.wantsInvestigation, "investigate")) t.wantsInvestigation = true;
  if (add(!t.wantsProfitLeaks, "leaks")) t.wantsProfitLeaks = true;
  if (add(!t.wantsAnomalies, "anomalies")) t.wantsAnomalies = true;
  if (add(!t.counterfactual, "counterfactual")) t.counterfactual = { kind: "on_time_payment", customerName: null };

  const qk = r.answers.question_kind;
  if (t.questionKind === "none" && !hasDecision(t) && qk && qk.type === "choice" && qk.choice !== "none" && qk.confidence >= CHOICE_THRESHOLD) {
    t.questionKind = qk.choice as Task["questionKind"];
  }
  t.decisionType = decisionTypeFor(t, request.toLowerCase());
  t.requiredRecords = requiredRecordsFor(t);
  return t;
}
