// GeminiProvider: intent extraction, company ranking and plain-English wording.
// Structured output (responseJsonSchema) -> Zod validation -> one retry with
// the validation error -> deterministic fallback. Server-side only.
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { Task } from "../pipeline/task";
import { TaskSchema } from "../pipeline/task";
import { log } from "../observability";
import { parseTask, rankByOverlap, requiredRecordsFor } from "./deterministic";
import { listGenerateModels, pickFlashModel } from "./gemini-models";
import type { CompanyCandidate, ExplainInput, RankedCompany, ReasoningProvider, ScenarioProposal, Usage } from "./types";
import { NO_USAGE } from "./types";

/** The part of the SDK we use, so tests can inject a fake. */
export interface GenerateClient {
  /** Time spent waiting on pacing / rate limits (not model time), for honest latency numbers. */
  stats?: { waitedMs: number };
  generate(req: { model: string; system: string; user: string; jsonSchema?: object; maxOutputTokens?: number }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

/** Seconds Gemini asks us to wait after a 429, if it says. */
export function retryDelaySeconds(err: unknown): number | null {
  const m = String(err).match(/retryDelay\\?"?\s*:\s*\\?"(\d+(?:\.\d+)?)s/);
  return m ? Number(m[1]) : null;
}

/**
 * opts.waitOn429: when Gemini rate-limits, wait the delay it asks for and retry
 * (up to 3 times). Used by the eval so quota limits do not distort accuracy.
 * The app leaves it off: a 429 falls back to the deterministic rules at once.
 * opts.minIntervalMs: space calls out (simple client-side pacing).
 */
export function sdkClient(apiKey: string, opts: { waitOn429?: boolean; minIntervalMs?: number } = {}): GenerateClient {
  const ai = new GoogleGenAI({ apiKey });
  let thinkingOff = true;
  let last = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const client: GenerateClient = {
    stats: { waitedMs: 0 },
    async generate(req) {
      for (let attempt = 0; ; attempt++) {
        if (opts.minIntervalMs) {
          const wait = last + opts.minIntervalMs - Date.now();
          if (wait > 0) {
            await sleep(wait);
            client.stats!.waitedMs += wait;
          }
          last = Date.now();
        }
        try {
          return await once(req);
        } catch (e) {
          if (!opts.waitOn429 || !/\b429\b|RESOURCE_EXHAUSTED/.test(String(e)) || attempt >= 3) throw e;
          const delay = retryDelaySeconds(e) ?? 20;
          // A long delay means a daily quota, not a per-minute one: give up rather than sleep for hours.
          if (delay > 90) throw new Error(`Gemini quota exhausted (retry in ${Math.round(delay / 60)} min): ${String(e).slice(0, 160)}`);
          const ms = (delay + 1) * 1000;
          await sleep(ms);
          client.stats!.waitedMs += ms;
          last = Date.now();
        }
      }
    },
  };
  return client;

  async function once({ model, system, user, jsonSchema, maxOutputTokens }: Parameters<GenerateClient["generate"]>[0]) {
    {
      const call = (noThinking: boolean) =>
        ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: user }] }],
          config: {
            systemInstruction: system,
            temperature: 0,
            maxOutputTokens: maxOutputTokens ?? 2048,
            ...(jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: jsonSchema } : {}),
            // Flash models accept a zero thinking budget; lower latency for routing work.
            ...(noThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        });
      let res;
      try {
        res = await call(thinkingOff);
      } catch (e) {
        if (thinkingOff && /thinking/i.test(String(e))) {
          thinkingOff = false; // model does not allow disabling thinking
          res = await call(false);
        } else throw e;
      }
      const u = res.usageMetadata;
      return {
        text: res.text ?? "",
        inputTokens: u?.promptTokenCount ?? 0,
        outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      };
    }
  }
}

/** Gemini-friendly JSON schema from Zod: draft 2020-12 without the $schema key. */
export function geminiSchema(schema: z.ZodType): object {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

const INTENT_SYSTEM = `You turn a small-business owner's request into a structured task for a financial planning engine.
Rules:
- Extract only what the owner said. Use null for anything not stated. Never invent amounts.
- Money fields are in dollars (not cents). Percentages are fractions (5% -> 0.05).
- "hire two people" -> hireCount 2. Salary only if stated (convert hourly x 2080, monthly x 12 to annual).
- marketingIncreaseRequested / ownerDrawRequested are true whenever the owner wants them, even without an amount.
- stress.requested is true only when the owner asks what happens under bad conditions (delayed payments, sales drop, cost spike, "safest plan", "stress test", "worst case").
- wantsInvestigation: asks to investigate, review, or flag problems. wantsProfitLeaks: margins, losing money, rising costs. wantsAnomalies: duplicates, unusual or suspicious transactions.
- questionKind for plain questions: profit_vs_cash, top_debtors (who owes / late payers), top_expenses, cash_position, runway, revenue_trend, margin; otherwise none.
- counterfactual: "what if X had paid on time" -> kind on_time_payment, customerName X (null for all customers).
- missingInfo lists details the plan must assume (e.g. "owner draw amount").
- requiredRecords: the record types needed (invoices, customer_payments, bills, bill_payments, bank, payroll, employees, pnl, balance_sheet, journal).`;

const RankSchema = z.object({
  ranked: z.array(z.object({ id: z.string(), score: z.number().min(0).max(1), reason: z.string() })).max(5),
});

const RANK_SYSTEM = `You match a business owner's request to the company they mean, from a list of companies (id, name, industry, business shape).
Return up to 5 candidates with a score from 0 to 1. Score 0.9+ only when the request names the company or clearly describes exactly one. If the request does not identify any company, return an empty list. Never invent ids.`;

const EXPLAIN_SYSTEM = `You write the bottom line of a financial action plan for a small-business owner: one or two plain sentences.
Hard rules:
- Use ONLY numbers that appear in the FACTS list, written exactly as given (e.g. "$24,778", "30 days"). Do not compute, round, add, or invent any number.
- Keep every recommended step from the DRAFT (for example who to chase, when to hire, when and how much to draw, supplier terms). Do not drop or merge steps, and do not add steps.
- Lead with the decision, then the key numbers. No hedging, no greetings, no markdown.
- Keep it under 80 words. Plainer wording than the DRAFT is the goal; facts and steps stay the same.`;

export class GeminiProvider implements ReasoningProvider {
  readonly name = "gemini" as const;
  private resolved: string | null;
  private resolving: Promise<string> | null = null;

  constructor(
    private readonly client: GenerateClient,
    private readonly apiKey: string | null,
    model: string | null = null,
  ) {
    this.resolved = model;
  }

  model(): string | null {
    return this.resolved;
  }

  /** Resolve the model id at runtime (env override, else newest Flash available to this key). */
  async ensureModel(): Promise<string> {
    if (this.resolved) return this.resolved;
    if (!this.resolving) {
      this.resolving = (async () => {
        if (!this.apiKey) throw new Error("No GEMINI_API_KEY to list models");
        const models = await listGenerateModels(this.apiKey);
        const pick = pickFlashModel(models);
        if (!pick) throw new Error("No Flash model available to this key");
        log("info", "gemini model selected", { model: pick, available: models.length });
        this.resolved = pick;
        return pick;
      })();
    }
    return this.resolving;
  }

  private usage(r: { inputTokens: number; outputTokens: number }): Usage {
    return { calls: 1, inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: this.resolved };
  }

  async extractIntent(request: string): Promise<{ task: Task; usage: Usage; attempts: number; fellBack: boolean; error?: string }> {
    let usage: Usage = { ...NO_USAGE, model: this.resolved };
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = await this.ensureModel();
        const user = attempt === 1 ? `Request: ${request}` : `Request: ${request}\n\nYour previous answer failed validation: ${lastError}\nReturn corrected JSON only.`;
        const r = await this.client.generate({ model, system: INTENT_SYSTEM, user, jsonSchema: geminiSchema(TaskSchema), maxOutputTokens: 1500 });
        const u = this.usage(r);
        usage = { calls: usage.calls + 1, inputTokens: usage.inputTokens + u.inputTokens, outputTokens: usage.outputTokens + u.outputTokens, model };
        const parsed = TaskSchema.safeParse(JSON.parse(r.text));
        if (parsed.success) {
          const task = parsed.data;
          // Records are a property of the task shape: keep the model's list but never drop what the rules require.
          task.requiredRecords = [...new Set([...task.requiredRecords, ...requiredRecordsFor(task)])];
          return { task, usage, attempts: attempt, fellBack: false };
        }
        lastError = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        log("warn", "intent validation failed", { attempt, error: lastError.slice(0, 300) });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        log("warn", "intent call failed", { attempt, error: lastError.slice(0, 300) });
        if (/API key|PERMISSION|401|403|No GEMINI/i.test(lastError)) break; // no point retrying auth
      }
    }
    return { task: parseTask(request), usage, attempts: 2, fellBack: true, error: lastError.slice(0, 200) };
  }

  async rankCompanies(request: string, candidates: CompanyCandidate[]): Promise<{ ranked: RankedCompany[]; usage: Usage }> {
    // Deterministic filter first; only call the model when the filter cannot decide.
    const overlap = rankByOverlap(request, candidates);
    if (overlap.length === 1 || (overlap.length > 1 && overlap[0].score - overlap[1].score >= 0.3)) return { ranked: overlap, usage: NO_USAGE };
    const pool = overlap.length > 1 ? candidates.filter((c) => overlap.some((o) => o.id === c.id)) : candidates;
    try {
      const model = await this.ensureModel();
      const list = pool.map((c) => `${c.id} | ${c.name} | ${c.industry} | ${c.profile}`).join("\n");
      const r = await this.client.generate({ model, system: RANK_SYSTEM, user: `Request: ${request}\n\nCompanies:\n${list}`, jsonSchema: geminiSchema(RankSchema), maxOutputTokens: 600 });
      const parsed = RankSchema.safeParse(JSON.parse(r.text));
      const ids = new Set(pool.map((c) => c.id));
      if (!parsed.success) return { ranked: overlap, usage: this.usage(r) };
      // Access control stays here: ids the model returns must exist in the allowed pool.
      const ranked = parsed.data.ranked.filter((x) => ids.has(x.id)).sort((a, b) => b.score - a.score);
      return { ranked, usage: this.usage(r) };
    } catch (e) {
      log("warn", "company ranking failed", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return { ranked: overlap, usage: NO_USAGE };
    }
  }

  async proposeScenarios(): Promise<{ proposals: ScenarioProposal[]; usage: Usage }> {
    // Not used: plan variants come from the deterministic search (engine/plan.ts).
    return { proposals: [], usage: NO_USAGE };
  }

  async explain(input: ExplainInput): Promise<{ text: string; usage: Usage }> {
    const model = await this.ensureModel();
    const facts = input.facts.map((f) => `- ${f.label}: ${f.text}`).join("\n");
    const r = await this.client.generate({
      model,
      system: EXPLAIN_SYSTEM,
      user: `Company: ${input.companyName}\nOwner asked: ${input.question}\n\nFACTS:\n${facts}\n\nDRAFT:\n${input.draft}`,
      maxOutputTokens: 300,
    });
    return { text: r.text.trim(), usage: this.usage(r) };
  }
}
