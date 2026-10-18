import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTask } from "../src/lib/providers/deterministic";
import { mergeSystemOne, SystemOneProvider } from "../src/lib/providers/systemone";
import type { SystemOneRequest, SystemOneResponse, SystemOneTransport } from "../src/lib/providers/systemone-api/contract";
import { httpTransport } from "../src/lib/providers/systemone-api/http";
import { localTransport } from "../src/lib/providers/systemone-api/local";

function resp(nouls: Record<string, number>, qk = "none", conf = 0.9): SystemOneResponse {
  return {
    model: "jev-test",
    answers: {
      ...Object.fromEntries(Object.entries(nouls).map(([k, v]) => [k, { type: "noul" as const, noul: v }])),
      question_kind: { type: "choice", choice: qk, confidence: conf, probabilities: { [qk]: conf } },
    },
    usage: { input_tokens: 40, output_tokens: 5 },
  };
}

function fakeTransport(r: SystemOneResponse | Error): SystemOneTransport & { reqs: SystemOneRequest[] } {
  const reqs: SystemOneRequest[] = [];
  return {
    kind: "local-standin",
    label: "fake",
    reqs,
    async ask(req) {
      reqs.push(req);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe("System One merge policy", () => {
  it("adds a flag the rules missed only above the threshold", () => {
    const q = "Can I afford to bring on a new barista?";
    expect(parseTask(q).decisions.hireCount).toBeNull();
    const t = mergeSystemOne(parseTask(q), q, resp({ hire: 0.93 }));
    expect(t.decisions.hireCount).toBe(1);
    expect(t.decisionType).toBe("hiring");
    expect(t.missingInfo.join(" ")).toMatch(/how many people/);
    expect(mergeSystemOne(parseTask(q), q, resp({ hire: 0.6 })).decisions.hireCount).toBeNull();
  });

  it("never removes or overrides what the rules extracted", () => {
    const q = "Can I hire 3 people at $45,000/year and take a $15k draw?";
    const t = mergeSystemOne(parseTask(q), q, resp({ hire: 0.01, draw: 0.02 }, "top_debtors"));
    expect(t.decisions).toMatchObject({ hireCount: 3, hireAnnualSalary: 45000, ownerDrawAmount: 15000 });
    expect(t.questionKind).toBe("none"); // a decision: the question-kind choice is not applied
  });

  it("classifies the question kind when the rules found none", () => {
    const q = "Why don't the numbers from my accountant match my bank account?";
    expect(parseTask(q).questionKind).toBe("none");
    const t = mergeSystemOne(parseTask(q), q, resp({}, "profit_vs_cash", 0.7));
    expect(t.questionKind).toBe("profit_vs_cash");
    expect(t.requiredRecords).toEqual(expect.arrayContaining(["pnl", "balance_sheet"]));
    expect(mergeSystemOne(parseTask(q), q, resp({}, "profit_vs_cash", 0.3)).questionKind).toBe("none");
  });
});

describe("SystemOneProvider", () => {
  it("asks one request with every flag and the question kind", async () => {
    const tr = fakeTransport(resp({ hire: 0.9 }));
    const r = await new SystemOneProvider(tr).extractIntent("Can I afford to bring on a new barista?");
    expect(tr.reqs).toHaveLength(1);
    expect(Object.keys(tr.reqs[0].questions)).toEqual(expect.arrayContaining(["hire", "draw", "stress", "question_kind"]));
    expect(r).toMatchObject({ fellBack: false, usage: { calls: 1, inputTokens: 40 } });
  });

  it("falls back to the rules when the transport fails or is missing", async () => {
    const r = await new SystemOneProvider(fakeTransport(new Error("boom"))).extractIntent("Hire two people");
    expect(r.fellBack).toBe(true);
    expect(r.task.decisions.hireCount).toBe(2);
    expect((await new SystemOneProvider(null).extractIntent("Hire two people")).fellBack).toBe(true);
  });

  it("company choice only returns ids it offered", async () => {
    const tr = fakeTransport({ model: "m", usage: { input_tokens: 1, output_tokens: 1 }, answers: { company: { type: "choice", choice: "company-999", confidence: 0.9, probabilities: { "company-999": 0.6, "company-001": 0.3, "company-021": 0.1 } } } });
    const r = await new SystemOneProvider(tr).rankCompanies("how is my bakery doing", [
      { id: "company-001", name: "Hearthloaf Bakeries", industry: "Commercial Bakeries", profile: "wholesale" },
      { id: "company-021", name: "Crumbford Commercial Bakery", industry: "Commercial Bakeries", profile: "wholesale" },
    ]);
    expect(r.ranked.map((x) => x.id)).toEqual(["company-001", "company-021"]);
  });

  it("explanations stay the engine template", async () => {
    const r = await new SystemOneProvider(fakeTransport(resp({}))).explain({ mode: "plan", question: "q", companyName: "c", facts: [], draft: "Draft text." });
    expect(r.text).toBe("Draft text.");
  });
});

describe("HTTP transport matches the TypeSafe contract", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("POSTs /v1/systemone with a Bearer key and the request body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(resp({})), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const req: SystemOneRequest = { model: "jev-latest", state: "hello", questions: { billing: { type: "noul", instructions: "Is this about billing?" } } };
    await httpTransport("sk-test", "https://api.typesafe.ai/").ask(req);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual(req);
  });
  it("surfaces API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    await expect(httpTransport("x").ask({ model: "m", state: "s", questions: { a: { type: "noul" } } })).rejects.toThrow(/401/);
  });
});

describe("local stand-in (real open-source model)", () => {
  it("answers yes/no and choice questions with probabilities", { timeout: 180_000 }, async () => {
    const r = await localTransport().ask({
      model: "jev-latest",
      state: "Can I afford to bring on a new barista next month?",
      questions: {
        hire: { type: "noul", criteria: { true: "The owner wants to hire new employees." } },
        draw: { type: "noul", criteria: { true: "The owner wants to pay themselves or take an owner draw." } },
        kind: { type: "choice", criteria: { none: "The owner is making a business decision.", runway: "The owner asks how long until they run out of money." } },
      },
    });
    const hire = r.answers.hire;
    const draw = r.answers.draw;
    expect(hire.type === "noul" && draw.type === "noul" && hire.noul > draw.noul).toBe(true);
    const kind = r.answers.kind;
    expect(kind.type).toBe("choice");
    if (kind.type === "choice") expect(Object.values(kind.probabilities).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 3);
    expect(r.model).toMatch(/^local-standin\//);
  });
});
