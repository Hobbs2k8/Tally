# QuickBooks Command Center

**Turn your business finances into a clear, evidence-backed action plan.**

A business owner describes a decision in plain English ("hire two people, spend more on marketing, take a draw: what's the safest plan for the next 90 days?"). Command Center reads that company's books, picks the checks the question needs, runs them on a deterministic financial engine, verifies every number, and returns one plan with sources for every figure.

It is one decision engine, not a chatbot or a set of dashboards. The user never picks a capability: the router chooses the minimum set for each request.

| Capability | What it does | Code |
|---|---|---|
| Flight Simulator | Weekly 90-day cash projection of a decision vs today's plan | `src/lib/engine/projection.ts`, `plan.ts` |
| Money Detective | Overdue invoices, customers paying far later than usual, possible duplicates, unusual bills, sharp cash moves. Each finding is labeled verified or hypothesis | `engine/detective.ts` |
| Autopilot | Ranked actions and invoice-reminder drafts. Approve only marks a draft approved; nothing is ever sent or paid | `pipeline/actions.ts` |
| Profit Leak Radar | Margin decline, cost creep, rising cost share, bad debt, thin-margin customers, with estimated $ impact | `engine/margin.ts` |
| Future Accountant | Answers from the books: profit vs cash (an exact bridge), who owes you, top expenses, runway, revenue trend | `engine/accountant.ts` |
| Time Machine | "What if X had paid on time": replays the bank feed. Fact (solid) and estimate (dashed) stay separate | `engine/timemachine.ts` |
| Negotiation Coach | Supplier terms, early-payment discounts and price changes vs liquidity and margin, with every counterparty behaviour labeled as an assumption | `engine/negotiation.ts` |
| Chaos Simulator | Deterministic stress grid (sales drop × payment delay × cost shock) and breaking points. No probabilities | `engine/stress.ts` |

## Setup

```bash
cd command-center
npm install
npm run dev            # http://localhost:3000
```

No keys are needed: without `GEMINI_API_KEY` the app runs on the deterministic provider. To enable Gemini and Sentry, copy `.env.example` to `.env.local` and fill in `GEMINI_API_KEY`, `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` (and optionally `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` for source maps). Keys stay on the server. All model calls happen in API routes.

The compiled dataset for all 100 companies (`data/compiled/`, 8.6 MB gzipped) is committed, so a clean clone needs no download. To rebuild it from the YAML (the DealRoom repo's `../data`, or `QB_SOURCE_DIR`): `npm run data`.

| Command | What it does |
|---|---|
| `npm run dev` | The app |
| `npm test` | 357 tests: engine unit tests (zero cash, negative runway, reserve breach on day 1, invoices with no due date, …), exact reconciliation with the dataset's reports for all 100 companies, provider validation and fallback |
| `npm run project [company-id]` | Prints the 90-day baseline projection |
| `npm run hero -- --summary` | Runs the hero question end to end in the terminal (`--company`, `--question`, or omit `--summary` for JSON) |
| `npm run eval` | Evaluation suite → `docs/EVAL_RESULTS.md` |
| `npm run gemini:models` | Lists Gemini models available to your key and the Flash model the app would pick |

## Architecture

```
request ─▶ intent (Gemini structured output → Zod; retry once; else regex parser)
        ├▶ company match (selected in UI, or deterministic filter → Gemini ranks → clarify if ambiguous)
        ▼
        retrieve (only the record types the task needs; per-company context cache)
        ▼
        route (minimum capability set)
        ▼
        capabilities: detective · radar · accountant · simulate+stress (336 plan variants) · time machine · negotiation
        ▼
        validate (engine constraints, reconciliation with reports, reserve/solvency recheck)
        ▼
        rank actions ─▶ explain (template from engine facts; Gemini may reword, and any number not in the facts → rejected)
        ▼
        one consolidated plan (streamed: each stage is reported as it finishes)
```

- **The model never does arithmetic that reaches the output.** Every number comes from the engine (`src/lib/engine`, pure TypeScript with integer cents). Gemini only reads the request, ranks candidate companies, and may reword the bottom line. That wording is checked (`pipeline/explain.ts`), and if it cites any number that is not an engine fact it is discarded for the template.
- **Provenance on every number:** historical (with source record ids), calculated, projection, assumption, or hypothesis. The UI tags each one (H / C / P / A / ?). Charts draw actual cash solid and projections dashed, and any source id opens the evidence drawer.
- **Live what-ifs with no model call.** The plan ships its `ProjectionInputs` (plain JSON) to the browser. Editing an assumption reruns the engine client-side (`pipeline/simulate.ts`), reusing cached projections for scenarios that did not change. The UI reports what it recomputed, e.g. "Recomputed 2 of 6 scenario projections + plan search in 14.7 ms · no model call".
- **Safest plan.** The search tries hire timing and count, draw timing and size, marketing start and size, and supplier terms. Feasible = cash at or above the reserve every week in the base case, and never below zero under the payment-delay stress. Among feasible variants it picks the one that delivers the most of what was asked. If none is feasible, it says so and shows the least risky option.
- **Access control in code.** Only companies in the compiled index are reachable, and ids a model returns are filtered against that list.

## Reasoning providers: what is real

| Provider | Status |
|---|---|
| `DeterministicProvider` (`src/lib/providers/deterministic.ts`) | **Real, and the default when no key is set.** Regex intent parser and token-overlap company matching. Also the eval baseline |
| `GeminiProvider` (`src/lib/providers/gemini.ts`) | **Implemented, used automatically when `GEMINI_API_KEY` is set.** Picks the newest stable Flash model available to the key at runtime (no hardcoded model id) unless `GEMINI_MODEL` is set. Unit-tested with a fake client (validation, retry, fallback, auth errors, invented ids, ungrounded numbers). **It has not been run against the live API in this repo yet: no key was available while we built it.** |
| `SystemOneProvider` (`src/lib/providers/systemone.ts`) | **Stub.** It delegates to the deterministic rules and reports `fellBack: true`, so nothing is ever labeled as System One output. The file documents the exact interface. Wiring in System One / TypeSafe Jev is a one-file change plus `REASONING_PROVIDER=systemone` |

We make no System One performance claims.

## Observability (Sentry)

Tracing (one span per pipeline stage, propagated from the browser), Logs (provider, intent source, cache hit/miss, routing, validation failures, rejected wording), and Session Replay, plus request error capture. `docs/OBSERVABILITY.md` records what the stage timings showed and what we changed:

- overlapping `Promise.all` spans that overstated stages;
- a projection allocation fix: plan search p50 from 5.0 to 3.1 ms;
- a route-level warm-up: first request from 97 to 32 ms.

No Sentry DSN was configured while we built this. Those findings come from the same stage clock that feeds the spans.

## Evaluation

`npm run eval` runs 28 known-answer cases (12 holdout) across 16 companies in 15 industries and all 7 business shapes. Tags include ambiguous prompts, missing data, conflicting constraints, delayed payments, and interacting decisions. Numbers are checked against the dataset's own reports. Anomaly detection is measured on planted copies. Full results, failures and iteration history are in `docs/EVAL_RESULTS.md`.

Current results, deterministic system (the only one measured so far):

| Metric | Result |
|---|---|
| Calculation correctness | 100% |
| Company match | 100% |
| Intent fields | 99% (one holdout miss, kept as is) |
| Planted anomalies caught | 12/12 |
| p50 latency | under 10 ms |

There are still false positives on clean data (19 of 100 companies flagged). **The plain-LLM and Gemini + engine columns say "not measured" until the eval is run with a key.**

## Chat agent on Agentverse (ASI:One)

`agents/command_center.py` in the DealRoom repo root runs the Command Center as a Fetch.ai uAgent that speaks the Agent Chat Protocol, so an owner can ask it questions from ASI:One. It uses the same Python setup as the DealRoom buyer agent (uagents 0.26.1, no new dependencies). Each chat message becomes `POST /api/plan`; the reply is plain text: the bottom line, the top 3 actions and, for each scenario, lowest cash, ending cash and the stress-test low. `company <id or name>` switches company (`company 3`, `company roastline`; default company-002), `companies` lists them.

```bash
# terminal 1
cd command-center && npm run dev
# terminal 2, from the DealRoom repo root (python -m venv .venv && .venv/bin/pip install -r requirements.txt if not done)
echo 'COMMAND_CENTER_SEED=<any long random string>' >> .env     # once; keep it stable, the agent address comes from it
.venv/bin/python -m agents.command_center
```

One time: the agent prints an Agentverse inspector link. Open it, click **Connect**, choose **Mailbox**. After that, find `quickbooks-command-center` in ASI:One or chat with it from its Agentverse page. The mailbox only stays live while the agent and `npm run dev` are running on your machine.

Local test without Agentverse (needs `npm run dev`): `.venv/bin/python -m scripts.command_center_test`. It checks the reply formatter and company lookup against the live API, then runs the agent and a fake owner agent in one local Bureau and chats through the protocol (help, switch company, two questions, an unknown company).

Optional settings: `COMMAND_CENTER_URL` (default `http://localhost:3000`), `COMMAND_CENTER_COMPANY` (default `company-002`), `COMMAND_CENTER_PORT` (default 8002; the DealRoom Bureau uses 8000).

## Dataset changes

None in the app. See `docs/SYNTHETIC_CHANGES.md`: the eval plants two anomalies in in-memory copies of six companies, and everything else is derived and reconciled. `docs/DATA_MAP.md` covers every table, the joins, what each capability can and cannot do with this data, and why Roastline Coffee Roasters (company-002) is the demo company.

## Limitations

- One year of history per company: no seasonality and no year-over-year comparison.
- Payroll is gross (no taxes in the data). No sales tax.
- Run-rates come from the trailing 13 weeks.
- Weekly granularity: a mid-week dip below the reserve can be missed.
- Behaviour of customers and suppliers (paying faster, accepting longer terms, reacting to price) is an assumption, always labeled and editable, never data.
- Anomaly rules still flag some legitimate charges (see the eval).
- The deterministic parser covers the question shapes in `eval/cases.ts` and similar phrasings. Unusual phrasing needs Gemini, and an unparsed constraint, e.g. "never dropping below $X", is missed by the rules.
- Gemini integration is unverified against the live API (see above).

## 2-minute demo script

1. **(0:00) The promise.** Open the app. "Describe a decision, get one plan with the receipts." Company: Roastline Coffee Roasters, a real company from the dataset with $96k cash, 7 staff, and $24.8k of overdue invoices.
2. **(0:10) Ask the hero question.** Click *Run the demo*. Point at the pipeline strip on the left: real stages, each with its own timing (understanding, pulling records, investigating, simulating 336 plan variants, verifying).
3. **(0:25) Bottom line.** "Don't do it all at once: doing everything now runs out of cash if customers pay 30 days late. Safest plan: chase the $24,778 overdue, hire both in week 9, take the $17,000 draw in week 7, ask suppliers for 14 more days." Every number has a tag: H = from the books, P = projection.
4. **(0:45) Evidence.** Expand "$24,778 of receivables is overdue" and click an invoice id: the drawer shows the actual record, its payments, and its due date.
5. **(1:00) The chart.** Actual cash is solid, the three plans are dashed, and the reserve is marked. Toggle *Payments +30 days*: the proposal goes below zero and the recommended plan holds.
6. **(1:15) Live what-if.** In Assumptions, drag the owner draw to $40,000. The chart, table and bottom line update instantly ("Recomputed … in ~15 ms · no model call"), and the plan now suggests taking only $20k.
7. **(1:35) Stress test.** The grid and breaking points show where the recommended plan breaks: below the reserve at 25 days late, out of cash at 35 days, below the reserve if costs rise 40%.
8. **(1:45) Autopilot.** Reminder drafts: Approve marks them approved, nothing is sent.
9. **(1:50) Trust.** Open "How this was produced": 6/6 validation checks, routing reasons, the structured task. Ask "Why is my profit different from my cash?": a short, exact answer, not a 9-section plan.
