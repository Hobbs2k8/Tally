// Pipeline stage instrumentation: every stage runs inside a Sentry span (one
// trace shows the whole request waterfall) and is also timed locally, so the
// UI's status strip and the eval latency numbers come from the same clock.
import * as Sentry from "@sentry/nextjs";

export interface StageEvent {
  type: "stage";
  stage: string;
  label: string;
  status: "start" | "done" | "skipped" | "error";
  ms?: number;
  detail?: string;
}

export type Emit = (e: StageEvent) => void;

export const sentryEnabled = () => Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN);

export async function stage<T>(emit: Emit, timings: Record<string, number>, name: string, label: string, fn: () => Promise<T> | T, detail?: (r: T) => string): Promise<T> {
  emit({ type: "stage", stage: name, label, status: "start" });
  // Duration is measured inside the span callback: synchronous work ends when fn
  // returns, async work when its promise settles. (Measuring after an outer
  // await would fold in whatever else ran on the event loop meanwhile.)
  let ms = 0;
  const t0 = performance.now();
  try {
    const result = await Sentry.startSpan({ name: `pipeline.${name}`, op: "pipeline.stage", attributes: { stage: name } }, () => {
      const start = performance.now();
      const r = fn();
      if (r instanceof Promise) return r.then((v) => ((ms = performance.now() - start), v));
      ms = performance.now() - start;
      return r;
    });
    timings[name] = (timings[name] ?? 0) + ms;
    emit({ type: "stage", stage: name, label, status: "done", ms, detail: detail?.(result) });
    return result;
  } catch (e) {
    ms = ms || performance.now() - t0;
    timings[name] = (timings[name] ?? 0) + ms;
    emit({ type: "stage", stage: name, label, status: "error", ms, detail: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

type LogAttrs = Record<string, string | number | boolean | null | undefined>;

/** Structured log to Sentry Logs (when configured) and the server console. */
export function log(level: "info" | "warn" | "error", message: string, attrs: LogAttrs = {}) {
  const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
  if (sentryEnabled()) Sentry.logger[level](message, clean);
  if (process.env.NODE_ENV !== "test" && !process.env.QUIET_LOGS) {
    const line = `[cc] ${level} ${message} ${JSON.stringify(clean)}`;
    if (level === "error") console.error(line);
    else console.log(line);
  }
}
