import { describe, expect, it } from "vitest";
import { HERO_QUESTION } from "../src/lib/demo";
import { numbersGrounded, extractNumbers } from "../src/lib/pipeline/explain";
import { route } from "../src/lib/pipeline/router";
import { clearCaches, runPipeline } from "../src/lib/pipeline/run";
import { emptyTask, TaskSchema } from "../src/lib/pipeline/task";
import { parseMoney, parseTask, rankByOverlap } from "../src/lib/providers/deterministic";
import type { GenerateClient } from "../src/lib/providers/gemini";
import { GeminiProvider, retryDelaySeconds } from "../src/lib/providers/gemini";
import { pickFlashModel } from "../src/lib/providers/gemini-models";
import { SystemOneProvider } from "../src/lib/providers/systemone";

process.env.QUIET_LOGS = "1";

function fake(responses: (string | Error)[]): GenerateClient & { calls: number } {
  const c = {
    calls: 0,
    async generate() {
      const r = responses[Math.min(c.calls, responses.length - 1)];
      c.calls++;
      if (r instanceof Error) throw r;
      return { text: r, inputTokens: 100, outputTokens: 50 };
    },
  };
  return c;
}

const validTask = () => {
  const t = emptyTask("Hire two people");
  t.decisionType = "hiring";
  t.decisions.hireCount = 2;
  return JSON.stringify(t);
};

describe("deterministic parser", () => {
  it("parses money in common forms", () => {
    expect(parseMoney("$20,000")).toBe(20000);
    expect(parseMoney("20k")).toBe(20000);
    expect(parseMoney("$1.5m")).toBe(1_500_000);
  });

  it("parses the hero question", () => {
    const t = parseTask(HERO_QUESTION);
    expect(TaskSchema.safeParse(t).success).toBe(true);
    expect(t).toMatchObject({ decisionType: "growth_plan", wantsInvestigation: true, stress: { requested: true } });
    expect(t.decisions).toMatchObject({ hireCount: 2, marketingIncreaseRequested: true, ownerDrawRequested: true });
    expect(t.constraints.horizonDays).toBe(90);
  });

  it("does not treat 'who is paying late' as a stress test", () => {
    const t = parseTask("Which customers owe me the most, and who is paying late?");
    expect(t.stress.requested).toBe(false);
    expect(t.questionKind).toBe("top_debtors");
  });

  it("parses gerund price changes", () => {
    expect(parseTask("I'm raising prices 3% next month").decisions.priceChangePct).toBe(0.03);
    expect(parseTask("what if we are cutting prices by 10%").decisions.priceChangePct).toBe(-0.1);
  });

  it("routes a simple question to one capability", () => {
    const r = route(parseTask("Why is my profit different from my cash?"));
    expect(r.capabilities).toEqual(["future_accountant"]);
    expect(r.mode).toBe("answer");
  });

  it("company overlap prefers names over industries and stems plurals", () => {
    const c = [
      { id: "a", name: "Hearthloaf Bakeries", industry: "Commercial Bakeries", profile: "wholesale" },
      { id: "b", name: "Roastline Coffee Roasters", industry: "Coffee and Tea Manufacturing", profile: "wholesale" },
    ];
    expect(rankByOverlap("plan for Roastline", c)[0].id).toBe("b");
    expect(rankByOverlap("how is my bakery doing", c)[0].id).toBe("a");
  });
});

describe("GeminiProvider (fake client)", () => {
  it("accepts valid structured output on the first try", async () => {
    const client = fake([validTask()]);
    const r = await new GeminiProvider(client, null, "test-flash").extractIntent("Hire two people");
    expect(r).toMatchObject({ attempts: 1, fellBack: false });
    expect(r.task.decisions.hireCount).toBe(2);
    expect(r.usage.calls).toBe(1);
  });

  it("retries once after a validation failure", async () => {
    const client = fake(['{"objective": 5}', validTask()]);
    const r = await new GeminiProvider(client, null, "test-flash").extractIntent("Hire two people");
    expect(client.calls).toBe(2);
    expect(r).toMatchObject({ attempts: 2, fellBack: false });
    expect(r.usage.calls).toBe(2);
  });

  it("falls back to the deterministic parser after two failures", async () => {
    const client = fake(["not json", '{"still": "wrong"}']);
    const r = await new GeminiProvider(client, null, "test-flash").extractIntent(HERO_QUESTION);
    expect(r.fellBack).toBe(true);
    expect(r.task.decisions.hireCount).toBe(2); // from the rules
  });

  it("does not retry auth errors", async () => {
    const client = fake([new Error("403 PERMISSION_DENIED: API key not valid")]);
    const r = await new GeminiProvider(client, null, "test-flash").extractIntent("Hire two people");
    expect(client.calls).toBe(1);
    expect(r.fellBack).toBe(true);
  });

  it("company ranking drops ids the model invents", async () => {
    const client = fake([JSON.stringify({ ranked: [{ id: "company-999", score: 0.99, reason: "made up" }, { id: "company-002", score: 0.9, reason: "coffee" }] })]);
    const cands = [
      { id: "company-002", name: "Roastline Coffee Roasters", industry: "Coffee and Tea Manufacturing", profile: "wholesale" },
      { id: "company-022", name: "Emberpot Coffee Roasters", industry: "Coffee and Tea Manufacturing", profile: "wholesale" },
    ];
    const r = await new GeminiProvider(client, null, "test-flash").rankCompanies("my coffee roasting business", cands);
    expect(r.ranked.map((x) => x.id)).toEqual(["company-002"]);
  });

  it("skips the model when the deterministic filter is decisive", async () => {
    const client = fake([new Error("should not be called")]);
    const r = await new GeminiProvider(client, null, "test-flash").rankCompanies("plan for Roastline", [
      { id: "company-002", name: "Roastline Coffee Roasters", industry: "Coffee and Tea Manufacturing", profile: "wholesale" },
      { id: "company-001", name: "Hearthloaf Bakeries", industry: "Commercial Bakeries", profile: "wholesale" },
    ]);
    expect(client.calls).toBe(0);
    expect(r.ranked[0].id).toBe("company-002");
  });

  it("pipeline rejects a model explanation with numbers not in the engine facts", async () => {
    clearCaches();
    const client = fake([validTask(), "Hire both now: you will have $1,234,567 left."]);
    const r = await runPipeline("Hire two people", { companyId: "company-002", provider: new GeminiProvider(client, null, "test-flash") });
    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      expect(r.bottomLine.source).toBe("template");
      expect(r.bottomLine.rejected).toMatch(/1234567/);
    }
  });
});

describe("explanation grounding", () => {
  const facts = [
    { label: "overdue", text: "$24,778" },
    { label: "delay", text: "30 days" },
  ];
  it("extracts money, compact and percent numbers", () => {
    expect(extractNumbers("$24,778 and $24.8k and 43.4%")).toEqual([24778, 24800, 43.4]);
  });
  it("accepts cited facts and small counts, rejects invented numbers", () => {
    expect(numbersGrounded("Chase the $24,778 first and hire 2 people; test a 30-day slip.", facts).ok).toBe(true);
    expect(numbersGrounded("You will save $5,000.", facts)).toMatchObject({ ok: false, ungrounded: [5000] });
  });
});

describe("rate limits", () => {
  it("reads Gemini's retry delay from a 429 error", () => {
    expect(retryDelaySeconds('ApiError: {"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"21s"}]}}')).toBe(21);
    expect(retryDelaySeconds('{\\"retryDelay\\": \\"7.5s\\"}')).toBe(7.5);
    expect(retryDelaySeconds("some other error")).toBeNull();
  });
  it("a 429 in the app falls back to the rules", async () => {
    const client = fake([new Error('ApiError: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')]);
    const r = await new GeminiProvider(client, null, "test-flash").extractIntent(HERO_QUESTION);
    expect(r.fellBack).toBe(true);
    expect(r.task.decisions.hireCount).toBe(2);
  });
});

describe("model selection and stub", () => {
  it("picks the newest stable Flash model", () => {
    expect(pickFlashModel(["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3.0-flash-preview-09"])).toBe("gemini-2.5-flash");
    expect(pickFlashModel(["gemini-2.5-pro"])).toBeNull();
  });
  it("System One stub reports fallback, never claims model output", async () => {
    const r = await new SystemOneProvider().extractIntent("Hire two people");
    expect(r.fellBack).toBe(true);
    expect(new SystemOneProvider().model()).toBeNull();
  });
});
