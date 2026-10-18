# Observability

## What is instrumented

| Sentry product | Where | What it records |
|---|---|---|
| **Tracing** | `src/lib/observability.ts` (`stage()`), `src/lib/pipeline/run.ts` | One root span `pipeline` per request and one child span per stage: `pipeline.intent`, `pipeline.match_rank`, `pipeline.match`, `pipeline.retrieve`, `pipeline.route`, `pipeline.investigate`, `pipeline.leaks`, `pipeline.answer`, `pipeline.simulate` (with a nested `simulate.scenarios` engine span), `pipeline.time_machine`, `pipeline.negotiate`, `pipeline.validate`, `pipeline.rank`, `pipeline.explain`. The browser SDK (`browserTracingIntegration`) propagates the trace to `/api/plan`, so one trace shows page → API → every stage. |
| **Logs** | `log()` in `src/lib/observability.ts` | Structured events with attributes: `intent` (provider, source = model / fallback / rules, intent cache hit or miss, decision type), `retrieve` (company, context cache hit or miss, record types), `route` (capabilities, mode), `validation failed` (check, detail), `intent validation failed` / `intent call failed` (attempt, error), `explanation rejected` (the ungrounded numbers), `company ranking failed`, `gemini model selected`, `plan complete` (total ms, tokens, explain source), `engine warmed`. |
| **Session Replay** | `src/instrumentation-client.ts` | `replayIntegration()` at 100% session sampling for the demo (`maskAllText: false`, since the dataset is synthetic). |
| Error monitoring | `onRequestError = Sentry.captureRequestError` | Unhandled route errors. |

Each stage is also timed locally on the same clock. That timing drives the live pipeline strip in the UI, the "How this was produced" panel, and the latency numbers in `EVAL_RESULTS.md`.

Sentry turns on when `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` are set. **No DSN was available while we built this**, so everything below comes from the local stage timings: the same `stage()` wrapper that opens each Sentry span, run through the dev server and `npm run hero`. With a DSN set, the same spans appear in Sentry with no code changes.

## What the stage timings showed, and what we changed

### 1. Overlapping spans that lied about where time went

The first version ran the capability stages concurrently:
`Promise.all([investigate, leaks, simulate, …])`. The pipeline strip reported (hero request, demo company):

```
investigate 100.8 ms · leaks 53.5 ms · simulate 48.4 ms   (first run)
investigate  87.6 ms · leaks 49.5 ms · simulate 44.4 ms   (second run)
```

Profiling each function on its own told a different story: investigate 25.6 ms cold / 3.8 ms warm, leaks 6.0 / 4.3 ms. The engine is synchronous CPU work, so `Promise.all` interleaves only at `await` points and gives **no parallelism**. And because each stage stopped its clock after an outer `await`, every span absorbed the CPU time of the stages queued behind it. The waterfall showed three "parallel" stages that were really serialized, and investigate looked 3× slower than it was.

Changes (`src/lib/observability.ts`, `src/lib/pipeline/run.ts`):
- Duration is now measured inside the span callback: synchronous work ends when the function returns, async work when its promise settles.
- The CPU-bound capability stages run sequentially, so their spans are honest.
- `Promise.all` stays only where the work really is concurrent: intent extraction and company ranking are two independent model calls when no company is selected.

After the fix (same request, cold CLI process): `investigate 31.0 · leaks 4.9 · simulate 44.8 ms`.

### 2. The real bottleneck: the plan search

With honest spans and caches warm, `simulate` was the dominant stage: **62.5 / 62.2 / 60.9 ms** on requests 2–4 against the dev server (total 80–86 ms), about 75% of the request. Inside it, the safest-plan search projects 336 plan variants (168 lever combinations, each in the base case and under stress). The projection allocated a temporary array for every week of the collection-curve and variable-cost convolutions, roughly 2 × 13 short-lived arrays per projection, times 336.

Change (`src/lib/engine/projection.ts`): accumulate those flows directly into one per-week array per projection.

Measured on the same search (`searchSafestPlan` on company-002, 60 runs, first 10 dropped as warm-up):

| | First call | Steady p50 | Steady p95 |
|---|---:|---:|---:|
| Before | 37.5 ms | 5.03 ms | 5.56 ms |
| After | 35.0 ms | 3.10 ms | 3.44 ms |

Outputs are unchanged (all 357 tests pass, including exact projection values).

### 3. Cold start dominated the first request

The table above has a second finding: the first call costs about 35 ms no matter what, because of JIT warm-up. The first hero request after a server start took 113–131 ms in total, against about 21 ms at steady state (10 consecutive requests: 20.1–26.4 ms). It also paid decompression and context building (`retrieve` 36–54 ms on a cold cache, 0.0 ms on a hit).

We first tried warming the engine from `instrumentation.ts` at server start. The next request still showed `context: miss`: Next.js loads instrumentation in a separate module graph from the route handlers, so neither the caches nor the JIT state carried over. We moved the warm-up into the route itself. `GET /api/plan` runs the hero pipeline once (deterministic provider, no tokens spent), and the page calls it on load while the user is still reading. The first real request after a fresh start then measured **31.6 ms** (context cache hit), down from 97 ms without the warm-up.

### 4. Logs we rely on

- `intent` with `source=fallback` means Gemini's structured output failed Zod validation twice and the deterministic parser took over. The UI also says so under "How this was produced".
- `explanation rejected` lists any number in the model's wording that was not in the engine's facts. The template is shown instead.
- `retrieve` and `intent` carry `cache=hit|miss`, which is how we confirmed the per-company context cache and per-request intent cache work.
