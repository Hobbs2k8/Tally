// Renders docs/EVAL_RESULTS.md from eval/out/results.json. Every number in
// the report is computed here from the raw results; nothing is typed in.
/* eslint-disable @typescript-eslint/no-explicit-any */

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : "n/a (0 cases)");
const quant = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const ms = (x: number) => (Number.isNaN(x) ? "n/a" : `${x.toFixed(1)} ms`);

function sysMetrics(rows: any[], split: "all" | "holdout") {
  const r = split === "all" ? rows : rows.filter((x) => x.split === "holdout");
  const match = r.filter((x) => x.matchOk !== null);
  const intentCases = r.filter((x) => x.intent.checked > 0);
  const fieldChecked = r.reduce((s, x) => s + x.intent.checked, 0);
  const fieldCorrect = r.reduce((s, x) => s + x.intent.correct, 0);
  const rec = r.filter((x) => x.records);
  const routing = r.filter((x) => x.routing);
  const calcChecked = r.reduce((s, x) => s + (x.calc?.checked ?? 0), 0);
  const calcCorrect = r.reduce((s, x) => s + (x.calc?.correct ?? 0), 0);
  const feas = r.filter((x) => x.feasibility && x.feasibility.ok !== null);
  const violations = r.filter((x) => x.feasibility?.violatesReserve === true).length;
  const claimed = r.filter((x) => x.feasibility?.claimedFeasible === true).length;
  const lat = r.map((x) => x.ms);
  const costs = r.map((x) => x.costUsd);
  const tokens = r.reduce((s, x) => s + x.usage.inputTokens + x.usage.outputTokens, 0);
  const fallbacks = r.filter((x) => x.intentSource === "fallback").length;
  const explainModel = r.filter((x) => x.explainSource === "model").length;
  return {
    n: r.length,
    match: pct(match.filter((x) => x.matchOk).length, match.length),
    intentCase: pct(intentCases.filter((x) => x.intent.correct === x.intent.checked).length, intentCases.length),
    intentField: pct(fieldCorrect, fieldChecked),
    records: pct(rec.filter((x) => x.records.ok).length, rec.length),
    routing: pct(routing.filter((x) => x.routing.ok).length, routing.length),
    calc: pct(calcCorrect, calcChecked),
    feasibility: pct(feas.filter((x) => x.feasibility.ok).length, feas.length),
    violations: `${violations} of ${claimed} plans claimed safe`,
    p50: ms(quant(lat, 0.5)),
    p95: ms(quant(lat, 0.95)),
    cost: costs.some((c) => c === null) ? (tokens ? `unknown price (${Math.round(tokens / r.length)} tokens/task)` : "$0") : `$${(costs.reduce((s, c) => s + c, 0) / r.length).toFixed(5)} (${Math.round(tokens / r.length)} tokens/task)`,
    fallbacks: `${fallbacks}`,
    explainModel: `${explainModel}`,
  };
}

function llmMetrics(rows: any[] | null, split: "all" | "holdout") {
  if (!rows) return null;
  const r = (split === "all" ? rows : rows.filter((x) => x.split === "holdout")).filter((x) => !x.error);
  const calcChecked = r.reduce((s, x) => s + x.calc.checked, 0);
  const calcCorrect = r.reduce((s, x) => s + x.calc.correct, 0);
  const plans = r.filter((x) => x.planViolatesReserve !== null);
  const safeClaims = plans.filter((x) => x.claimedSafe === true);
  const lat = r.map((x) => x.ms);
  const costs = r.map((x) => x.costUsd);
  const tokens = r.reduce((s, x) => s + x.usage.inputTokens + x.usage.outputTokens, 0);
  return {
    n: r.length,
    errors: (split === "all" ? rows : rows.filter((x) => x.split === "holdout")).filter((x) => x.error).length,
    calc: pct(calcCorrect, calcChecked),
    violations: `${plans.filter((x) => x.planViolatesReserve).length} of ${plans.length} plans violate (${safeClaims.filter((x) => x.planViolatesReserve).length} of ${safeClaims.length} it called safe)`,
    p50: ms(quant(lat, 0.5)),
    p95: ms(quant(lat, 0.95)),
    cost: costs.some((c) => c === null) ? `unknown price (${Math.round(tokens / Math.max(1, r.length))} tokens/task)` : `$${(costs.reduce((s, c) => s + c, 0) / Math.max(1, r.length)).toFixed(5)} (${Math.round(tokens / Math.max(1, r.length))} tokens/task)`,
  };
}

import fs from "node:fs";
import path from "node:path";

export function renderReport(res: any): string {
  const histFile = path.join(path.dirname(new URL(import.meta.url).pathname), "history.md");
  const history = fs.existsSync(histFile) ? fs.readFileSync(histFile, "utf8").trim() : "";
  const det = res.systems["deterministic"];
  const gem = res.systems["gemini+engine"] ?? null;
  const s1l = res.systems["systemone-standin"] ?? null;
  const s1 = res.systems["systemone"] ?? null;
  const NM = "not measured (no Gemini eval run)";
  const NM_S1 = "not measured (no TypeSafe key)";
  const cols = (f: (m: any) => string, fl?: (m: any) => string) => (split: "all" | "holdout") => {
    const d = sysMetrics(det, split);
    const l = llmMetrics(res.plainLlm, split);
    return [
      f(d),
      l ? (fl ? fl(l) : "n/a (not produced)") : NM,
      gem ? f(sysMetrics(gem, split)) : NM,
      s1l ? f(sysMetrics(s1l, split)) : "not run",
      s1 ? f(sysMetrics(s1, split)) : NM_S1,
    ];
  };
  const rows: [string, (s: "all" | "holdout") => string[]][] = [
    ["Company match accuracy", cols((m) => m.match)],
    ["Intent extraction: cases fully correct", cols((m) => m.intentCase)],
    ["Intent extraction: fields correct", cols((m) => m.intentField)],
    ["Required-record retrieval (expected records all retrieved)", cols((m) => m.records)],
    ["Capability routing (required engaged, excluded not engaged)", cols((m) => m.routing)],
    ["Calculation correctness vs dataset reports", cols((m) => m.calc, (l) => l.calc)],
    ["Feasibility verdict correct (incl. conflicting constraints)", cols((m) => m.feasibility)],
    ["Recommended plans that violate reserve / go negative under stress", cols((m) => m.violations, (l) => l.violations)],
    ["End-to-end latency p50", cols((m) => m.p50, (l) => l.p50)],
    ["End-to-end latency p95", cols((m) => m.p95, (l) => l.p95)],
    ["Cost per task", cols((m) => m.cost, (l) => l.cost)],
  ];
  const table = (split: "all" | "holdout") =>
    [`| Metric | Deterministic (rules + engine) | Plain LLM (Gemini, no engine) | Gemini + engine | System One stand-in (local NLI + engine) | System One (TypeSafe) + engine |`, `|---|---|---|---|---|---|`, ...rows.map(([name, f]) => `| ${name} | ${f(split).join(" | ")} |`)].join("\n");

  const an = res.anomalies.rows;
  const anomalyTable = (system: string) => {
    const r = an.filter((x: any) => x.system === system);
    if (!r.length) return null;
    const dup = r.filter((x: any) => x.kind === "duplicate_bill");
    const spike = r.filter((x: any) => x.kind === "unusual_expense");
    const fp = r.filter((x: any) => x.kind === "false_positive_on_clean_data");
    return { dup: pct(dup.filter((x: any) => x.detected).length, dup.length), spike: pct(spike.filter((x: any) => x.detected).length, spike.length), fp: fp.length ? `${fp.filter((x: any) => x.detected).length} of ${fp.length} clean companies had any duplicate/unusual flag (${fp.reduce((s: number, x: any) => s + (x.count ?? 0), 0)} flags total)` : "n/a" };
  };
  const ae = anomalyTable("engine")!;
  const al = anomalyTable("plain-llm");

  const failures = [...det, ...(gem ?? []), ...(s1l ?? []), ...(s1 ?? [])]
    .filter((x: any) => x.intent.misses.length || x.matchOk === false || x.records?.ok === false || x.routing?.ok === false || (x.calc?.misses ?? []).length || x.feasibility?.ok === false || x.error)
    .map((x: any) => {
      const parts = [
        x.matchOk === false ? `match wrong (got ${x.kind})` : "",
        ...x.intent.misses,
        x.records?.ok === false ? `records missing: ${x.records.missing.join(", ")}` : "",
        x.routing?.ok === false ? `routing: missing [${x.routing.missing.join(", ")}] extra [${x.routing.extra.join(", ")}]` : "",
        ...(x.calc?.misses ?? []),
        x.feasibility?.ok === false ? `feasibility: expected ${x.feasibility.expected}, claimed ${x.feasibility.claimedFeasible}${x.feasibility.violatesReserve ? ", violates on recheck" : ""}` : "",
        x.error ?? "",
      ].filter(Boolean);
      return `- **${x.system} · ${x.id}** (${x.split}): ${parts.join("; ")}`;
    });

  const planted = res.anomalies.plants.map((p: any) => `| ${p.companyId} | ${p.kind.replace("_", " ")} | \`${p.plantedId}\` |`).join("\n");

  return `# Evaluation results

Generated by \`npm run eval\` on ${res.generatedAt}. Raw results: \`eval/out/results.json\`. Cases: \`eval/cases.ts\` (${res.cases} cases across ${new Set(det.map((x: any) => x.id)).size} prompts, ${det.filter((x: any) => x.split === "holdout").length} holdout). Every number below is computed from the raw results by \`eval/report.ts\`.

**Systems**

1. **Deterministic baseline**: regex intent parser + token-overlap company matching + the deterministic engine. No LLM.
2. **Plain LLM**: Gemini${res.geminiModel ? ` (\`${res.geminiModel}\`)` : ""} receives the same retrieved records as a text summary (\`eval/plain-llm.ts\`) and answers directly in JSON, with no engine. Its plan, if any, is replayed through our engine to check feasibility.
3. **Gemini + engine**: Gemini for intent, company ranking and wording, plus the deterministic engine for every number.
4. **System One stand-in + engine**: the System One provider (\`src/lib/providers/systemone.ts\`) answering through a **local stand-in**, the open-source zero-shot NLI model \`Xenova/nli-deberta-v3-xsmall\` running in-process, behind the same choice/yes-no contract as TypeSafe's \`/v1/systemone\`. It fills gaps the rules miss (flags at ≥0.8 probability, question kind at ≥0.5) and never overrides extracted numbers. **This is not System One**; it shows the integration and gives a free, local baseline.
5. **System One (TypeSafe) + engine**: the same provider against the real API. It runs only when \`TYPESAFE_API_KEY\` is set.

${gem ? `Gemini model: \`${res.geminiModel}\`.` : "**Systems 2 and 3 were not measured.** The only key available is on Gemini's free tier (20 requests per model per day), and a full run needs about 100 calls. Their columns say so rather than showing estimates. With a billed key in `.env.local`, rerun `npm run eval` to fill them in. Individual live requests were verified separately; see the README."}

## All cases

${table("all")}

## Holdout cases only

Holdout prompts were written before the first eval run and were not used to change any rule afterwards.

${table("holdout")}

## Planted anomalies

The organizers state the bank feed and books are clean (no duplicates), so detection is measured on **copies** of six companies with two planted anomalies each (\`eval/plant.ts\`). The app's data is never modified.

| | Engine (Money Detective) | Plain LLM |
|---|---|---|
| Duplicate bill detected | ${ae.dup} | ${al ? al.dup : NM} |
| Unusual expense detected | ${ae.spike} | ${al ? al.spike : NM} |
| False positives on the six unmodified companies | ${ae.fp} | ${al ? "see results.json (flagged_ids)" : NM} |
| False positives across all ${res.anomalies.cleanScan.companies} unmodified companies | ${res.anomalies.cleanScan.companiesFlagged} companies flagged, ${res.anomalies.cleanScan.flags} duplicate/unusual flags | not run |

What was planted:

| Company | Kind | Planted record id |
|---|---|---|
${planted}

Duplicate = the largest bill from the last 60 days re-entered one day later with identical vendor, category and amount. Unusual = a bill from the vendor/category with the most history at 8× its median amount (at least +$1,000), dated 10 days before the observation date.

${history}

## How each metric is computed

- **Company match**: only cases with no company selected. Correct = the expected company, or a clarifying question when the prompt is ambiguous.
- **Intent extraction**: each expected field in \`eval/cases.ts\` (decision type, question kind, hire count, salary, draw, marketing, price, equipment, stress flags, delay days, reserve, horizon, counterfactual customer) compared exactly with the validated task.
- **Required records**: the record types the task needs ⊆ the record types retrieved.
- **Calculation correctness**: every report-verifiable number the system shows (cash, receivables, overdue receivables, payables, annual profit, change in cash, annual revenue) compared to the dataset's own balance sheet, aging reports and P&L, to the cent. For the plain LLM, to within $1.
- **Feasibility**: for decision cases, whether the system's verdict (a feasible plan exists or not) matches the expectation. Each recommendation it calls feasible is replayed through fresh projections to check the reserve (base case) and solvency (payment-delay stress). The "conflicting" cases cannot be satisfied, so the correct answer is to say so.
- **Latency**: in-process wall time of the full pipeline per case (the same clock as the Sentry spans), after one warm-up run, with caches cleared before each case. HTTP and browser time are excluded. Plain-LLM latency is one model call.
- **Cost**: tokens from \`usageMetadata\` × list price per million tokens. The price is used only when configured (\`GEMINI_PRICE_IN_PER_M\` / \`GEMINI_PRICE_OUT_PER_M\`) or recorded in \`src/lib/pipeline/cost.ts\` for the model. Otherwise the report says "unknown price" and shows tokens.

## Failures

${failures.length ? failures.join("\n") : "None."}

## Not measured

${[
  gem ? null : "- Gemini + engine (system 3): free-tier Gemini quota (20 requests per model per day) is too small for the suite.",
  res.plainLlm ? null : "- Plain LLM baseline (system 2): same quota limit.",
  "- Intent extraction and company matching for the plain LLM: it produces no structured task, so these do not apply.",
  "- Latency through Sentry: no DSN was configured. Latency comes from the same in-process stage clock.",
  s1 ? null : "- Real System One (TypeSafe): no API key. The column uses the same provider code; set `TYPESAFE_API_KEY` and rerun.",
].filter(Boolean).join("\n")}
`;
}
