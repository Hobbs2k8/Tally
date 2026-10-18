"use client";
// A number with its provenance: historical, calculated, assumption, projection or hypothesis.
import type { Figure, Provenance } from "@/lib/engine/provenance";
import { pct, usd } from "@/lib/engine/format";

export type Prov = Provenance["kind"] | "projection";

const TAG: Record<Prov, { letter: string; label: string; cls: string }> = {
  historical: { letter: "H", label: "Historical: read from the books", cls: "text-ink-2 border-rule-strong" },
  calculated: { letter: "C", label: "Calculated by the engine from historical records", cls: "text-ink-2 border-rule-strong" },
  projection: { letter: "P", label: "Projection: engine forecast, not a fact", cls: "text-rec border-rec border-dashed" },
  user_assumption: { letter: "A", label: "Assumption: editable", cls: "text-assume border-assume bg-assume-wash" },
  model_hypothesis: { letter: "?", label: "Hypothesis: pattern worth checking, not verified", cls: "text-hyp border-hyp" },
  synthetic_extension: { letter: "S", label: "Synthetic data extension", cls: "text-hyp border-hyp" },
};

export function ProvTag({ kind, title }: { kind: Prov; title?: string }) {
  const t = TAG[kind];
  return (
    <span title={title ?? t.label} aria-label={t.label} className={`inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-[3px] border px-[3px] align-middle text-[9px] font-bold leading-none ${t.cls}`}>
      {t.letter}
    </span>
  );
}

export function fmtValue(value: number, unit: Figure["unit"]): string {
  switch (unit) {
    case "usd":
      return usd(value);
    case "pct":
      return pct(value, 1);
    case "days":
      return `${value} days`;
    case "weeks":
      return `${value} wk`;
    default:
      return String(Math.round(value * 100) / 100);
  }
}

function provTitle(f: Figure): string {
  const p = f.provenance;
  if (p.kind === "historical") return `Historical · ${p.sourceCount} source record${p.sourceCount === 1 ? "" : "s"}${p.note ? ` · ${p.note}` : ""}`;
  if (p.kind === "calculated") return `Calculated from: ${p.inputs.join("; ")}`;
  return `${TAG[p.kind].label}${"note" in p && p.note ? ` · ${p.note}` : ""}`;
}

export function Num({ figure, className = "", projection = false }: { figure: Figure; className?: string; projection?: boolean }) {
  const kind: Prov = projection ? "projection" : figure.provenance.kind;
  return (
    <span className={`tnum inline-flex items-center gap-1 ${className}`}>
      <span className={kind === "projection" ? "underline decoration-dashed decoration-1 underline-offset-4" : kind === "user_assumption" ? "underline decoration-dotted underline-offset-4" : ""}>{fmtValue(figure.value, figure.unit)}</span>
      <ProvTag kind={kind} title={provTitle(figure)} />
    </span>
  );
}

/** Plain projected money value with a P tag. */
export function Proj({ cents, sign = false, className = "" }: { cents: number; sign?: boolean; className?: string }) {
  return (
    <span className={`tnum inline-flex items-center gap-1 ${className}`}>
      <span className={cents < 0 ? "text-critical" : ""}>{usd(cents, { sign })}</span>
    </span>
  );
}
