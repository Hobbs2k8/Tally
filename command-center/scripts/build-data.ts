// Compiles the hackathon YAML into compact JSON under data/compiled/.
//
//   npm run data                       # every company present in the source folder
//   npm run data -- company-002 ...    # specific companies
//
// The compiled output for all 100 companies (~9 MB gzipped) is committed, so a
// clean clone runs without the YAML; this script only needs rerunning if the
// compile format changes.
//
// Source folder: QB_SOURCE_DIR, default ../data (the DealRoom repo's dataset folder).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { compileCompany, summarize } from "../src/lib/data/compile";


const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = path.resolve(root, process.env.QB_SOURCE_DIR ?? "../data");
const out = path.join(root, "data", "compiled");
fs.mkdirSync(out, { recursive: true });

const index: Record<string, unknown>[] = JSON.parse(fs.readFileSync(path.join(source, "index.json"), "utf8"));
const args = process.argv.slice(2);
const wanted = args.length ? args : index.map((r) => r.company_id as string);

const available = new Set(fs.readdirSync(source).filter((d) => d.startsWith("company-")));
const summaries = [];
for (const row of index) {
  const id = row.company_id as string;
  const target = path.join(out, `${id}.json.gz`);
  if (wanted.includes(id)) {
    if (!available.has(id)) {
      console.warn(`skip ${id}: not in ${source} (run DealRoom's scripts/fetch_data.sh for the full set)`);
    } else {
      const t0 = performance.now();
      const data = compileCompany(source, id, row);
      fs.writeFileSync(target, zlib.gzipSync(JSON.stringify(data), { level: 9 }));
      const kb = Math.round(fs.statSync(target).size / 1024);
      console.log(`${id} ${data.name.padEnd(32)} ${kb} KB  ${Math.round(performance.now() - t0)} ms`);
    }
  }
  if (fs.existsSync(target)) {
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(target)).toString("utf8"));
    summaries.push(summarize(row, data));
  }
}
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(summaries, null, 1));
console.log(`index.json: ${summaries.length} companies available`);
