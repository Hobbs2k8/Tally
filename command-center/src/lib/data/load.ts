// Server-side loader for compiled company data. Access control lives here, in
// application code: callers can only reach companies in the compiled index.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { CompanyData, CompanySummary } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "compiled");

let indexCache: CompanySummary[] | null = null;
const companyCache = new Map<string, CompanyData>();

export function listCompanies(): CompanySummary[] {
  if (!indexCache) {
    indexCache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "index.json"), "utf8")) as CompanySummary[];
  }
  return indexCache;
}

export function hasCompany(id: string): boolean {
  return listCompanies().some((c) => c.id === id);
}

export function loadCompany(id: string): CompanyData {
  const cached = companyCache.get(id);
  if (cached) return cached;
  if (!hasCompany(id)) throw new Error(`Unknown company: ${id}`);
  const raw = fs.readFileSync(path.join(DATA_DIR, `${id}.json.gz`));
  const data = JSON.parse(zlib.gunzipSync(raw).toString("utf8")) as CompanyData;
  companyCache.set(id, data);
  return data;
}

export function isCompanyCached(id: string): boolean {
  return companyCache.has(id);
}
