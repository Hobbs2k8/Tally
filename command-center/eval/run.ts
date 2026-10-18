// Evaluation suite: npm run eval
//
// Systems compared:
//   1. deterministic  - rules + engine, no LLM (DeterministicProvider)
//   2. plain-llm      - Gemini given the same retrieved records, answering directly (no engine)
//   3. gemini+engine  - our system: Gemini intent/matching/wording + deterministic engine
// 2 and 3 need GEMINI_API_KEY; without it they are reported as not measured.
//
// Writes eval/out/results.json and docs/EVAL_RESULTS.md.
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "../scripts/env";

loadEnv();
process.env.QUIET_LOGS = "1";

const { CASES, PLANT_COMPANIES } = await import("./cases");
const { loadCompany } = await import("../src/lib/data/load");
const { runPipeline, clearCaches } = await import("../src/lib/pipeline/run");
const { DeterministicProvider } = await import("../src/lib/providers/deterministic");
const { GeminiProvider, sdkClient } = await import("../src/lib/providers/gemini");
const { SystemOneProvider } = await import("../src/lib/providers/systemone");
const { localTransport } = await import("../src/lib/providers/systemone-api/local");
const { httpTransport } = await import("../src/lib/providers/systemone-api/http");
const { investigate } = await import("../src/lib/engine/detective");
const { buildInputs } = await import("../src/lib/engine/baseline");
const { project } = await import("../src/lib/engine/projection");
const { stressed } = await import("../src/lib/engine/stress");
const { NO_LEVERS } = await import("../src/lib/engine/model");
const { estimateCost } = await import("../src/lib/pipeline/cost");
const { plainLlmCase, plainLlmAnomalies } = await import("./plain-llm");
const { plantAnomalies } = await import("./plant");
type CompanyData = import("../src/lib/data/types").CompanyData;
type EvalCase = import("./cases").EvalCase;
type PlanResult = import("../src/lib/pipeline/types").PlanResult;
type PipelineResult = import("../src/lib/pipeline/types").PipelineResult;
type ReasoningProvider = import("../src/lib/providers/types").ReasoningProvider;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outDir = path.join(root, "eval", "out");
fs.mkdirSync(outDir, { recursive: true });

const key = process.env.GEMINI_API_KEY;
const only = process.argv.includes("--deterministic-only");

// ---------- ground truth from the dataset's own reports ----------
function reportTruth(d: CompanyData) {
  const b = d.arAging.buckets;
  const checking = d.balanceSheet.end.lines.find((l) => l.accountId === "acct-checking")?.amount ?? 0;
  const opening = d.journal.find((j) => j.purpose === "opening_equity")?.amount ?? 0;
  return {
    cash: checking,
    ar_total: d.arAging.total,
    ar_overdue: (b["1-30"] ?? 0) + (b["31-60"] ?? 0) + (b["61-90"] ?? 0) + (b["90+"] ?? 0),
    ap_total: d.apAging.total,
    profit: d.pnl.full.net,
    cash_change: checking - opening,
    rev_year: d.pnl.full.revenue,
  };
}

/** Compare every report-verifiable number the system emitted. */
function calcChecks(r: PlanResult, d: CompanyData): { checked: number; correct: number; misses: string[] } {
  const t = reportTruth(d);
  const pairs: [string, number, number][] = [];
  const sit = (k: string) => r.situation.find((s) => s.key === k)?.figure.value;
  if (sit("cash") !== undefined) pairs.push(["situation.cash", sit("cash")!, t.cash]);
  if (sit("ar") !== undefined) pairs.push(["situation.ar", sit("ar")!, t.ar_total]);
  if (sit("overdue") !== undefined) pairs.push(["situation.overdue", sit("overdue")!, t.ar_overdue]);
  if (sit("ap") !== undefined) pairs.push(["situation.ap", sit("ap")!, t.ap_total]);
  if (sit("profit") !== undefined) pairs.push(["situation.profit", sit("profit")!, t.profit]);
  for (const f of r.answer?.facts ?? []) {
    const k = f.key as keyof typeof t;
    if (k in t) pairs.push([`answer.${k}`, f.value, t[k]]);
  }
  const overdueFinding = r.findings.find((f) => f.id === "overdue-total");
  if (overdueFinding?.amount) pairs.push(["finding.overdue", overdueFinding.amount, t.ar_overdue]);
  const misses = pairs.filter(([, a, b]) => a !== b).map(([n, a, b]) => `${n}: ${a} vs ${b}`);
  return { checked: pairs.length, correct: pairs.length - misses.length, misses };
}

// ---------- intent scoring ----------
function intentChecks(c: EvalCase, r: PipelineResult): { checked: number; correct: number; misses: string[] } {
  const t = r.task;
  const e = c.expect;
  const got: Record<string, unknown> = {
    decisionType: t.decisionType,
    questionKind: t.questionKind,
    hireCount: t.decisions.hireCount,
    hireAnnualSalary: t.decisions.hireAnnualSalary,
    ownerDrawRequested: t.decisions.ownerDrawRequested,
    ownerDrawAmount: t.decisions.ownerDrawAmount,
    marketingIncreaseRequested: t.decisions.marketingIncreaseRequested,
    marketingMonthlyIncrease: t.decisions.marketingMonthlyIncrease,
    priceChangePct: t.decisions.priceChangePct,
    equipmentAmount: t.decisions.equipmentAmount,
    stressRequested: t.stress.requested,
    paymentDelayDays: t.stress.paymentDelayDays,
    salesDropPct: t.stress.salesDropPct,
    wantsInvestigation: t.wantsInvestigation,
    counterfactualCustomer: t.counterfactual ? t.counterfactual.customerName : undefined,
    minCashReserve: t.constraints.minCashReserve,
    horizonDays: t.constraints.horizonDays,
  };
  const misses: string[] = [];
  let checked = 0;
  for (const [k, v] of Object.entries(e)) {
    if (!(k in got)) continue;
    checked++;
    const g = got[k];
    const ok = typeof v === "number" && typeof g === "number" ? Math.abs(v - g) < 1e-6 : typeof v === "string" && typeof g === "string" ? v.toLowerCase() === g.toLowerCase() : v === g;
    if (!ok) misses.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(g)}`);
  }
  return { checked, correct: checked - misses.length, misses };
}

/** Independently re-verify a claimed-feasible recommendation with fresh projections. */
function verifyFeasibility(r: PlanResult): { claimedFeasible: boolean | null; violatesReserve: boolean | null } {
  const sim = r.simulation;
  if (!sim?.result.search) return { claimedFeasible: null, violatesReserve: null };
  const rec = sim.result.scenarios.find((s) => s.role === "recommended")!;
  const a = (id: string) => sim.assumptions.find((x) => x.id === id)?.value ?? 0;
  const reserve = a("reserve");
  const H = a("horizonWeeks") || 13;
  const base = project(sim.inputs, rec.levers, reserve, H);
  const st = project(sim.inputs, stressed(rec.levers, { salesDecline: a("stressSalesDecline"), paymentDelayDays: a("stressDelayDays"), costShock: a("stressCostShock") }), reserve, H);
  const violates = base.summary.minCash < reserve || st.summary.minCash < 0;
  return { claimedFeasible: sim.result.search.recommendedFeasible, violatesReserve: sim.result.search.recommendedFeasible ? violates : null };
}

interface CaseResult {
  id: string;
  split: string;
  tags: string[];
  system: string;
  kind: string;
  matchOk: boolean | null;
  intent: { checked: number; correct: number; misses: string[] };
  records: { expected: number; retrieved: number; ok: boolean; missing: string[] } | null;
  routing: { ok: boolean; missing: string[]; extra: string[] } | null;
  calc: { checked: number; correct: number; misses: string[] } | null;
  feasibility: { expected: boolean | undefined; claimedFeasible: boolean | null; violatesReserve: boolean | null; ok: boolean | null } | null;
  ms: number;
  usage: { calls: number; inputTokens: number; outputTokens: number; model: string | null };
  costUsd: number | null;
  intentSource?: string;
  explainSource?: string;
  error?: string;
}

async function runSystem(name: string, provider: ReasoningProvider, stats?: { waitedMs: number }): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of CASES) {
    clearCaches();
    const waited0 = stats?.waitedMs ?? 0;
    const t0 = performance.now();
    let r: PipelineResult;
    try {
      r = await runPipeline(c.prompt, { companyId: c.companyId, provider });
    } catch (e) {
      out.push({ id: c.id, split: c.split, tags: c.tags, system: name, kind: "error", matchOk: false, intent: { checked: 0, correct: 0, misses: [] }, records: null, routing: null, calc: null, feasibility: null, ms: performance.now() - t0, usage: { calls: 0, inputTokens: 0, outputTokens: 0, model: null }, costUsd: null, error: String(e) });
      continue;
    }
    // Exclude time spent waiting on rate-limit pacing: latency is model + engine time.
    const ms = performance.now() - t0 - ((stats?.waitedMs ?? 0) - waited0);
    const e = c.expect;
    const matchOk = c.companyId === null && e.company ? (e.company === "clarify" ? r.kind === "clarify" : r.kind === "plan" && r.company.id === e.company) : null;
    const intent = intentChecks(c, r);
    let records: CaseResult["records"] = null;
    let routing: CaseResult["routing"] = null;
    let calc: CaseResult["calc"] = null;
    let feasibility: CaseResult["feasibility"] = null;
    if (r.kind === "plan") {
      if (e.records) {
        const missing = e.records.filter((x) => !r.task.requiredRecords.includes(x));
        records = { expected: e.records.length, retrieved: r.task.requiredRecords.length, ok: missing.length === 0, missing };
      }
      if (e.capabilities || e.notCapabilities) {
        const missing = (e.capabilities ?? []).filter((x) => !r.capabilities.includes(x));
        const extra = (e.notCapabilities ?? []).filter((x) => r.capabilities.includes(x));
        routing = { ok: !missing.length && !extra.length, missing, extra };
      }
      calc = calcChecks(r, loadCompany(r.company.id));
      if (e.feasiblePlanExists !== undefined) {
        const v = verifyFeasibility(r);
        feasibility = { expected: e.feasiblePlanExists, ...v, ok: v.claimedFeasible === null ? null : v.claimedFeasible === e.feasiblePlanExists && v.violatesReserve !== true };
      }
    }
    const usage = r.kind === "plan" ? r.usage : { calls: 0, inputTokens: 0, outputTokens: 0, model: provider.model() };
    out.push({
      id: c.id, split: c.split, tags: c.tags, system: name, kind: r.kind, matchOk, intent, records, routing, calc, feasibility, ms,
      usage: { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: usage.model },
      costUsd: estimateCost(usage),
      intentSource: r.kind === "plan" ? r.provider.intentSource : undefined,
      explainSource: r.kind === "plan" ? r.bottomLine.source : undefined,
    });
    process.stdout.write(`  ${name} ${c.id.padEnd(28)} ${r.kind.padEnd(7)} ${Math.round(ms)} ms${intent.misses.length ? `  intent misses: ${intent.misses.join("; ")}` : ""}\n`);
  }
  return out;
}

// ---------- planted anomalies ----------
async function anomalyEval(llm: ReasoningProvider | null) {
  const plants = [];
  const rows = [];
  for (const id of PLANT_COMPANIES) {
    const clean = loadCompany(id);
    const { data, planted } = plantAnomalies(clean);
    plants.push(...planted);
    const found = investigate(data);
    const cleanFindings = investigate(clean).filter((f) => f.id.startsWith("dup-") || f.id.startsWith("unusual-"));
    for (const p of planted) {
      const hit = found.some((f) => f.sources.some((s) => s.id === p.plantedId));
      rows.push({ system: "engine", companyId: id, kind: p.kind, plantedId: p.plantedId, detected: hit });
    }
    rows.push({ system: "engine", companyId: id, kind: "false_positive_on_clean_data", plantedId: "", detected: cleanFindings.length > 0, count: cleanFindings.length });
    if (llm) {
      const r = await plainLlmAnomalies(evalClient!, llm.model()!, data);
      for (const p of planted) rows.push({ system: "plain-llm", companyId: id, kind: p.kind, plantedId: p.plantedId, detected: r.ids.includes(p.plantedId) });
      rows.push({ system: "plain-llm", companyId: id, kind: "flagged_ids", plantedId: r.ids.join(","), detected: false, usage: r.usage });
    }
  }
  // False-positive scan over every unmodified company (the organizers say the books are clean).
  const { listCompanies } = await import("../src/lib/data/load");
  let flagged = 0;
  let flags = 0;
  const all = listCompanies();
  for (const c of all) {
    const f = investigate(loadCompany(c.id)).filter((x) => x.id.startsWith("dup-") || x.id.startsWith("unusual-"));
    if (f.length) flagged++;
    flags += f.length;
  }
  return { plants, rows, cleanScan: { companies: all.length, companiesFlagged: flagged, flags } };
}

// ---------- plain LLM baseline ----------
async function runPlainLlm(provider: InstanceType<typeof GeminiProvider>) {
  const client = evalClient!;
  const model = provider.model()!;
  const out = [];
  for (const c of CASES) {
    const companyId = c.companyId ?? (c.expect.company && c.expect.company !== "clarify" ? c.expect.company : null);
    if (!companyId) continue; // matching is not part of this baseline
    const d = loadCompany(companyId);
    const inputs = buildInputs(d);
    const waited0 = client.stats!.waitedMs;
    const t0 = performance.now();
    const elapsed = () => performance.now() - t0 - (client.stats!.waitedMs - waited0);
    try {
      const r = await plainLlmCase(client, model, d, inputs, c.prompt);
      const truth = reportTruth(d);
      const pairs: [string, number | null, number][] = [
        ["cash", r.answer.cash, truth.cash / 100],
        ["overdue_receivables", r.answer.overdueReceivables, truth.ar_overdue / 100],
        ["total_receivables", r.answer.totalReceivables, truth.ar_total / 100],
        ["net_profit_year", r.answer.netProfitYear, truth.profit / 100],
      ];
      const checked = pairs.filter(([, v]) => v !== null);
      const misses = checked.filter(([, v, t]) => Math.abs((v as number) - t) > 1).map(([n, v, t]) => `${n}: ${v} vs ${t}`);
      // Feasibility of the LLM's own plan, checked with the engine.
      let violates: boolean | null = null;
      if (r.answer.plan && c.expect.feasiblePlanExists !== undefined) {
        const p = r.answer.plan;
        const reserve = c.expect.minCashReserve ? c.expect.minCashReserve * 100 : inputs.defaultReserve;
        const levers = {
          ...NO_LEVERS,
          hires: p.hireCount ? [{ count: p.hireCount, weeklyWage: Math.round(((c.expect.hireAnnualSalary ?? inputs.medianWeeklyWage * 52 / 100) * 100) / 52), startWeek: Math.max(0, (p.hireStartWeek ?? 1) - 1) }] : [],
          ownerDraws: p.ownerDrawAmount ? [{ amount: Math.round(p.ownerDrawAmount * 100), week: Math.max(0, (p.ownerDrawWeek ?? 1) - 1) }] : [],
          marketingWeekly: p.marketingMonthly ? Math.round((p.marketingMonthly * 100 * 12) / 52) : 0,
        };
        const base = project(inputs, levers, reserve, 13);
        const st = project(inputs, { ...levers, paymentDelayDays: c.expect.paymentDelayDays ?? 30 }, reserve, 13);
        violates = base.summary.minCash < reserve || st.summary.minCash < 0;
      }
      out.push({ id: c.id, split: c.split, ms: elapsed(), calc: { checked: checked.length, correct: checked.length - misses.length, misses }, planViolatesReserve: violates, claimedSafe: r.answer.planIsSafe, usage: r.usage, costUsd: estimateCost(r.usage) });
      process.stdout.write(`  plain-llm ${c.id.padEnd(28)} ${Math.round(elapsed())} ms calc ${checked.length - misses.length}/${checked.length}${violates !== null ? ` plan violates: ${violates}` : ""}\n`);
    } catch (e) {
      out.push({ id: c.id, split: c.split, ms: performance.now() - t0, error: String(e).slice(0, 200) });
      process.stdout.write(`  plain-llm ${c.id} ERROR ${String(e).slice(0, 120)}\n`);
    }
  }
  return out;
}

// ---------- run ----------
console.log(`Eval: ${CASES.length} cases (${CASES.filter((c) => c.split === "holdout").length} holdout)`);
const systems: Record<string, CaseResult[]> = {};
// Warm the JIT once so latency reflects a running server, not the first-call compile.
await runPipeline(CASES[0].prompt, { companyId: CASES[0].companyId, provider: new DeterministicProvider() });
systems["deterministic"] = await runSystem("deterministic", new DeterministicProvider());

// System One: the local open-source stand-in always; the real TypeSafe API when a key exists.
const standin = new SystemOneProvider(localTransport());
await standin.preload(); // model load is a one-time cost, not per-request latency
await runPipeline(CASES[0].prompt, { companyId: CASES[0].companyId, provider: standin });
systems["systemone-standin"] = await runSystem("systemone-standin", standin);
if (process.env.TYPESAFE_API_KEY) {
  systems["systemone"] = await runSystem("systemone", new SystemOneProvider(httpTransport(process.env.TYPESAFE_API_KEY)));
} else {
  console.log("TYPESAFE_API_KEY not set: real System One is not measured.");
}

let gemini: InstanceType<typeof GeminiProvider> | null = null;
let evalClient: ReturnType<typeof sdkClient> | null = null;
let plainLlm: Awaited<ReturnType<typeof runPlainLlm>> | null = null;
if (key && !only) {
  evalClient = sdkClient(key, { waitOn429: true, minIntervalMs: Number(process.env.EVAL_MIN_INTERVAL_MS ?? 4000) });
  gemini = new GeminiProvider(evalClient, key, process.env.GEMINI_MODEL || null);
  await gemini.ensureModel();
  console.log(`Gemini model: ${gemini.model()}`);
  systems["gemini+engine"] = await runSystem("gemini+engine", gemini, evalClient.stats);
  plainLlm = await runPlainLlm(gemini);
} else {
  console.log("GEMINI_API_KEY not set: plain-LLM and Gemini+engine systems are not measured.");
}
const anomalies = await anomalyEval(gemini);

const results = { generatedAt: new Date().toISOString(), geminiModel: gemini?.model() ?? null, cases: CASES.length, systems, plainLlm, anomalies };
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

const { renderReport } = await import("./report");
fs.writeFileSync(path.join(root, "docs", "EVAL_RESULTS.md"), renderReport(results));
console.log("Wrote eval/out/results.json and docs/EVAL_RESULTS.md");
