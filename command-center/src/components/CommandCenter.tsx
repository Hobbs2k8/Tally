"use client";
import { useEffect, useMemo, useState } from "react";
import type { CompanySummary } from "@/lib/data/types";
import { DEMO_COMPANY_ID, EXAMPLE_QUESTIONS } from "@/lib/demo";
import type { EvidenceRecord } from "@/lib/evidence";
import { usd } from "@/lib/engine/format";
import type { StageEvent } from "@/lib/observability";
import type { PipelineResult } from "@/lib/pipeline/types";
import { PlanView } from "./PlanView";

const STAGE_ORDER = [
  { key: "intent", label: "Understanding" },
  { key: "match", label: "Matching company" },
  { key: "retrieve", label: "Pulling records" },
  { key: "route", label: "Choosing capabilities" },
  { key: "investigate", label: "Investigating" },
  { key: "leaks", label: "Scanning for profit leaks" },
  { key: "answer", label: "Answering from the books" },
  { key: "simulate", label: "Simulating" },
  { key: "time_machine", label: "Replaying history" },
  { key: "negotiate", label: "Comparing terms" },
  { key: "validate", label: "Verifying" },
  { key: "rank", label: "Ranking actions" },
  { key: "explain", label: "Writing the plan" },
];

type StageState = { status: StageEvent["status"]; ms?: number; detail?: string; label: string };

export function CommandCenter({ providerLabel }: { providerLabel: string }) {
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [companyId, setCompanyId] = useState<string>(DEMO_COMPANY_ID);
  const [q, setQ] = useState("");
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<{ id: string; rec: EvidenceRecord | null; loading: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/companies").then((r) => r.json()).then(setCompanies).catch(() => setError("Could not load companies"));
    fetch("/api/plan").catch(() => {}); // warm the engine while the user reads the page
  }, []);

  const company = useMemo(() => companies.find((c) => c.id === companyId), [companies, companyId]);

  async function run(question: string, cid: string | null = companyId) {
    if (!question.trim() || running) return;
    setQ(question);
    setRunning(true);
    setStages({});
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: question, companyId: cid || null }) });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.type === "stage") {
            const key = m.stage === "match_rank" ? "match" : m.stage;
            setStages((s) => ({ ...s, [key]: { status: m.status, ms: m.ms, detail: m.detail, label: m.label } }));
          } else if (m.type === "result") setResult(m.result);
          else if (m.type === "error") setError(m.message);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setRunning(false);
    }
  }

  async function openEvidence(id: string) {
    const cid = result?.kind === "plan" ? result.company.id : companyId;
    setEvidence({ id, rec: null, loading: true });
    const r = await fetch(`/api/evidence?company=${encodeURIComponent(cid)}&id=${encodeURIComponent(id)}`);
    setEvidence({ id, rec: r.ok ? await r.json() : null, loading: false });
  }

  const visibleStages = STAGE_ORDER.filter((s) => stages[s.key]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-rule bg-[color-mix(in_oklab,var(--page)_88%,transparent)] backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-4 py-2.5 md:px-6">
          <div className="flex items-center gap-2.5">
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
              <rect x="1" y="1" width="20" height="20" rx="5" fill="var(--ink)" />
              <path d="M5 15 L9 10 L12 12.5 L17 6" stroke="var(--page)" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 17.5 H17" stroke="var(--page)" strokeWidth="1" strokeDasharray="1.5 1.5" />
            </svg>
            <div className="leading-tight">
              <div className="text-[14px] font-semibold tracking-tight">Command Center</div>
              <div className="hidden text-[10.5px] text-muted sm:block">Evidence-backed plans from your QuickBooks data</div>
            </div>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <label className="hidden text-xs text-muted sm:block" htmlFor="company">Company</label>
            <select id="company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-[46vw] max-w-[260px] min-w-0 rounded-md border border-rule bg-surface px-2 py-1.5 text-sm">
              <option value="">Detect from my question</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.industry}</option>
              ))}
            </select>
            <span className="hidden rounded-full border border-rule px-2 py-0.5 text-[11px] text-ink-2 md:inline" title="Reasoning provider for intent, matching and wording. All numbers come from the deterministic engine.">{providerLabel}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 py-6 md:px-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-[68px] lg:self-start">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(q);
            }}
            className="rounded-lg border border-rule bg-surface p-3"
          >
            <label htmlFor="q" className="eyebrow">Describe a decision or ask a question</label>
            <textarea
              id="q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(q);
              }}
              rows={5}
              placeholder="e.g. Can I hire two people and still take a draw this quarter?"
              className="mt-2 w-full resize-none rounded-md border border-rule bg-surface-2 p-2.5 text-sm leading-relaxed focus:border-accent focus:outline-none"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-muted">⌘↵ to run</span>
              <button type="submit" disabled={running || !q.trim()} className="rounded-md bg-ink px-3.5 py-1.5 text-sm font-medium text-page disabled:opacity-40">
                {running ? "Working…" : "Build plan"}
              </button>
            </div>
          </form>

          <div className="mt-3 space-y-1.5">
            <div className="eyebrow px-1">Try</div>
            {EXAMPLE_QUESTIONS.map((ex) => (
              <button key={ex} onClick={() => run(ex)} disabled={running} className="block w-full rounded-md border border-transparent px-2 py-1.5 text-left text-[13px] leading-snug text-ink-2 hover:border-rule hover:bg-surface disabled:opacity-50">
                {ex.length > 120 ? ex.slice(0, 117) + "…" : ex}
              </button>
            ))}
          </div>

          {company && (
            <div className="mt-4 rounded-lg border border-rule bg-surface p-3 text-xs">
              <div className="font-medium text-ink">{company.name}</div>
              <div className="text-muted">{company.industry} · {company.profile} · {company.employees} staff</div>
              <div className="tnum mt-2 grid grid-cols-2 gap-y-1 text-ink-2">
                <span>Cash</span><span className="text-right">{usd(company.cash)}</span>
                <span>Revenue (yr)</span><span className="text-right">{usd(company.revenue)}</span>
                <span>Profit (yr)</span><span className="text-right">{usd(company.profit)}</span>
                <span>Receivables</span><span className="text-right">{usd(company.receivables)}</span>
              </div>
            </div>
          )}

          {(running || visibleStages.length > 0) && (
            <div className="mt-4 rounded-lg border border-rule bg-surface p-3" aria-live="polite">
              <div className="eyebrow mb-2">Pipeline</div>
              <ol className="space-y-1">
                {visibleStages.map((s) => {
                  const st = stages[s.key];
                  return (
                    <li key={s.key} className="flex items-center gap-2 text-[13px]">
                      <span className={`h-1.5 w-1.5 rounded-full ${st.status === "start" ? "pulse bg-accent" : st.status === "error" ? "bg-[var(--critical)]" : "bg-good"}`} />
                      <span className={st.status === "start" ? "text-ink" : "text-ink-2"}>{st.label}</span>
                      <span className="tnum ml-auto text-[11px] text-muted">{st.ms !== undefined ? `${st.ms < 10 ? st.ms.toFixed(1) : Math.round(st.ms)} ms` : ""}</span>
                    </li>
                  );
                })}
              </ol>
              {result?.kind === "plan" && <div className="tnum mt-2 border-t border-rule pt-2 text-[11px] text-muted">Total {Math.round(result.totalMs)} ms · intent cache {result.cache.intent} · context cache {result.cache.context}</div>}
            </div>
          )}
        </aside>

        <main className="min-w-0">
          {error && <div className="mb-4 rounded-lg border border-[var(--critical)] bg-surface p-3 text-sm text-critical">{error}</div>}
          {!result && !running && <EmptyState onPick={(ex) => run(ex)} />}
          {running && !result && <div className="rounded-lg border border-dashed border-rule p-10 text-center text-sm text-muted">Working through the books…</div>}
          {result?.kind === "clarify" && (
            <div className="rounded-lg border border-rule bg-surface p-5">
              <p className="font-medium">{result.question}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {result.candidates.map((c) => (
                  <button key={c.id} onClick={() => { setCompanyId(c.id); run(result.request, c.id); }} className="rounded-md border border-rule px-3 py-1.5 text-sm hover:border-accent">
                    {c.name} <span className="text-muted">· {c.industry}</span>
                  </button>
                ))}
                {!result.candidates.length && <span className="text-sm text-ink-2">Choose a company in the selector at the top, then run again.</span>}
              </div>
            </div>
          )}
          {result?.kind === "plan" && <PlanView key={result.requestId} result={result} onEvidence={openEvidence} />}
        </main>
      </div>

      {evidence && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/20" onClick={() => setEvidence(null)}>
          <div role="dialog" aria-label="Source record" className="h-full w-full max-w-md overflow-y-auto border-l border-rule bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="eyebrow">{evidence.rec?.type ?? "Source record"}</div>
                <div className="mt-1 font-semibold">{evidence.rec?.title ?? evidence.id}</div>
              </div>
              <button onClick={() => setEvidence(null)} className="text-sm text-muted hover:text-ink" aria-label="Close">✕</button>
            </div>
            {evidence.loading && <p className="text-sm text-muted">Loading…</p>}
            {!evidence.loading && !evidence.rec && <p className="text-sm text-muted">No record found for {evidence.id}.</p>}
            {evidence.rec && (
              <>
                <dl className="divide-y divide-rule rounded-md border border-rule text-sm">
                  {evidence.rec.fields.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-4 px-3 py-2"><dt className="text-ink-2">{k}</dt><dd className="tnum text-right font-medium">{v}</dd></div>
                  ))}
                </dl>
                {evidence.rec.related.length > 0 && (
                  <div className="mt-4">
                    <div className="eyebrow mb-1.5">Linked records</div>
                    <ul className="space-y-1">
                      {evidence.rec.related.map((r) => (
                        <li key={r.id + r.label}><button onClick={() => openEvidence(r.id)} className="text-left text-sm text-accent hover:underline">{r.label}</button></li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="mt-4 font-mono text-[11px] text-muted">{evidence.rec.id} · historical record, read from the books</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="ledger-rule rounded-lg border border-rule bg-surface px-8 py-12">
      <div className="max-w-xl">
        <div className="eyebrow">Turn your business finances into a clear, evidence-backed action plan</div>
        <h1 className="mt-3 text-[26px] font-semibold leading-tight tracking-tight">Describe a decision. Get one plan, with the receipts.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Command Center reads the company&apos;s books, decides which checks your question needs (projection, investigation, stress test, profit leaks, history replay), runs them on a deterministic engine and verifies every number before it reaches you.
        </p>
        <button onClick={() => onPick(EXAMPLE_QUESTIONS[0])} className="mt-6 rounded-md bg-ink px-4 py-2 text-sm font-medium text-page">Run the demo: hiring, marketing and a draw →</button>
        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-2">
          <span><b className="font-semibold">H</b> historical record</span>
          <span><b className="font-semibold">C</b> calculated</span>
          <span><b className="font-semibold text-rec">P</b> projection</span>
          <span><b className="font-semibold text-assume">A</b> your assumption</span>
          <span><b className="font-semibold text-hyp">?</b> hypothesis</span>
        </div>
      </div>
    </div>
  );
}
