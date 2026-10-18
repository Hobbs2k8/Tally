// Lists Gemini models available to GEMINI_API_KEY and shows which Flash model
// the app would pick. Run: npm run gemini:models
import { loadEnv } from "./env";
import { listGenerateModels, pickFlashModel } from "../src/lib/providers/gemini-models";

loadEnv();
const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY is not set (.env.local). The app will use the DeterministicProvider.");
  process.exit(1);
}
const models = await listGenerateModels(key);
console.log(`${models.length} models support generateContent:`);
for (const m of models) console.log(`  ${m}`);
console.log(`\nWould use: ${process.env.GEMINI_MODEL || pickFlashModel(models) || "(no Flash model found)"}`);
