"use client";
import { useMemo, useRef, useState } from "react";
import { dayToDate } from "@/lib/data/types";
import { usd } from "@/lib/engine/format";
import type { Projection } from "@/lib/engine/model";
import type { Assumption, AssumptionId } from "@/lib/pipeline/assumptions";
import { specFromAssumptions, withValue } from "@/lib/pipeline/assumptions";
import { simulationHeadline } from "@/lib/pipeline/headline";
import { simulate } from "@/lib/pipeline/simulate";
import type { PlanResult } from "@/lib/pipeline/types";
import { CashChart, CounterfactualChart, DelaySweep, SERIES_COLOR, StressGrid } from "./charts";
import { Num, ProvTag } from "./Num";

const CAP_LABEL: Record<string, string> = {
  flight_simulator: "Flight Simulator",
  money_detective: "Money Detective",
  autopilot: "Autopilot",
  profit_leak_radar: "Profit Leak Radar",
  future_accountant: "Future Accountant",
  time_machine: "Time Machine",
  negotiation_coach: "Negotiation Coach",
  chaos_simulator: "Chaos Simulator",
};

function Section({ n, title, aside, children, id }: { n?: string; title: string; aside?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="border-t border-rule pt-5">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="flex items-baseline gap-2 text-[15px] font-semibold tracking-tight">
          {n && <span className="tnum text-xs font-medium text-muted">{n}</span>}
          {title}
        </h2>
        {aside && <div className="text-xs text-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function SourceChip({ id, label, onOpen }: { id: string; label?: string; onOpen: (id: string) => void }) {
  return (
    <button onClick={() => onOpen(id)} className="rounded border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2 hover:border-accent hover:text-accent" title={label ?? id}>
      {id}
    </button>
  );
}

export function PlanView({ result, onEvidence }: { result: PlanResult; onEvidence: (id: string) => void }) {
  const sim0 = result.simulation;
  const [assumptions, setAssumptions] = useState<Assumption[]>(sim0?.assumptions ?? []);
  const [edited, setEdited] = useState(false);
  const [stressView, setStressView] = useState(false);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [costShock, setCostShock] = useState(0);
  const cache = useRef(new Map<string, Projection>());

  const live = useMemo(() => {
    if (!sim0) return null;
    return simulate(sim0.inputs, specFromAssumptions(assumptions, sim0.stressRequested), cache.current);
  }, [sim0, assumptions]);

  const overdue = result.findings.find((f) => f.id === "overdue-total")?.amount ?? result.situation.find((s) => s.key === "overdue")?.figure.value ?? null;
  const headline = live && edited ? simulationHeadline(live, assumptions, overdue).parts.join(" ") : result.bottomLine.text;
  const reserve = assumptions.find((a) => a.id === "reserve")?.value ?? 0;
  const delay = assumptions.find((a) => a.id === "stressDelayDays")?.value ?? 0;
  const drafts = result.drafts;

  const update = (id: AssumptionId, v: number) => {
    setAssumptions((a) => withValue(a, id, v));
    setEdited(true);
  };

  let sec = 0;
  const nextN = () => String(++sec).padStart(2, "0");

  return (
    <div className="space-y-7">
      {/* Bottom line */}
      <div className="rounded-lg border border-rule bg-surface p-5 shadow-[0_1px_0_var(--rule)]">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="eyebrow">Bottom line</span>
          <span className="text-[11px] text-muted">
            · {result.company.name} · books as of {result.company.asOfDate}
            {edited ? " · updated live from your edited assumptions" : result.bottomLine.source === "model" ? ` · worded by ${result.provider.model}, every number checked against the engine` : " · deterministic template from engine facts"}
          </span>
        </div>
        <p className="text-[19px] leading-[1.5] tracking-[-0.005em] text-ink">{headline}</p>
        {result.bottomLine.rejected && !edited && <p className="mt-2 text-xs text-muted">Model wording rejected: {result.bottomLine.rejected}</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {result.capabilities.map((c) => (
            <span key={c} title={result.route.reasons[c]} className="rounded-full border border-rule px-2 py-0.5 text-[11px] text-ink-2">{CAP_LABEL[c]}</span>
          ))}
        </div>
      </div>

      {/* Answer (questions) */}
      {result.answer && (
        <Section n={nextN()} title="Answer">
          <p className="mb-3 text-[15px]">{result.answer.headline}</p>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {result.answer.facts.map((f) => (
              <div key={f.key} className="flex items-baseline justify-between gap-3 border-b border-rule py-1.5 text-sm">
                <span className="text-ink-2">{f.label}</span>
                <span className="tnum flex items-center gap-1.5 font-medium">
                  {f.unit === "usd" ? usd(f.value) : f.unit === "pct" ? `${f.value}%` : f.value}
                  <ProvTag kind={f.source.startsWith("calculated") ? "calculated" : "historical"} title={f.source} />
                </span>
              </div>
            ))}
          </div>
          {result.answer.table && (
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="border-b border-rule-strong text-left text-xs text-muted">{result.answer.table.columns.map((c) => <th key={c} className="py-1.5 pr-3 font-medium">{c}</th>)}</tr>
              </thead>
              <tbody>
                {result.answer.table.rows.map((r, i) => (
                  <tr key={i} className="border-b border-rule">{r.map((v, j) => <td key={j} className={`py-1.5 pr-3 ${j ? "tnum" : ""}`}>{v}</td>)}</tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {/* Current situation */}
      {result.mode === "plan" && (
        <Section n={nextN()} title="Current situation" aside={<span className="flex items-center gap-1"><ProvTag kind="historical" /> from the books <ProvTag kind="calculated" /> calculated</span>}>
          <div className={`grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule ${result.situation.length % 3 === 0 ? "md:grid-cols-3" : "md:grid-cols-4"}`}>
            {result.situation.map((s) => (
              <div key={s.key} className="bg-surface p-3">
                <div className="text-[11px] text-muted">{s.label}</div>
                <Num figure={s.figure} className="mt-1 text-[17px] font-semibold" />
                {s.hint && <div className="mt-0.5 text-[11px] text-ink-2">{s.hint}</div>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Findings */}
      {(result.findings.length > 0 || result.leaks.length > 0) && (
        <Section n={nextN()} title="Key findings" aside={<span className="flex items-center gap-1"><span className="rounded bg-surface-2 px-1">Verified</span> read from records · <span className="rounded px-1 text-hyp">Hypothesis</span> pattern to check</span>}>
          <div className="divide-y divide-rule rounded-lg border border-rule bg-surface">
            {result.findings.map((f) => (
              <details key={f.id} className="group px-4 py-3">
                <summary className="flex items-start gap-3">
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${f.severity === "high" ? "bg-[var(--critical)]" : f.severity === "medium" ? "bg-[var(--warning)]" : "bg-rule-strong"}`} aria-label={`${f.severity} severity`} />
                  <span className="flex-1">
                    <span className="font-medium">{f.title}</span>
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${f.status === "verified" ? "bg-surface-2 text-ink-2" : "border border-hyp text-hyp"}`}>{f.status}</span>
                    <span className="mt-0.5 block text-sm text-ink-2">{f.detail}</span>
                  </span>
                  <span className="text-xs text-accent group-open:hidden">Evidence ({f.sources.length})</span>
                  <span className="hidden text-xs text-accent group-open:inline">Hide</span>
                </summary>
                <EvidenceList sources={f.sources} onOpen={onEvidence} openingDate={result.company.openingDate} />
              </details>
            ))}
            {result.leaks.slice(0, 4).map((l) => (
              <details key={l.id} className="group px-4 py-3">
                <summary className="flex items-start gap-3">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--serious)]" aria-hidden />
                  <span className="flex-1">
                    <span className="font-medium">{l.title}</span>
                    <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-2">profit leak · {l.status}</span>
                    <span className="mt-0.5 block text-sm text-ink-2">{l.detail}</span>
                    <span className="mt-1 block text-xs text-muted">
                      Est. impact <span className="tnum font-medium text-ink">{usd(l.annualImpact)}/yr</span> <ProvTag kind="calculated" title="Estimated from the trend; not a booked amount" /> · feasibility {Math.round(l.feasibility * 100)}% · confidence {Math.round(l.confidence * 100)}%
                    </span>
                  </span>
                  <span className="text-xs text-accent group-open:hidden">Evidence ({l.sources.length})</span>
                </summary>
                <EvidenceList sources={l.sources} onOpen={onEvidence} openingDate={result.company.openingDate} />
              </details>
            ))}
          </div>
        </Section>
      )}

      {/* Actions */}
      {result.actions.length > 0 && (
        <Section n={nextN()} title="Recommended actions" aside="Ranked by impact × urgency × confidence · prepared, never executed">
          <ol className="space-y-2">
            {result.actions.slice(0, 8).map((a, i) => (
              <li key={a.id} className="flex gap-3 rounded-lg border border-rule bg-surface px-4 py-3">
                <span className="tnum mt-0.5 text-xs font-semibold text-muted">{i + 1}</span>
                <div className="flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{a.title}</span>
                    <span className={`rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide ${a.urgency === "now" ? "bg-[color-mix(in_oklab,var(--critical)_14%,transparent)] text-critical" : "bg-surface-2 text-ink-2"}`}>{a.urgency}</span>
                  </div>
                  <div className="text-sm text-ink-2">{a.detail}</div>
                  {a.sources.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {a.sources.slice(0, 6).map((s) => <SourceChip key={s} id={s} onOpen={onEvidence} />)}
                      {a.sources.length > 6 && <span className="text-[11px] text-muted">+{a.sources.length - 6} more</span>}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* Scenarios */}
      {sim0 && live && (
        <Section
          n={nextN()}
          title="Scenario comparison"
          aside={
            <span className="inline-flex rounded-md border border-rule p-0.5">
              <button onClick={() => setStressView(false)} className={`rounded px-2 py-0.5 ${!stressView ? "bg-accent-wash text-accent" : ""}`}>Base case</button>
              <button onClick={() => setStressView(true)} className={`rounded px-2 py-0.5 ${stressView ? "bg-accent-wash text-accent" : ""}`}>Payments +{delay} days</button>
            </span>
          }
        >
          <div className="rounded-lg border border-rule bg-surface p-4">
            <CashChart
              openingDate={sim0.inputs.openingDate}
              asOfDay={sim0.inputs.asOfDay}
              openingCash={sim0.inputs.openingCash}
              history={sim0.inputs.history}
              scenarios={live.scenarios}
              projections={stressView ? live.stressedProjections : live.projections}
              reserve={reserve}
            />
          </div>
          <ScenarioTable result={result} live={live} reserve={reserve} delay={delay} />
          {live.search && (
            <p className="mt-2 text-xs text-muted">
              The recommended plan was chosen from {live.search.candidatesEvaluated} deterministic variants (hire timing, draw timing and size, marketing start, supplier terms); {live.search.feasibleCount} were feasible. Feasible = cash stays at or above the reserve in the base case and above zero with payments {delay} days late. It delivers the most of what you asked among those.
            </p>
          )}
        </Section>
      )}

      {/* Stress */}
      {live?.stress && sim0 && (
        <Section n={nextN()} title="Stress test" aside="Deterministic shocks; no probabilities">
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-lg border border-rule bg-surface p-4">
              <div className="mb-1 text-sm font-medium">Lowest cash point as payments slip</div>
              <DelaySweep sweep={live.stress.delaySweep} scenarios={live.scenarios} reserve={reserve} />
            </div>
            <div className="rounded-lg border border-rule bg-surface p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">{live.scenarios.find((s) => s.role === "recommended")?.name ?? "Current plan"}: combined shocks</span>
                <select value={costShock} onChange={(e) => setCostShock(Number(e.target.value))} className="rounded border border-rule bg-surface px-1 py-0.5 text-xs">
                  {[0, 0.1, 0.2].map((c) => <option key={c} value={c}>{c ? `costs +${c * 100}%` : "costs unchanged"}</option>)}
                </select>
              </div>
              <div className="overflow-x-auto"><StressGrid cells={live.stress.grid} costShock={costShock} /></div>
              <p className="mt-2 text-[11px] text-muted">✓ holds above reserve · ! dips below reserve · ✕ runs out of cash. Values are the lowest weekly cash.</p>
            </div>
          </div>
          <BreakingPoints bp={live.stress.breakingPoints} />
        </Section>
      )}

      {/* Assumptions */}
      {sim0 && live && (
        <Section n={nextN()} title="Assumptions and uncertainty" aside={edited ? `Recomputed ${live.recomputed.length} of ${live.scenarios.length * 2} scenario projections + plan search in ${live.computeMs.toFixed(1)} ms · no model call` : "Edit any value: everything above updates instantly, in your browser"}>
          <div className="grid gap-px overflow-hidden rounded-lg border border-rule bg-rule md:grid-cols-2">
            {assumptions.map((a) => (
              <AssumptionRow key={a.id} a={a} onChange={(v) => update(a.id, v)} />
            ))}
          </div>
          {edited && (
            <button onClick={() => { setAssumptions(sim0.assumptions); setEdited(false); }} className="mt-2 text-xs text-accent hover:underline">Reset to original assumptions</button>
          )}
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-ink-2">
            <li>New sales follow the trailing 13-week run-rate and collect along this company&apos;s own payment curve; open invoices use each customer&apos;s median lateness.</li>
            <li>Invoices more than 90 days past due are not counted as cash unless recovered by chasing.</li>
            <li>Payroll is gross (the dataset has no payroll taxes). Owner draws are cash, not expense: they lower cash, not profit.</li>
            <li>One year of history: no seasonality is modeled.</li>
          </ul>
        </Section>
      )}

      {/* Negotiation */}
      {result.negotiation && (
        <Section n={nextN()} title="Negotiation options" aside="Every counterparty behaviour is an assumption">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule-strong text-left text-xs text-muted">
                <th className="py-1.5 font-medium">Option</th>
                <th className="py-1.5 text-right font-medium">Low-point cash</th>
                <th className="py-1.5 text-right font-medium">Ending cash</th>
                <th className="py-1.5 text-right font-medium">Operating profit</th>
              </tr>
            </thead>
            <tbody>
              {result.negotiation.map((o) => (
                <tr key={o.id} className="border-b border-rule align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{o.title}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-assume"><ProvTag kind="user_assumption" />{o.behaviorAssumption}</div>
                  </td>
                  <td className="tnum py-2 text-right">{usd(o.minCashDelta, { sign: true })}</td>
                  <td className="tnum py-2 text-right">{usd(o.endingCashDelta, { sign: true })}</td>
                  <td className="tnum py-2 text-right">{usd(o.operatingProfitDelta, { sign: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted">Changes vs today&apos;s plan over the next 13 weeks.</p>
        </Section>
      )}

      {/* Time machine */}
      {result.counterfactual && (
        <Section n={nextN()} title={`Time machine: if ${result.counterfactual.customerName} had paid on time`}>
          <div className="mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule md:grid-cols-4">
            <div className="bg-surface p-3"><div className="text-[11px] text-muted">Actual lowest cash</div><div className="tnum mt-1 flex items-center gap-1 text-[17px] font-semibold">{usd(result.counterfactual.historicalMin.cash)} <ProvTag kind="historical" /></div><div className="text-[11px] text-ink-2">{dayToDate(result.company.openingDate, result.counterfactual.historicalMin.day)}</div></div>
            <div className="bg-surface p-3"><div className="text-[11px] text-muted">Estimated lowest cash</div><div className="tnum mt-1 flex items-center gap-1 text-[17px] font-semibold text-rec">{usd(result.counterfactual.counterfactualMin.cash)} <ProvTag kind="model_hypothesis" title="Counterfactual estimate: replays the bank feed with late payments moved to their due dates" /></div></div>
            <div className="bg-surface p-3"><div className="text-[11px] text-muted">Late payments moved</div><div className="tnum mt-1 text-[17px] font-semibold">{result.counterfactual.paymentsMoved}</div></div>
            <div className="bg-surface p-3"><div className="text-[11px] text-muted">Avg days earlier</div><div className="tnum mt-1 text-[17px] font-semibold">{result.counterfactual.avgDaysEarlier.toFixed(1)}</div></div>
          </div>
          <div className="rounded-lg border border-rule bg-surface p-4"><CounterfactualChart weekly={result.counterfactual.weekly} openingDate={result.company.openingDate} /></div>
          <p className="mt-2 text-xs text-muted">The solid line is the actual bank balance. The dashed line is an estimate: it moves every late payment to its due date and changes nothing else (no second-order effects).</p>
        </Section>
      )}

      {/* Next steps */}
      {drafts.length > 0 && (
        <Section n={nextN()} title="Next steps: prepared drafts" aside="Approving only marks a draft approved. Nothing is sent.">
          <div className="space-y-2">
            {drafts.map((d) => (
              <details key={d.id} className="rounded-lg border border-rule bg-surface">
                <summary className="flex items-center gap-3 px-4 py-3">
                  <span className="flex-1">
                    <span className="font-medium">Reminder to {d.toName}</span>
                    <span className="tnum ml-2 text-sm text-ink-2">{usd(d.amount)} · {d.invoiceIds.length} invoice{d.invoiceIds.length === 1 ? "" : "s"}</span>
                  </span>
                  {approved.has(d.id) ? (
                    <span className="rounded bg-[color-mix(in_oklab,var(--good)_14%,transparent)] px-2 py-0.5 text-xs font-semibold text-good">✓ Approved (not sent)</span>
                  ) : (
                    <span className="text-xs text-accent">Review</span>
                  )}
                </summary>
                <div className="border-t border-rule px-4 py-3">
                  <div className="mb-2 text-xs text-muted">To: {d.to} · Subject: {d.subject}</div>
                  <pre className="whitespace-pre-wrap font-sans text-sm text-ink-2">{d.body}</pre>
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      disabled={approved.has(d.id)}
                      onClick={() => setApproved((s) => new Set(s).add(d.id))}
                      className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-50"
                    >
                      {approved.has(d.id) ? "Approved" : "Approve draft"}
                    </button>
                    <span className="text-xs text-muted">Command Center never sends email or pays bills. Copy it into your mail client when ready.</span>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </Section>
      )}

      <Trace result={result} />
    </div>
  );
}

function EvidenceList({ sources, onOpen, openingDate }: { sources: { id: string; label: string; amount?: number; date?: string }[]; onOpen: (id: string) => void; openingDate: string }) {
  void openingDate;
  return (
    <table className="mt-3 w-full text-xs">
      <tbody>
        {sources.slice(0, 15).map((s, i) => (
          <tr key={`${s.id}-${i}`} className="border-t border-rule">
            <td className="py-1.5 pr-2"><SourceChip id={s.id} label={s.label} onOpen={onOpen} /></td>
            <td className="py-1.5 pr-2 text-ink-2">{s.label}</td>
            <td className="py-1.5 pr-2 text-muted">{s.date ?? ""}</td>
            <td className="tnum py-1.5 text-right">{s.amount !== undefined ? usd(s.amount) : ""}</td>
          </tr>
        ))}
        {sources.length > 15 && (
          <tr><td colSpan={4} className="pt-1.5 text-muted">+{sources.length - 15} more records</td></tr>
        )}
      </tbody>
    </table>
  );
}

function ScenarioTable({ result, live, reserve, delay }: { result: PlanResult; live: NonNullable<PlanResult["simulation"]>["result"]; reserve: number; delay: number }) {
  void result;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[620px] text-sm">
        <thead>
          <tr className="border-b border-rule-strong text-left text-xs text-muted">
            <th className="py-1.5 font-medium">Scenario</th>
            <th className="py-1.5 text-right font-medium">Ending cash</th>
            <th className="py-1.5 text-right font-medium">Lowest cash</th>
            <th className="py-1.5 text-right font-medium">Weeks below {usd(reserve, { compact: true })}</th>
            <th className="py-1.5 text-right font-medium">Lowest, +{delay}d late</th>
            <th className="py-1.5 text-right font-medium">Op. margin</th>
            <th className="py-1.5 pl-3 font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {live.scenarios.map((sc) => {
            const p = live.projections[sc.id].summary;
            const s = live.stressedProjections[sc.id].summary;
            const ok = live.feasible[sc.id];
            return (
              <tr key={sc.id} className="border-b border-rule align-top">
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2 font-medium"><i className="inline-block h-0.5 w-4" style={{ background: SERIES_COLOR[sc.role] }} />{sc.name}</div>
                  {sc.description && <div className="mt-0.5 max-w-[340px] text-xs text-ink-2">{sc.description}</div>}
                </td>
                <td className="tnum py-2 text-right">{usd(p.endingCash)}</td>
                <td className={`tnum py-2 text-right ${p.minCash < reserve ? "text-critical" : ""}`}>{usd(p.minCash)}</td>
                <td className="tnum py-2 text-right">{p.weeksBelowReserve}</td>
                <td className={`tnum py-2 text-right ${s.minCash < 0 ? "font-semibold text-critical" : ""}`}>{usd(s.minCash)}</td>
                <td className="tnum py-2 text-right">{p.margin === null ? "—" : `${(p.margin * 100).toFixed(1)}%`}</td>
                <td className="py-2 pl-3 text-xs">
                  {ok ? <span className="font-semibold text-good">✓ Safe</span> : s.minCash < 0 ? <span className="font-semibold text-critical">✕ Runs out if late</span> : <span className="font-semibold text-ink-2">! Below reserve</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted"><ProvTag kind="projection" /> All values in this table are engine projections over the next {live.projections[live.scenarios[0].id].weeks.length} weeks.</p>
    </div>
  );
}

function BreakingPoints({ bp }: { bp: NonNullable<NonNullable<PlanResult["simulation"]>["result"]["stress"]>["breakingPoints"] }) {
  const label = { salesDecline: "Sales drop", paymentDelayDays: "Customers pay late", costShock: "Supplier & overhead costs rise" };
  const fmt = (axis: string, v: number) => (axis === "paymentDelayDays" ? `${v} days` : `${Math.round(v * 100)}%`);
  return (
    <div className="mt-3 grid gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-3">
      {bp.map((b) => (
        <div key={b.axis} className="bg-surface p-3 text-sm">
          <div className="text-[11px] text-muted">{label[b.axis]} (alone)</div>
          <div className="mt-1">
            Below reserve at <strong className="tnum">{b.breaksReserveAt === null ? `> ${fmt(b.axis, b.maxTested)}` : fmt(b.axis, b.breaksReserveAt)}</strong>
          </div>
          <div className="text-ink-2">
            Out of cash at <strong className="tnum">{b.breaksZeroAt === null ? `> ${fmt(b.axis, b.maxTested)}` : fmt(b.axis, b.breaksZeroAt)}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}

function AssumptionRow({ a, onChange }: { a: Assumption; onChange: (v: number) => void }) {
  const display = a.unit === "usd" ? Math.round(a.value / 100) : a.unit === "pct" ? Math.round(a.value * 1000) / 10 : a.value;
  const toValue = (n: number) => (a.unit === "usd" ? Math.round(n * 100) : a.unit === "pct" ? n / 100 : n);
  const suffix = a.unit === "pct" ? "%" : a.unit === "days" ? "days" : a.unit === "weeks" ? "weeks" : "";
  return (
    <label className="flex flex-col gap-1 bg-surface p-3">
      <span className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-ink">{a.label}</span>
        <span className={`rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide ${a.source === "you" ? "bg-accent-wash text-accent" : a.source === "history" ? "bg-surface-2 text-ink-2" : "bg-assume-wash text-assume"}`}>{a.source === "you" ? "you" : a.source === "history" ? "from history" : "assumed"}</span>
      </span>
      <span className="flex items-center gap-2">
        {a.unit === "usd" && <span className="text-sm text-muted">$</span>}
        <input
          type="number"
          value={display}
          step={a.unit === "usd" ? a.step / 100 : a.unit === "pct" ? a.step * 100 : a.step}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(toValue(n));
          }}
          className="tnum w-32 rounded border border-rule bg-surface-2 px-2 py-1 text-sm underline decoration-dotted underline-offset-4 focus:border-accent focus:outline-none"
        />
        {suffix && <span className="text-xs text-muted">{suffix}</span>}
        <input type="range" min={a.unit === "usd" ? a.min / 100 : a.unit === "pct" ? a.min * 100 : a.min} max={a.unit === "usd" ? a.max / 100 : a.unit === "pct" ? a.max * 100 : a.max} step={a.unit === "usd" ? a.step / 100 : a.unit === "pct" ? a.step * 100 : a.step} value={display} onChange={(e) => onChange(toValue(Number(e.target.value)))} className="min-w-0 flex-1" aria-label={a.label} />
      </span>
      <span className="text-[11px] text-ink-2">{a.note}</span>
    </label>
  );
}

function Trace({ result }: { result: PlanResult }) {
  const total = result.totalMs;
  return (
    <details className="border-t border-rule pt-4 text-xs text-ink-2">
      <summary className="text-muted hover:text-ink">
        How this was produced · {result.provider.name}{result.provider.model ? ` (${result.provider.model})` : ""} · {Math.round(total)} ms · {result.usage.calls} model call{result.usage.calls === 1 ? "" : "s"} · {result.validation.filter((v) => v.ok).length}/{result.validation.length} checks passed
      </summary>
      <div className="mt-3 grid gap-4 break-words md:grid-cols-2">
        <div className="min-w-0">
          <div className="eyebrow mb-1">Validation</div>
          <ul className="space-y-1">{result.validation.map((v) => <li key={v.name}><span className={v.ok ? "text-good" : "text-critical"}>{v.ok ? "✓" : "✕"}</span> {v.name} <span className="text-muted">· {v.detail}</span></li>)}</ul>
          <div className="eyebrow mb-1 mt-3">Routing</div>
          <ul className="space-y-1">{result.capabilities.map((c) => <li key={c}><strong>{CAP_LABEL[c]}</strong>: {result.route.reasons[c]}</li>)}</ul>
          {result.provider.notes.map((n) => <p key={n} className="mt-2 text-muted">{n}</p>)}
        </div>
        <div className="min-w-0">
          <div className="eyebrow mb-1">Stage timings</div>
          <ul className="tnum space-y-0.5">{Object.entries(result.timings).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span>{v.toFixed(1)} ms</span></li>)}</ul>
          <div className="eyebrow mb-1 mt-3">Structured task</div>
          <pre className="max-h-48 overflow-auto rounded bg-surface-2 p-2 font-mono text-[10px]">{JSON.stringify(result.task, null, 1)}</pre>
        </div>
      </div>
    </details>
  );
}
