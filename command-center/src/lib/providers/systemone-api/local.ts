// LOCAL STAND-IN for System One. Not System One, and never labelled as such.
//
// Answers the same request shape with an open-source zero-shot NLI model
// (Xenova/nli-deberta-v3-xsmall, MIT, via Transformers.js) running in-process:
// no API key, no network after the first model download (~90 MB, cached in
// .cache/models). Each option or yes/no criterion is scored as an entailment
// hypothesis against the request text, which gives the same kind of output
// System One returns: a choice with probabilities, or P(true).
import path from "node:path";
import type { Answer, SystemOneRequest, SystemOneResponse, SystemOneTransport } from "./contract";

export const LOCAL_MODEL = process.env.SYSTEMONE_LOCAL_MODEL || "Xenova/nli-deberta-v3-xsmall";

type Classifier = (text: string, labels: string[], opts: { hypothesis_template: string; multi_label: boolean }) => Promise<{ labels: string[]; scores: number[] }>;
let loading: Promise<Classifier> | null = null;

async function classifier(): Promise<Classifier> {
  loading ??= (async () => {
    const tf = await import("@huggingface/transformers");
    tf.env.cacheDir = path.join(process.cwd(), ".cache", "models");
    return (await tf.pipeline("zero-shot-classification", LOCAL_MODEL, { dtype: "q8" })) as unknown as Classifier;
  })();
  return loading;
}

function stateText(state: SystemOneRequest["state"]): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

export function localTransport(): SystemOneTransport {
  return {
    kind: "local-standin",
    label: `local stand-in (${LOCAL_MODEL.split("/")[1]})`,
    async preload() {
      await classifier();
    },
    async ask(req: SystemOneRequest): Promise<SystemOneResponse> {
      const clf = await classifier();
      const text = stateText(req.state);
      const answers: Record<string, Answer> = {};
      for (const [name, q] of Object.entries(req.questions)) {
        if (q.type === "noul") {
          const hyp = q.criteria?.true ?? q.instructions ?? name;
          const r = await clf(text, [hyp], { hypothesis_template: "{}", multi_label: true });
          answers[name] = { type: "noul", noul: r.scores[0] };
        } else {
          const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
          const descs = q.type === "choice" ? Object.values(q.criteria) : q.criteria;
          const r = await clf(text, descs, { hypothesis_template: "{}", multi_label: false });
          const probabilities: Record<string, number> = {};
          r.labels.forEach((label, i) => (probabilities[keys[descs.indexOf(label)]] = r.scores[i]));
          const best = keys[descs.indexOf(r.labels[0])];
          answers[name] = q.type === "choice" ? { type: "choice", choice: best, confidence: r.scores[0], probabilities } : { type: "score", score: Number(best), confidence: r.scores[0], probabilities };
        }
      }
      return { model: `local-standin/${LOCAL_MODEL}`, answers, usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };
}
