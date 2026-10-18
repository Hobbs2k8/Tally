// Picks the reasoning provider from the environment.
//   REASONING_PROVIDER=gemini|deterministic|systemone
//   default: gemini when GEMINI_API_KEY is set, else deterministic
import { DeterministicProvider } from "./deterministic";
import { SystemOneProvider } from "./systemone";
import type { ReasoningProvider } from "./types";

let cached: ReasoningProvider | null = null;

export function getProvider(): ReasoningProvider {
  if (cached) return cached;
  const want = (process.env.REASONING_PROVIDER || "").toLowerCase();
  if (want === "systemone") cached = new SystemOneProvider();
  else cached = new DeterministicProvider();
  return cached;
}

export function setProvider(p: ReasoningProvider | null) {
  cached = p;
}
