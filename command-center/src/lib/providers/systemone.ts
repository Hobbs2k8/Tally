// SystemOneProvider: STUB. Not wired to any model.
//
// TODO(system-one): implement against Intuit / TypeSafe System One ("Jev")
// once endpoint details or credentials are available. Wiring it in should only
// require changing this file and setting REASONING_PROVIDER=systemone.
//
// What it must satisfy (ReasoningProvider in ./types.ts):
//   extractIntent(request)            -> { task: Task (validated by TaskSchema), usage, attempts, fellBack }
//   rankCompanies(request, candidates)-> { ranked: [{ id, score 0..1, reason }], usage }
//   proposeScenarios(task, summary)   -> { proposals: ScenarioProposal[], usage }  (bounded lever changes; the engine evaluates them)
//   explain(input)                    -> { text, usage }  (may only cite numbers in input.facts; the pipeline rejects anything else)
//
// Known shape of the TypeSafe SDK used elsewhere in this repo (Python, typesafe-sdk 0.7.5,
// see ../../../../core/jev.py): client.system_one(state=..., questions={name: Choice(instructions, criteria)})
// returns response.choices[name].probabilities. A natural fit here is ranking:
// candidate companies, capability routing, or plan variants as Choice criteria.
// We have not verified a JavaScript client or HTTP endpoint, so nothing below calls one.
import { DeterministicProvider } from "./deterministic";
import type { ReasoningProvider } from "./types";

export class SystemOneProvider implements ReasoningProvider {
  readonly name = "systemone" as const;
  private readonly fallback = new DeterministicProvider();

  model() {
    return null;
  }

  // Until implemented, every method delegates to the deterministic rules and
  // reports that it fell back, so results are never mislabeled as System One output.
  async extractIntent(request: string) {
    const r = await this.fallback.extractIntent(request);
    return { ...r, fellBack: true, error: "SystemOneProvider is a stub" };
  }
  rankCompanies: ReasoningProvider["rankCompanies"] = (req, c) => this.fallback.rankCompanies(req, c);
  proposeScenarios: ReasoningProvider["proposeScenarios"] = () => this.fallback.proposeScenarios();
  explain: ReasoningProvider["explain"] = (i) => this.fallback.explain(i);
}
