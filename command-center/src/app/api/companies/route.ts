import { listCompanies } from "@/lib/data/load";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(listCompanies());
}
