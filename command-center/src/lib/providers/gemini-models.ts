// Discovers Gemini model ids at runtime instead of hardcoding one we have not verified.

export async function listGenerateModels(apiKey: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken = "";
  do {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    if (!res.ok) throw new Error(`Gemini models.list failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string };
    for (const m of body.models ?? []) {
      if (m.supportedGenerationMethods?.includes("generateContent")) out.push(m.name.replace(/^models\//, ""));
    }
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/** Newest stable Flash model (not lite, not preview/experimental/tts/image) if any, else newest Flash of any kind. */
export function pickFlashModel(models: string[]): string | null {
  const flash = models.filter((m) => /flash/i.test(m) && !/(tts|image|audio|live|embedding|thinking)/i.test(m));
  const version = (m: string) => Number(m.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const stable = flash.filter((m) => !/(preview|exp|lite|\d{3}$)/i.test(m));
  const pool = stable.length ? stable : flash.filter((m) => !/lite/i.test(m)).length ? flash.filter((m) => !/lite/i.test(m)) : flash;
  return pool.sort((a, b) => version(b) - version(a) || a.length - b.length)[0] ?? null;
}
