// The decision pipeline: intent -> match -> retrieve -> route -> simulate /
// investigate (in parallel) -> validate -> rank -> explain. Every stage is a
// Sentry span and is timed for the UI's status strip.
import * as Sentry from "@sentry/nextjs";
import { hasCompany, isCompanyCached, listCompanies, loadCompany } from "../data/load";
import type { CompanyData } from "../data/types";
import { dayToDate } from "../data/types";
import { cashPosition, profitVsCash, revenueTrend, topDebtors, topExpenses } from "../engine/accountant";
import type { Answer } from "../engine/accountant";
import { buildInputs } from "../engine/baseline";
import { flowsByCategory, runway } from "../engine/cash";
import { investigate } from "../engine/detective";
import { usd } from "../engine/format";
import { monthlyMargins, profitLeaks } from "../engine/margin";
import type { ProjectionInputs } from "../engine/model";
import { NO_LEVERS } from "../engine/model";
import { compareTermOptions } from "../engine/negotiation";
import { openBills } from "../engine/payables";
import { calculated, historical } from "../engine/provenance";
import { agingBuckets, openReceivables } from "../engine/receivables";
import { onTimePaymentCounterfactual } from "../engine/timemachine";
import type { Emit } from "../observability";
import { log, stage } from "../observability";
import { requiredRecordsFor } from "../providers/deterministic";
import { lowerFirst, simulationHeadline } from "./headline";
import { getProvider } from "../providers";
import type { ReasoningProvider, Usage } from "../providers/types";
import { addUsage, NO_USAGE, toCandidate } from "../providers/types";
import { buildActions, reminderDrafts } from "./actions";
import type { Assumption } from "./assumptions";
import { defaultDraw, defaultMarketingMonthly, specFromAssumptions } from "./assumptions";
import { estimateCost } from "./cost";
import type { ExplainFact } from "./explain";
import { numbersGrounded } from "./explain";
import { route as routeTask } from "./router";
import type { SimulationResult } from "./simulate";
import { simulate } from "./simulate";
import type { Task } from "./task";
import type { ClarifyResult, PipelineResult, PlanResult, SituationItem, ValidationCheck } from "./types";

export interface RunOptions {
  companyId?: string | null;
  provider?: ReasoningProvider;
  emit?: Emit;
  /** Skip the model explanation even if the provider supports it (eval baselines). */
  templateOnly?: boolean;
}

// Per-process caches: parsed intent per (provider, request) and derived context per company.
const intentCache = new Map<string, { task: Task; source: PlanResult["provider"]["intentSource"]; notes: string[] }>();
const contextCache = new Map<string, ProjectionInputs>();
const MAX_INTENTS = 200;

export function clearCaches() {
  intentCache.clear();
  contextCache.clear();
}

let seq = 0;
const newId = () => `req-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export async function runPipeline(request: string, opts: RunOptions = {}): Promise<PipelineResult> {
  const provider = opts.provider ?? getProvider();
  const emit: Emit = opts.emit ?? (() => {});
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  const requestId = newId();
  let usage: Usage = { ...NO_USAGE, model: provider.model() };

  return Sentry.startSpan({ name: "pipeline", op: "pipeline", attributes: { provider: provider.name } }, async () => {
    // 1 + 2a. Intent extraction and company ranking are independent: run them together.
    const intentKey = `${provider.name}:${request.trim().toLowerCase()}`;
    const cachedIntent = intentCache.get(intentKey);
    const companies = listCompanies();
    const selected = opts.companyId && hasCompany(opts.companyId) ? opts.companyId : null;
    if (opts.companyId && !selected) log("warn", "company not allowed", { companyId: opts.companyId });

    const intentP = stage(emit, timings, "intent", "Understanding", async () => {
      if (cachedIntent) return { ...cachedIntent, usage: NO_USAGE, cached: true };
      const r = await provider.extractIntent(request);
      const source: PlanResult["provider"]["intentSource"] = provider.name === "deterministic" ? "rules" : r.fellBack ? "fallback" : "model";
      const notes = r.fellBack ? [`Intent: ${provider.name} output failed validation after ${r.attempts} attempt(s); used the deterministic parser.${r.error ? ` (${r.error})` : ""}`] : [];
      return { task: r.task, source, notes, usage: r.usage, cached: false };
    }, (r) => (r.cached ? "cached" : r.source));

    const rankP = selected
      ? Promise.resolve(null)
      : stage(emit, timings, "match_rank", "Matching company", async () => {
          return provider.rankCompanies(request, companies.map(toCandidate));
        });

    const [intent, ranking] = await Promise.all([intentP, rankP]);
    usage = addUsage(usage, intent.usage);
    if (ranking) usage = addUsage(usage, ranking.usage);
    if (!intent.cached) {
      intentCache.set(intentKey, { task: intent.task, source: intent.source, notes: intent.notes });
      if (intentCache.size > MAX_INTENTS) intentCache.delete(intentCache.keys().next().value!);
    }
    const task: Task = { ...intent.task, requiredRecords: mergeRecords(intent.task) };
    log("info", "intent", { requestId, provider: provider.name, source: intent.source, cache: intent.cached ? "hit" : "miss", decisionType: task.decisionType, questionKind: task.questionKind });

    // 2b. Company match. Access control: only ids in the compiled index are reachable.
    const match = await stage(emit, timings, "match", "Matching company", async () => {
      if (selected) return { id: selected, reason: "selected in the UI" };
      const ranked = (ranking?.ranked ?? []).filter((r) => hasCompany(r.id));
      if (ranked.length && (ranked.length === 1 || ranked[0].score - ranked[1].score >= 0.2) && ranked[0].score >= 0.4) {
        return { id: ranked[0].id, reason: ranked[0].reason };
      }
      return { id: null, reason: ranked.length ? "ambiguous" : "no company named", candidates: ranked.slice(0, 5) };
    }, (m) => m.id ?? m.reason);

    if (!match.id) {
      const cands = ("candidates" in match ? match.candidates : undefined) ?? [];
      const byId = new Map(companies.map((c) => [c.id, c]));
      const result: ClarifyResult = {
        kind: "clarify",
        requestId,
        request,
        question: cands.length ? "Which company do you mean?" : "Which company should I look at? Pick one from the list.",
        candidates: cands.map((c) => ({ id: c.id, name: byId.get(c.id)!.name, industry: byId.get(c.id)!.industry, reason: c.reason })),
        task,
        timings,
      };
      log("info", "clarify", { requestId, candidates: cands.length });
      return result;
    }

    // 3. Retrieve only what the task needs (with source ids); cache derived context per company.
    const contextHit = contextCache.has(match.id) && isCompanyCached(match.id);
    const ctx = await stage(emit, timings, "retrieve", "Pulling records", () => {
      const data = loadCompany(match.id!);
      let inputs = contextCache.get(match.id!);
      if (!inputs) {
        inputs = buildInputs(data);
        contextCache.set(match.id!, inputs);
      }
      return { data, inputs, records: task.requiredRecords };
    }, (c) => `${c.records.length} record types${contextHit ? " (cached)" : ""}`);
    log("info", "retrieve", { requestId, companyId: match.id, cache: contextHit ? "hit" : "miss", records: ctx.records.join(",") });
    const { data, inputs } = ctx;

    // 4. Route to the minimum capability set.
    const route = await stage(emit, timings, "route", "Choosing capabilities", () => routeTask(task), (r) => r.capabilities.join(", "));
    log("info", "route", { requestId, capabilities: route.capabilities.join(","), mode: route.mode });
    const has = (c: string) => route.capabilities.includes(c as never);

    // 5. Capabilities. The engine is synchronous CPU work, so these run one after
    // another, each in its own span (see docs/OBSERVABILITY.md: Promise.all here
    // bought no parallelism and produced overlapping, misleading spans).
    const assumptions = has("flight_simulator") || has("chaos_simulator") ? buildAssumptions(task, data, inputs) : null;
    const findings = has("money_detective") ? await stage(emit, timings, "investigate", "Investigating", () => investigate(data), (f) => `${f.length} findings`) : null;
    const leaks = has("profit_leak_radar") ? await stage(emit, timings, "leaks", "Scanning for profit leaks", () => profitLeaks(data), (l) => `${l.length} leaks`) : null;
    const answer = has("future_accountant") ? await stage(emit, timings, "answer", "Answering from the books", () => answerQuestion(task, data, inputs)) : null;
    const sim = assumptions
      ? await stage(emit, timings, "simulate", has("chaos_simulator") ? "Simulating and stress testing" : "Simulating", () => simulateTraced(inputs, assumptions, task.stress.requested || has("chaos_simulator")), (s) => `${s.scenarios.length} scenarios, ${s.search?.candidatesEvaluated ?? 0} plan variants`)
      : null;
    const counterfactual = has("time_machine") ? await stage(emit, timings, "time_machine", "Replaying history", () => onTimePaymentCounterfactual(data, matchCustomer(data, task.counterfactual?.customerName ?? null))) : null;
    const negotiation = has("negotiation_coach")
      ? await stage(emit, timings, "negotiate", "Comparing terms", () =>
          compareTermOptions(inputs, { ...NO_LEVERS }, inputs.defaultReserve, 13, {
            vendorExtraDays: task.decisions.vendorTermsExtraDays ?? undefined,
            discountPct: task.decisions.earlyPayDiscountPct ?? undefined,
            priceChangePct: task.decisions.priceChangePct ?? undefined,
          }),
        )
      : null;

    // 6. Validate every number against the engine's constraints.
    const validation = await stage(emit, timings, "validate", "Verifying", () => validate(data, inputs, sim, assumptions), (v) => `${v.filter((c) => c.ok).length}/${v.length} checks pass`);
    for (const v of validation.filter((c) => !c.ok)) log("warn", "validation failed", { requestId, check: v.name, detail: v.detail });

    // 7. Rank actions.
    const drafts = has("autopilot") ? reminderDrafts(data) : [];
    const actions = await stage(emit, timings, "rank", "Ranking actions", () =>
      has("autopilot")
        ? buildActions(data, {
            findings: findings ?? [],
            leaks: leaks ?? [],
            planChanges: sim?.search?.changes ?? [],
            drafts,
            recoveryPct: assumptions?.find((a) => a.id === "recoveryPct")?.value ?? 0.5,
          })
        : [],
    );

    // 8. Explain: deterministic draft, optionally rewritten by the model, numbers checked.
    const situation = buildSituation(data, inputs);
    const { draft, facts } = bottomLineDraft(data, inputs, task, route.mode, { findings, leaks, answer, sim, assumptions, counterfactual, negotiation });
    const bottom = await stage(emit, timings, "explain", "Writing the plan", async () => {
      if (opts.templateOnly || provider.name === "deterministic") return { text: draft, source: "template" as const };
      try {
        const r = await provider.explain({ mode: route.mode, question: request, companyName: data.name, facts, draft });
        usage = addUsage(usage, r.usage);
        const check = numbersGrounded(r.text, facts);
        if (!check.ok || !r.text.trim()) {
          log("warn", "explanation rejected", { requestId, ungrounded: check.ungrounded.join(",") });
          return { text: draft, source: "template" as const, rejected: `model text cited numbers not in the engine's facts: ${check.ungrounded.join(", ")}` };
        }
        return { text: r.text.replace(/\s+/g, " ").trim(), source: "model" as const };
      } catch (e) {
        log("warn", "explain failed", { requestId, error: e instanceof Error ? e.message : String(e) });
        return { text: draft, source: "template" as const };
      }
    }, (b) => b.source);

    const summary = listCompanies().find((c) => c.id === data.id)!;
    const result: PlanResult = {
      kind: "plan",
      requestId,
      request,
      createdAt: new Date().toISOString(),
      provider: { name: provider.name, model: provider.model(), intentSource: intent.source, notes: intent.notes },
      company: { ...summary, asOfDate: dayToDate(data.openingDate, data.asOfDay), openingDate: data.openingDate },
      task,
      route,
      capabilities: route.capabilities,
      mode: route.mode,
      bottomLine: bottom,
      situation,
      findings: findings ?? [],
      leaks: leaks ?? [],
      answer: answer ?? null,
      simulation: sim && assumptions ? { inputs, assumptions, stressRequested: task.stress.requested || has("chaos_simulator"), result: sim } : null,
      actions,
      drafts,
      counterfactual: counterfactual ?? null,
      negotiation: negotiation ?? null,
      validation,
      timings,
      totalMs: performance.now() - t0,
      usage: { ...usage, costUsd: estimateCost(usage) },
      cache: { intent: intent.cached ? "hit" : "miss", context: contextHit ? "hit" : "miss" },
    };
    log("info", "plan complete", { requestId, provider: provider.name, companyId: data.id, ms: Math.round(result.totalMs), capabilities: route.capabilities.join(","), explain: bottom.source, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    return result;
  });
}

/** Server-side simulate with one span per scenario family for the trace waterfall. */
function simulateTraced(inputs: ProjectionInputs, assumptions: Assumption[], stressRequested: boolean): SimulationResult {
  const spec = specFromAssumptions(assumptions, stressRequested);
  return Sentry.startSpan({ name: "simulate.scenarios", op: "engine", attributes: { stress: stressRequested } }, () => simulate(inputs, spec));
}

function mergeRecords(t: Task): Task["requiredRecords"] {
  // Union of what the provider listed and what the rules require for this task shape.
  return [...new Set([...t.requiredRecords, ...requiredRecordsFor(t)])].sort() as Task["requiredRecords"];
}

function matchCustomer(data: CompanyData, name: string | null): string | null {
  if (!name) return null;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const exact = data.customers.find((c) => norm(c.name) === norm(name));
  if (exact) return exact.id;
  const toks = norm(name).split(" ").filter((w) => w.length > 1 && !["the", "and", "co"].includes(w));
  let best: { id: string; score: number } | null = null;
  for (const c of data.customers) {
    const ct = norm(c.name).split(" ");
    const hits = toks.filter((t) => ct.includes(t)).length;
    // Share of the query matched, then share of the customer name matched (prefers the closest name).
    const score = hits / Math.max(1, toks.length) + (0.5 * hits) / Math.max(1, ct.length);
    if (score > (best?.score ?? 0)) best = { id: c.id, score };
  }
  return best && best.score >= 0.6 ? best.id : null;
}

export function buildAssumptions(task: Task, data: CompanyData, inputs: ProjectionInputs): Assumption[] {
  const d = task.decisions;
  const list: Assumption[] = [];
  const reserveYou = task.constraints.minCashReserve !== null;
  list.push({
    id: "reserve",
    label: "Minimum cash reserve",
    value: reserveYou ? Math.round(task.constraints.minCashReserve! * 100) : inputs.defaultReserve,
    unit: "usd",
    source: reserveYou ? "you" : "default",
    note: reserveYou ? "From your request." : "About 4 weeks of fixed costs (payroll, recurring bills, overhead).",
    min: 0, max: Math.max(inputs.openingCash * 2, 1_000_000), step: 100_000,
  });
  const horizonDays = task.constraints.horizonDays ?? 90;
  list.push({ id: "horizonWeeks", label: "Planning horizon", value: Math.max(4, Math.min(26, Math.round(horizonDays / 7))), unit: "weeks", source: task.constraints.horizonDays ? "you" : "default", note: "Weekly projection.", min: 4, max: 26, step: 1 });
  if (task.stress.requested || d.hireCount || d.ownerDrawRequested || d.marketingIncreaseRequested) {
    const days = task.stress.paymentDelayDays;
    list.push({ id: "stressDelayDays", label: "Stress test: customers pay later by", value: days ?? 30, unit: "days", source: days !== null ? "you" : "default", note: days !== null ? "From your request." : "A one-month slip in collections. The plan must not run out of cash under it.", min: 0, max: 90, step: 5 });
  }
  if (task.stress.salesDropPct) list.push({ id: "stressSalesDecline", label: "Stress test: sales drop", value: task.stress.salesDropPct, unit: "pct", source: "you", note: "Applied in the stress case.", min: 0, max: 0.8, step: 0.05 });
  if (task.stress.costShockPct) list.push({ id: "stressCostShock", label: "Stress test: cost increase", value: task.stress.costShockPct, unit: "pct", source: "you", note: "Supplier and overhead costs, stress case.", min: 0, max: 0.8, step: 0.05 });
  if (d.hireCount) {
    list.push({ id: "hireCount", label: "New hires", value: d.hireCount, unit: "count", source: "you", note: "From your request.", min: 0, max: 20, step: 1 });
    const salaryYou = d.hireAnnualSalary !== null;
    list.push({
      id: "hireWeeklyWage",
      label: "Wage per new hire (weekly)",
      value: salaryYou ? Math.round((d.hireAnnualSalary! * 100) / 52) : inputs.medianWeeklyWage,
      unit: "usd",
      source: salaryYou ? "you" : "history",
      note: salaryYou ? "Your salary ÷ 52." : "Median wage of your current staff (gross, no payroll taxes modeled).",
      min: 0, max: 1_000_000, step: 5_000,
    });
  }
  if (d.marketingIncreaseRequested) {
    const you = d.marketingMonthlyIncrease !== null;
    list.push({ id: "marketingMonthly", label: "Extra marketing per month", value: you ? Math.round(d.marketingMonthlyIncrease! * 100) : defaultMarketingMonthly(inputs), unit: "usd", source: you ? "you" : "default", note: you ? "From your request." : "You did not give an amount: assumed 2% of monthly sales.", min: 0, max: 5_000_000, step: 10_000 });
    list.push({ id: "marketingLiftPct", label: "Sales lift from marketing", value: 0, unit: "pct", source: "default", note: "Conservative: no extra sales assumed within the horizon. Raise it to test a payoff (starts 4 weeks after spend).", min: 0, max: 0.5, step: 0.01 });
  }
  if (d.ownerDrawRequested) {
    const you = d.ownerDrawAmount !== null;
    const past = data.journal.filter((j) => j.purpose === "owner_distribution").map((j) => j.amount);
    const def = defaultDraw(past);
    list.push({ id: "ownerDraw", label: "Owner draw", value: you ? Math.round(d.ownerDrawAmount! * 100) : def.value, unit: "usd", source: you ? "you" : def.source, note: you ? "From your request." : def.source === "history" ? `You did not give an amount: your median past draw (${past.length} draws this year).` : "You did not give an amount: assumed $10,000.", min: 0, max: Math.max(inputs.openingCash * 2, 1_000_000), step: 100_000 });
  }
  if (d.priceChangePct) {
    list.push({ id: "priceChangePct", label: "Price change", value: d.priceChangePct, unit: "pct", source: "you", note: "Applied to new sales.", min: -0.3, max: 0.3, step: 0.01 });
    list.push({ id: "priceElasticity", label: "Customer response to price (elasticity)", value: -1, unit: "ratio", source: "default", note: "Assumes volume falls 1% for each 1% price rise. This is an assumption about customers, not data.", min: -3, max: 0, step: 0.1 });
  }
  if (d.equipmentAmount) list.push({ id: "equipmentAmount", label: "Equipment purchase (week 1)", value: Math.round(d.equipmentAmount * 100), unit: "usd", source: "you", note: "Paid in cash in week 1.", min: 0, max: 10_000_000, step: 100_000 });
  if (inputs.openAR.some((a) => a.daysPastDue > 0)) {
    list.push({ id: "recoveryPct", label: "Overdue recovered by chasing (within 14 days)", value: 0.5, unit: "pct", source: "default", note: "Assumption: half of overdue balances come in after reminders. Set to 0 to plan without it.", min: 0, max: 1, step: 0.05 });
  }
  if (inputs.variableCostRatio > 0.05 && (d.hireCount || d.ownerDrawRequested || d.marketingIncreaseRequested || task.stress.requested)) {
    list.push({ id: "vendorTermsAskDays", label: "Extra supplier days the plan may ask for", value: 14, unit: "days", source: "default", note: "Assumes suppliers agree to pay-later terms on new bills. Set to 0 to plan without negotiating.", min: 0, max: 45, step: 7 });
  }
  return list;
}

function answerQuestion(task: Task, data: CompanyData, inputs: ProjectionInputs): Answer {
  switch (task.questionKind) {
    case "profit_vs_cash":
      return profitVsCash(data);
    case "top_debtors":
      return topDebtors(data);
    case "top_expenses":
      return topExpenses(data);
    case "revenue_trend":
      return revenueTrend(data);
    case "runway": {
      const r = runway(data);
      return {
        kind: "runway",
        headline: r.weeks === null ? `Over the last 13 weeks operations brought in more cash than they used (${usd(r.weeklyOperatingNet)} a week), so there is no burn-based runway limit at today's run-rate.` : `At the last 13 weeks' operating burn (${usd(-r.weeklyOperatingNet)} a week) your ${usd(r.cash)} lasts about ${r.weeks.toFixed(1)} weeks.`,
        facts: [
          { key: "cash", label: "Cash in checking", value: r.cash, unit: "usd", source: inputs.openingCashSource ?? "bank" },
          { key: "weekly_net", label: "Average weekly operating cash flow (13 weeks, excl. owner draws)", value: r.weeklyOperatingNet, unit: "usd", source: "calculated: bank feed by category" },
        ],
      };
    }
    case "margin": {
      const mm = monthlyMargins(data);
      const first = mm.slice(0, 3);
      const last = mm.slice(-3);
      const avg = (xs: typeof mm) => xs.reduce((s, m) => s + (m.grossMargin ?? 0), 0) / Math.max(1, xs.length);
      return {
        kind: "margin",
        headline: `Gross margin averaged ${(avg(first) * 100).toFixed(1)}% in the first three full months and ${(avg(last) * 100).toFixed(1)}% in the last three.`,
        facts: [
          { key: "gm_first", label: "Gross margin, first 3 full months", value: Math.round(avg(first) * 1000) / 10, unit: "pct", source: "report:profit_and_loss" },
          { key: "gm_last", label: "Gross margin, last 3 full months", value: Math.round(avg(last) * 1000) / 10, unit: "pct", source: "report:profit_and_loss" },
        ],
        table: { columns: ["Month", "Revenue", "Gross margin", "Net margin"], rows: mm.map((m) => [m.month, usd(m.revenue), `${((m.grossMargin ?? 0) * 100).toFixed(1)}%`, `${((m.netMargin ?? 0) * 100).toFixed(1)}%`]) },
      };
    }
    default:
      return cashPosition(data);
  }
}

function buildSituation(data: CompanyData, inputs: ProjectionInputs): SituationItem[] {
  const open = openReceivables(data);
  const aging = agingBuckets(open);
  const overdue = open.filter((o) => o.daysPastDue > 0);
  const ap = openBills(data);
  const rw = runway(data);
  const f = flowsByCategory(data, data.asOfDay - 91, data.asOfDay);
  const opening = data.journal.find((j) => j.purpose === "opening_equity");
  const mm = monthlyMargins(data).filter((m) => m.grossMargin !== null);
  const items: SituationItem[] = [
    { key: "cash", label: "Cash in checking", figure: historical(inputs.openingCash, "usd", inputs.openingCashSource ? [inputs.openingCashSource] : [], `bank balance on ${dayToDate(data.openingDate, data.asOfDay)}`) },
    { key: "ar", label: "Owed to you", figure: historical(aging.total, "usd", open.map((o) => o.id), "open invoices"), hint: `${usd(aging.overdue)} overdue` },
    { key: "overdue", label: "Overdue receivables", figure: historical(aging.overdue, "usd", overdue.map((o) => o.id), `${overdue.length} invoices past due`) },
    { key: "ap", label: "Bills to pay", figure: historical(ap.reduce((s, b) => s + b.open, 0), "usd", ap.map((b) => b.id), "open bills") },
    { key: "payroll", label: "Weekly payroll", figure: historical(inputs.weeklyPayroll, "usd", data.employees.filter((e) => e.released === null).map((e) => e.id), "current staff wage rates (gross)") },
    {
      key: "opcash",
      label: "Operating cash flow / week",
      figure: calculated(rw.weeklyOperatingNet, "usd", ["bank feed, last 13 weeks", "excludes owner draws and financing"]),
      hint: rw.weeks === null ? "cash-generative" : `${rw.weeks.toFixed(0)} weeks of runway`,
    },
    { key: "draws", label: "Owner draws, last 13 weeks", figure: historical(-f.owner_draws, "usd", data.bank.filter((t) => t.kind === "owner_distribution" && t.day > data.asOfDay - 91).map((t) => t.source)) },
  ];
  if (opening) {
    items.push({ key: "profit", label: "Profit this year (P&L)", figure: historical(data.pnl.full.net, "usd", ["report:profit_and_loss"]), hint: `cash changed ${usd(inputs.openingCash - opening.amount, { sign: true })}` });
  }
  if (mm.length >= 6) {
    const avg = (xs: typeof mm) => xs.reduce((s, m) => s + m.grossMargin!, 0) / xs.length;
    items.push({ key: "gm", label: "Gross margin, last 3 months", figure: historical(avg(mm.slice(-3)), "pct", mm.slice(-3).map((m) => `pnl:${m.month}`)), hint: `was ${(avg(mm.slice(0, 3)) * 100).toFixed(1)}% in the first 3` });
  }
  return items;
}

function bottomLineDraft(
  data: CompanyData,
  inputs: ProjectionInputs,
  task: Task,
  mode: "plan" | "answer",
  r: {
    findings: PlanResult["findings"] | null;
    leaks: PlanResult["leaks"] | null;
    answer: Answer | null;
    sim: SimulationResult | null;
    assumptions: Assumption[] | null;
    counterfactual: PlanResult["counterfactual"] | null;
    negotiation: PlanResult["negotiation"] | null;
  },
): { draft: string; facts: ExplainFact[] } {
  const facts: ExplainFact[] = [];
  const fact = (label: string, text: string) => {
    facts.push({ label, text });
    return text;
  };
  const parts: string[] = [];
  const overdue = r.findings?.find((f) => f.id === "overdue-total");

  if (r.sim && r.assumptions && (r.sim.search || task.stress.requested)) {
    const h = simulationHeadline(r.sim, r.assumptions, overdue?.amount ?? null);
    parts.push(...h.parts);
    facts.push(...h.facts);
  } else if (r.answer) {
    parts.push(r.answer.headline);
    for (const f of r.answer.facts) fact(f.label, f.unit === "usd" ? usd(f.value) : `${f.value}`);
  } else if (r.counterfactual) {
    const cf = r.counterfactual;
    parts.push(`Had ${cf.customerName} paid every invoice on its due date, your lowest cash point this year would have been ${fact("cf min", usd(cf.counterfactualMin.cash))} instead of ${fact("hist min", usd(cf.historicalMin.cash))} (${fact("payments moved", `${cf.paymentsMoved}`)} late payments, ${fact("amount moved", usd(cf.amountMoved))}, about ${fact("days earlier", `${cf.avgDaysEarlier.toFixed(0)}`)} days earlier on average).`);
  } else if (r.negotiation) {
    const best = [...r.negotiation].sort((a, b) => b.minCashDelta - a.minCashDelta || b.endingCashDelta - a.endingCashDelta)[0];
    const low = best.minCashDelta !== 0 ? `${fact("best min cash delta", usd(best.minCashDelta, { sign: true }))} at the low point, ` : "";
    parts.push(`Best for cash: ${lowerFirst(best.title)} (${low}${fact("best ending cash delta", usd(best.endingCashDelta, { sign: true }))} by the end of 13 weeks, operating profit ${fact("best profit delta", usd(best.operatingProfitDelta, { sign: true }))}). ${best.behaviorAssumption}`);
  } else if (r.findings?.length) {
    parts.push(`Top issue: ${lowerFirst(r.findings[0].title)}.`);
  }
  if (!r.sim && r.findings?.length && r.answer) parts.push(`Also flagged: ${lowerFirst(r.findings[0].title)}.`);
  if (r.leaks?.length && mode === "plan" && !r.sim) parts.push(`Biggest profit leak: ${lowerFirst(r.leaks[0].title)} (about ${fact("top leak", usd(r.leaks[0].annualImpact))} a year).`);
  // Titles are engine-generated text, so every number in them is grounded too.
  for (const l of r.leaks ?? []) fact(l.title, `${l.title} ${usd(l.annualImpact)}`);
  for (const f of r.findings ?? []) fact(f.title, `${f.title} ${f.amount ? usd(f.amount) : ""}`);
  fact("cash", usd(inputs.openingCash));
  fact("weekly payroll", usd(inputs.weeklyPayroll));
  void data;
  const draft = parts.join(" ") || `Here is what the books show for ${data.name}.`;
  // The draft is built only from engine values, so its numbers are allowed in the rewording.
  facts.push({ label: "deterministic draft", text: draft });
  return { draft, facts };
}

function validate(data: CompanyData, inputs: ProjectionInputs, sim: SimulationResult | null, assumptions: Assumption[] | null): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const ar = agingBuckets(openReceivables(data)).total;
  checks.push({ name: "Receivables match the AR aging report", ok: ar === data.arAging.total, detail: `${usd(ar)} derived vs ${usd(data.arAging.total)} reported` });
  const checking = data.balanceSheet.end.lines.find((l) => l.accountId === "acct-checking")?.amount ?? 0;
  checks.push({ name: "Opening cash matches the balance sheet", ok: inputs.openingCash === checking, detail: `${usd(inputs.openingCash)} vs ${usd(checking)}` });
  if (sim && assumptions) {
    const reserve = assumptions.find((a) => a.id === "reserve")?.value ?? 0;
    for (const sc of sim.scenarios) {
      const p = sim.projections[sc.id];
      const flows = p.weeks.reduce((s, w) => s + w.net, 0);
      const rollOk = Math.abs(inputs.openingCash + flows - p.summary.endingCash) <= p.weeks.length; // rounding, 1 cent per week
      checks.push({ name: `${sc.name}: weekly flows roll forward to ending cash`, ok: rollOk, detail: `${usd(inputs.openingCash)} + ${usd(flows)} = ${usd(p.summary.endingCash)}` });
    }
    const rec = sim.scenarios.find((s) => s.role === "recommended");
    if (rec && sim.search) {
      const base = sim.projections[rec.id].summary.minCash;
      const st = sim.stressedProjections[rec.id].summary.minCash;
      const ok = base >= reserve && st >= 0;
      checks.push({
        name: "Recommended plan respects the reserve (base) and stays solvent (stress)",
        ok: ok === sim.search.recommendedFeasible,
        detail: `base low ${usd(base)} vs reserve ${usd(reserve)}; stressed low ${usd(st)}${ok ? "" : ". No feasible variant: shown as the least risky option"}`,
      });
    }
  }
  return checks;
}
