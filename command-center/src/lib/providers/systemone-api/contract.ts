// TypeSafe System One request/response contract (POST {base}/v1/systemone),
// transcribed from the official typesafe-sdk 0.7.5 schemas (_schemas/models.py).
// Only the question types we use are modelled: choice, noul (yes/no) and score.

export type Criteria = string;

export interface ChoiceQuestion {
  type: "choice";
  instructions?: string;
  criteria: Record<string, Criteria>; // option name -> description
}

export interface NoulQuestion {
  type: "noul";
  instructions?: string;
  criteria?: { true?: Criteria; false?: Criteria };
}

export interface ScoreQuestion {
  type: "score";
  instructions?: string;
  criteria: Criteria[]; // ordered levels
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface SystemOneRequest {
  model: string; // e.g. "jev-latest"
  state: string | Record<string, unknown>;
  questions: Record<string, Question>;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number; // probability of "true"
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Anything that answers System One requests: the real API, or the local stand-in. */
export interface SystemOneTransport {
  readonly kind: "typesafe" | "local-standin";
  readonly label: string;
  ask(req: SystemOneRequest): Promise<SystemOneResponse>;
  preload?(): Promise<void>;
}
