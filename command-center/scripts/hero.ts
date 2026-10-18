// Runs the hero question end to end and prints the plan as JSON.
//   npm run hero                         # demo company, provider from env
//   npm run hero -- --company company-021 --question "..." --summary
import fs from "node:fs";
import { loadEnv } from "./env";
loadEnv();
process.env.QUIET_LOGS = "1";
const { runPipeline } = await import("../src/lib/pipeline/run");
const { DEMO_COMPANY_ID, HERO_QUESTION } = await import("../src/lib/demo");
const { usd } = await import("../src/lib/engine/format");

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const companyId = arg("company") ?? DEMO_COMPANY_ID;
const question = arg("question") ?? HERO_QUESTION;
const r = await runPipeline(question, { companyId });

if (process.argv.includes("--summary") && r.kind === "plan") {
  console.log(`\n${r.company.name} · provider ${r.provider.name} · ${Math.round(r.totalMs)} ms`);
  console.log(`Capabilities: ${r.capabilities.join(", ")}`);
  console.log(`\nBOTTOM LINE (${r.bottomLine.source}): ${r.bottomLine.text}\n`);
  if (r.simulation) {
    const { result, assumptions } = r.simulation;
    for (const sc of result.scenarios) {
      const p = result.projections[sc.id].summary;
      const s = result.stressedProjections[sc.id].summary;
      console.log(`${sc.name.padEnd(18)} end ${usd(p.endingCash).padStart(9)}  low ${usd(p.minCash).padStart(9)}  stressed low ${usd(s.minCash).padStart(9)}  feasible ${result.feasible[sc.id]}`);
    }
    console.log(`\nAssumptions: ${assumptions.map((a) => `${a.label}=${a.unit === "usd" ? usd(a.value) : a.value} (${a.source})`).join("; ")}`);
  }
  console.log(`\nTop actions:\n${r.actions.slice(0, 6).map((a) => `  - ${a.title} [${a.urgency}]`).join("\n")}`);
  console.log(`\nValidation: ${r.validation.map((v) => `${v.ok ? "ok" : "FAIL"} ${v.name}`).join(" | ")}`);
  console.log(`Timings (ms): ${Object.entries(r.timings).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ")}`);
} else {
  const out = arg("out");
  const json = JSON.stringify(r, null, 2);
  if (out) fs.writeFileSync(out, json);
  else console.log(json);
}
