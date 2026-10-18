// POST { request, companyId? } -> NDJSON stream: one line per pipeline stage
// event as it happens, then { type: "result", result }.
import { z } from "zod";
import { log } from "@/lib/observability";
import { runPipeline } from "@/lib/pipeline/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ request: z.string().min(3).max(2000), companyId: z.string().max(40).nullable().optional() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Expected { request: string, companyId?: string }" }, { status: 400 });
  const { request, companyId } = parsed.data;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await runPipeline(request, { companyId: companyId ?? null, emit: send });
        send({ type: "result", result });
      } catch (e) {
        log("error", "pipeline failed", { error: e instanceof Error ? e.message : String(e) });
        send({ type: "error", message: e instanceof Error ? e.message : "Pipeline failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
