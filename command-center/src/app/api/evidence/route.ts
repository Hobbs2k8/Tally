import { hasCompany, loadCompany } from "@/lib/data/load";
import { lookupEvidence } from "@/lib/evidence";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const company = url.searchParams.get("company") ?? "";
  const id = url.searchParams.get("id") ?? "";
  if (!hasCompany(company) || !id) return Response.json({ error: "unknown company or id" }, { status: 404 });
  const rec = lookupEvidence(loadCompany(company), id);
  return rec ? Response.json(rec) : Response.json({ error: "record not found" }, { status: 404 });
}
