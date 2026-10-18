// Every number the engine emits carries where it came from. The UI renders
// each kind differently (historical solid, assumptions editable, projections dashed).

export type Provenance =
  | { kind: "historical"; sources: string[]; sourceCount: number; note?: string }
  | { kind: "user_assumption"; note?: string }
  | { kind: "synthetic_extension"; note?: string }
  | { kind: "model_hypothesis"; note?: string }
  | { kind: "calculated"; inputs: string[]; note?: string };

export type Unit = "usd" | "days" | "weeks" | "pct" | "count" | "ratio";

export interface Figure {
  value: number; // cents for usd
  unit: Unit;
  provenance: Provenance;
  label?: string;
}

const MAX_SOURCES = 25;

export function historical(value: number, unit: Unit, sources: string[], note?: string): Figure {
  return {
    value,
    unit,
    provenance: { kind: "historical", sources: sources.slice(0, MAX_SOURCES), sourceCount: sources.length, note },
  };
}

export function calculated(value: number, unit: Unit, inputs: string[], note?: string): Figure {
  return { value, unit, provenance: { kind: "calculated", inputs, note } };
}

export function assumption(value: number, unit: Unit, note?: string): Figure {
  return { value, unit, provenance: { kind: "user_assumption", note } };
}

export function hypothesis(value: number, unit: Unit, note?: string): Figure {
  return { value, unit, provenance: { kind: "model_hypothesis", note } };
}
