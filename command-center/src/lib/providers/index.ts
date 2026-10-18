// Picks the reasoning provider from the environment.
//   REASONING_PROVIDER=gemini|deterministic|systemone
//   (systemone uses TypeSafe when TYPESAFE_API_KEY is set, else the local open-source stand-in)
//   default: gemini when GEMINI_API_KEY is set, else deterministic
import { DeterministicProvider } from "./deterministic";
import { GeminiProvider, sdkClient } from "./gemini";
import { SystemOneProvider } from "./systemone";
import { httpTransport } from "./systemone-api/http";
import { localTransport } from "./systemone-api/local";
import type { ReasoningProvider } from "./types";

let cached: ReasoningProvider | null = null;

export function makeProvider(name: string): ReasoningProvider {
  const key = process.env.GEMINI_API_KEY;
  // Real System One when a TypeSafe key exists; otherwise the labelled local stand-in.
  if (name === "systemone") return new SystemOneProvider(process.env.TYPESAFE_API_KEY ? httpTransport(process.env.TYPESAFE_API_KEY) : localTransport());
  if (name === "gemini") {
    if (!key) throw new Error("REASONING_PROVIDER=gemini needs GEMINI_API_KEY");
    return new GeminiProvider(sdkClient(key), key, process.env.GEMINI_MODEL || null);
  }
  return new DeterministicProvider();
}

export function getProvider(): ReasoningProvider {
  if (cached) return cached;
  const want = (process.env.REASONING_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : "deterministic")).toLowerCase();
  cached = makeProvider(want);
  return cached;
}

export function setProvider(p: ReasoningProvider | null) {
  cached = p;
}
