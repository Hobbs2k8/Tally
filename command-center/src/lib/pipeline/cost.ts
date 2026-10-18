// Cost per task from token counts. Prices are per million tokens and must be
// configured (GEMINI_PRICE_IN_PER_M / GEMINI_PRICE_OUT_PER_M) unless the model
// is one whose list price we have recorded below. Unknown price -> null, never a guess.
import type { Usage } from "../providers/types";

const KNOWN: Record<string, { inPerM: number; outPerM: number }> = {
  // Introductory standard-tier price through 2026-12-31 (ai.google.dev "What's new in Gemini 3.8 Flash");
  // $1.50 / $7.50 from 2027-01-01. Update this line after that date.
  "gemini-3.8-flash": { inPerM: 0.75, outPerM: 3.75 },
  // Google AI Studio list prices (paid tier, text, <=200k context) as published for these models.
  "gemini-2.5-flash": { inPerM: 0.3, outPerM: 2.5 },
  "gemini-2.5-flash-lite": { inPerM: 0.1, outPerM: 0.4 },
  "gemini-2.0-flash": { inPerM: 0.1, outPerM: 0.4 },
};

export function priceFor(model: string | null): { inPerM: number; outPerM: number } | null {
  const envIn = Number(process.env.GEMINI_PRICE_IN_PER_M);
  const envOut = Number(process.env.GEMINI_PRICE_OUT_PER_M);
  if (envIn > 0 && envOut > 0) return { inPerM: envIn, outPerM: envOut };
  if (!model) return null;
  return KNOWN[model] ?? null;
}

export function estimateCost(u: Usage): number | null {
  if (!u.calls) return 0;
  const p = priceFor(u.model);
  if (!p) return null;
  return (u.inputTokens * p.inPerM + u.outputTokens * p.outPerM) / 1_000_000;
}
