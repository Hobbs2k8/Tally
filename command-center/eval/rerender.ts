// Re-renders docs/EVAL_RESULTS.md from eval/out/results.json without rerunning
// any model call; costs are recomputed from the recorded token counts.
import fs from "node:fs";
import path from "node:path";
import { estimateCost } from "../src/lib/pipeline/cost";
import { renderReport } from "./report";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const file = path.join(root, "eval", "out", "results.json");
const res = JSON.parse(fs.readFileSync(file, "utf8"));
for (const rows of Object.values(res.systems) as { usage: never; costUsd: number | null }[][]) for (const r of rows) r.costUsd = estimateCost(r.usage);
for (const r of res.plainLlm ?? []) if (r.usage) r.costUsd = estimateCost(r.usage);
fs.writeFileSync(file, JSON.stringify(res, null, 2));
fs.writeFileSync(path.join(root, "docs", "EVAL_RESULTS.md"), renderReport(res));
console.log("Re-rendered docs/EVAL_RESULTS.md");
