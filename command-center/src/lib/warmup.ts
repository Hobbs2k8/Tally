// Warms the engine: loads the demo company and runs the hero pipeline once, so
// the first real request does not pay JIT and decompression costs (~110 ms cold
// vs ~20 ms warm in our stage timings; see docs/OBSERVABILITY.md). Called by
// GET /api/plan, which the page hits on load, so it warms the same module graph
// that serves POST /api/plan. Runs at most once per server process.
import { DEMO_COMPANY_ID, HERO_QUESTION } from "./demo";
import { log } from "./observability";
import { DeterministicProvider } from "./providers/deterministic";
import { runPipeline } from "./pipeline/run";

let warmed: Promise<void> | null = null;

export function warm(): Promise<void> {
  warmed ??= doWarm();
  return warmed;
}

async function doWarm(): Promise<void> {
  const t0 = performance.now();
  try {
    // Deterministic provider: warming must not spend model tokens.
    await runPipeline(HERO_QUESTION, { companyId: DEMO_COMPANY_ID, provider: new DeterministicProvider(), templateOnly: true });
    log("info", "engine warmed", { ms: Math.round(performance.now() - t0) });
  } catch (e) {
    log("warn", "warmup failed", { error: e instanceof Error ? e.message : String(e) });
  }
}
