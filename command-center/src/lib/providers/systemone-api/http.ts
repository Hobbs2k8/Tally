// Real TypeSafe System One over HTTP (Authorization: Bearer <TYPESAFE_API_KEY>).
// Same endpoint, headers and body the official SDK sends. Not exercised live:
// we have no key (see README).
import type { SystemOneRequest, SystemOneResponse, SystemOneTransport } from "./contract";

export function httpTransport(apiKey: string, baseUrl = process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai", timeoutMs = 10_000): SystemOneTransport {
  return {
    kind: "typesafe",
    label: "TypeSafe System One",
    async ask(req: SystemOneRequest): Promise<SystemOneResponse> {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`System One ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as SystemOneResponse;
    },
  };
}
