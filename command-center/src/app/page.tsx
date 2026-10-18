"use client";
import { useEffect, useState } from "react";
import type { CompanySummary } from "@/lib/data/types";
import type { StageEvent } from "@/lib/observability";
import type { PipelineResult } from "@/lib/pipeline/types";
import { DEMO_COMPANY_ID, HERO_QUESTION } from "@/lib/demo";

export default function Home() {
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [companyId, setCompanyId] = useState(DEMO_COMPANY_ID);
  const [q, setQ] = useState(HERO_QUESTION);
  const [stages, setStages] = useState<StageEvent[]>([]);
  const [result, setResult] = useState<PipelineResult | null>(null);
  useEffect(() => {
    fetch("/api/companies").then((r) => r.json()).then(setCompanies);
  }, []);
  async function run() {
    setStages([]);
    setResult(null);
    const res = await fetch("/api/plan", { method: "POST", body: JSON.stringify({ request: q, companyId }) });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) {
        const m = JSON.parse(l);
        if (m.type === "stage") setStages((s) => [...s, m]);
        if (m.type === "result") setResult(m.result);
      }
    }
  }
  return (
    <main className="p-8 max-w-4xl mx-auto space-y-4 font-sans">
      <h1 className="text-2xl font-semibold">QuickBooks Command Center</h1>
      <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="border p-2">
        {companies.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <textarea value={q} onChange={(e) => setQ(e.target.value)} className="w-full border p-2 h-24" />
      <button onClick={run} className="bg-black text-white px-4 py-2">Run</button>
      <ul className="text-sm">{stages.filter((s) => s.status !== "start").map((s, i) => <li key={i}>{s.label}: {s.ms?.toFixed(0)} ms {s.detail}</li>)}</ul>
      {result?.kind === "plan" && <p className="text-lg">{result.bottomLine.text}</p>}
      {result && <pre className="text-xs overflow-auto max-h-[60vh] bg-gray-100 p-2">{JSON.stringify(result, null, 2).slice(0, 20000)}</pre>}
    </main>
  );
}
