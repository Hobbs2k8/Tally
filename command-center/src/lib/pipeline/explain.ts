// Bottom line: a deterministic template, optionally rewritten by the model.
// Any model text is accepted only if every number in it appears in the
// engine's facts; otherwise the template is used.
import { usd } from "../engine/format";

export interface ExplainFact {
  label: string;
  text: string; // formatted value as it may appear in prose, e.g. "$24,778" or "30 days"
}

/** Numbers that appear in prose: "$24,778", "$24.8k", "30", "43.4%". Returns normalised numeric values. */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  const re = /\$?\s?-?\d[\d,]*(?:\.\d+)?\s?(k|m|%)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].replace(/[$,\s]/g, "");
    let v = parseFloat(raw);
    if (!Number.isFinite(v)) continue;
    const suf = (m[1] ?? "").toLowerCase();
    if (suf === "k") v *= 1_000;
    if (suf === "m") v *= 1_000_000;
    out.push(Math.abs(v));
  }
  return out;
}

/**
 * True if every number in `text` matches a fact value (within rounding: 1% or
 * one unit), or is a small ordinal/count (<= 13: weeks, staff counts). Week
 * numbers and counts are allowed because they also come from the facts.
 */
export function numbersGrounded(text: string, facts: ExplainFact[]): { ok: boolean; ungrounded: number[] } {
  const allowed = facts.flatMap((f) => extractNumbers(f.text));
  const ungrounded = extractNumbers(text).filter((n) => {
    if (n <= 13 && Number.isInteger(n)) return false;
    if (n === 90) return false; // "90 days" horizon
    return !allowed.some((a) => Math.abs(a - n) <= Math.max(1, a * 0.01));
  });
  return { ok: ungrounded.length === 0, ungrounded };
}

export const money = (c: number) => usd(c);
