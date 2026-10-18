"use client";
// Hand-built SVG charts. Historical = solid ink; projections = dashed series
// colors; reserve = labeled hairline. Crosshair tooltip on hover, table view below.
import { useMemo, useRef, useState } from "react";
import { dayToDate } from "@/lib/data/types";
import { usd } from "@/lib/engine/format";
import type { Projection, Scenario } from "@/lib/engine/model";
import type { StressCell } from "@/lib/engine/stress";

export const SERIES_COLOR: Record<string, string> = {
  current: "var(--s-cur)",
  proposed: "var(--s-prop)",
  recommended: "var(--s-rec)",
  alternative: "var(--muted)",
};

const shortDate = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function niceTicks(min: number, max: number, n = 5): number[] {
  const span = max - min || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v));
  return out;
}

interface CashChartProps {
  openingDate: string;
  asOfDay: number;
  openingCash: number;
  history: { endDay: number; closing: number }[];
  scenarios: Scenario[];
  projections: Record<string, Projection>;
  reserve: number;
  height?: number;
}

export function CashChart({ openingDate, asOfDay, openingCash, history, scenarios, projections, reserve, height = 300 }: CashChartProps) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 760;
  const H = height;
  const pad = { l: 64, r: 120, t: 16, b: 30 };

  const series = scenarios.map((s) => ({
    s,
    pts: [{ day: asOfDay, v: openingCash }, ...projections[s.id].weeks.map((w) => ({ day: w.endDay, v: w.closing }))],
  }));
  const hist = history.map((h) => ({ day: h.endDay, v: h.closing }));
  const allV = [...hist.map((p) => p.v), ...series.flatMap((x) => x.pts.map((p) => p.v)), reserve, 0];
  const yMin = Math.min(...allV);
  const yMax = Math.max(...allV);
  const ticks = niceTicks(yMin, yMax);
  const lo = Math.min(ticks[0], yMin);
  const hi = Math.max(ticks[ticks.length - 1], yMax);
  const dMin = hist[0]?.day ?? asOfDay;
  const dMax = Math.max(...series.flatMap((x) => x.pts.map((p) => p.day)), asOfDay + 7);
  const x = (d: number) => pad.l + ((d - dMin) / (dMax - dMin)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const path = (pts: { day: number; v: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join("");

  const days = useMemo(() => {
    const set = new Set<number>([...hist.map((p) => p.day), ...series.flatMap((s) => s.pts.map((p) => p.day))]);
    return [...set].sort((a, b) => a - b);
  }, [hist, series]);

  function onMove(e: React.PointerEvent) {
    const svg = ref.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = days[0];
    for (const d of days) if (Math.abs(x(d) - px) < Math.abs(x(best) - px)) best = d;
    setHover(best);
  }

  // Direct labels at line ends, nudged apart to avoid collisions.
  const ends = series.map((x0) => ({ id: x0.s.id, name: x0.s.name, v: x0.pts[x0.pts.length - 1].v, yy: y(x0.pts[x0.pts.length - 1].v) })).sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 26) ends[i].yy = ends[i - 1].yy + 26;

  const hv = hover !== null ? { day: hover, hist: hist.find((p) => p.day === hover), ser: series.map((s) => ({ s: s.s, p: s.pts.find((p) => p.day === hover) })) } : null;

  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label="Cash projection by scenario with reserve line" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth={1} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="tnum" fontSize={11} fill="var(--muted)">{usd(t, { compact: true })}</text>
          </g>
        ))}
        {lo < 0 && <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--rule-strong)" strokeWidth={1.5} />}
        {/* reserve */}
        <line x1={pad.l} x2={W - pad.r} y1={y(reserve)} y2={y(reserve)} stroke="var(--critical)" strokeWidth={1} strokeDasharray="2 3" />
        <text x={pad.l + 4} y={y(reserve) - 5} fontSize={11} fill="var(--critical-text)">Reserve {usd(reserve, { compact: true })}</text>
        {/* today */}
        <line x1={x(asOfDay)} x2={x(asOfDay)} y1={pad.t} y2={H - pad.b} stroke="var(--rule-strong)" strokeWidth={1} />
        <text x={x(asOfDay) - 4} y={H - pad.b + 18} textAnchor="end" fontSize={11} fill="var(--muted)">Today · {shortDate(dayToDate(openingDate, asOfDay))}</text>
        <text x={pad.l} y={H - pad.b + 18} fontSize={11} fill="var(--muted)">{shortDate(dayToDate(openingDate, dMin))}</text>
        <text x={W - pad.r} y={H - pad.b + 18} textAnchor="end" fontSize={11} fill="var(--muted)">{shortDate(dayToDate(openingDate, dMax))}</text>
        <text x={x(asOfDay) - 6} y={pad.t + 10} textAnchor="end" fontSize={10} fill="var(--muted)" className="eyebrow">Actual</text>
        <text x={x(asOfDay) + 6} y={pad.t + 10} fontSize={10} fill="var(--muted)">Projected</text>
        {/* history: solid */}
        <path d={path(hist)} fill="none" stroke="var(--hist)" strokeWidth={2} strokeLinejoin="round" />
        {/* projections: dashed */}
        {series.map(({ s, pts }) => (
          <path key={s.id} d={path(pts)} fill="none" stroke={SERIES_COLOR[s.role]} strokeWidth={s.role === "recommended" ? 2.5 : 2} strokeDasharray="6 4" strokeLinejoin="round" />
        ))}
        {ends.map((e) => (
          <g key={e.id}>
            <circle cx={W - pad.r} cy={y(e.v)} r={4} fill={SERIES_COLOR[scenarios.find((s) => s.id === e.id)!.role]} stroke="var(--surface)" strokeWidth={2} />
            <text x={W - pad.r + 10} y={e.yy + 4} fontSize={11} fill="var(--ink)" className="tnum">
              <tspan fontWeight={600}>{usd(e.v, { compact: true })}</tspan>
              <tspan x={W - pad.r + 10} dy={13} fill="var(--ink-2)">{e.name}</tspan>
            </text>
          </g>
        ))}
        {hv && (
          <g pointerEvents="none">
            <line x1={x(hv.day)} x2={x(hv.day)} y1={pad.t} y2={H - pad.b} stroke="var(--ink-2)" strokeWidth={1} />
            {hv.hist && <circle cx={x(hv.day)} cy={y(hv.hist.v)} r={4} fill="var(--hist)" stroke="var(--surface)" strokeWidth={2} />}
            {hv.ser.map(({ s, p }) => p && <circle key={s.id} cx={x(hv.day)} cy={y(p.v)} r={4} fill={SERIES_COLOR[s.role]} stroke="var(--surface)" strokeWidth={2} />)}
          </g>
        )}
      </svg>
      {hv && (
        <div className="pointer-events-none absolute top-2 rounded-md border border-rule bg-surface px-3 py-2 text-xs shadow-sm" style={{ left: `${Math.min(70, (x(hv.day) / W) * 100 + 2)}%` }}>
          <div className="mb-1 text-muted">Week ending {shortDate(dayToDate(openingDate, hv.day))}</div>
          {hv.hist && (
            <div className="tnum flex justify-between gap-4"><strong>{usd(hv.hist.v)}</strong><span className="text-ink-2">Actual</span></div>
          )}
          {hv.ser.map(({ s, p }) =>
            p && hv.day > asOfDay ? (
              <div key={s.id} className="tnum flex items-center justify-between gap-4">
                <strong className={p.v < 0 ? "text-critical" : ""}>{usd(p.v)}</strong>
                <span className="flex items-center gap-1 text-ink-2"><i className="inline-block h-0.5 w-3" style={{ background: SERIES_COLOR[s.role] }} />{s.name}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        <span className="flex items-center gap-1.5"><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke="var(--hist)" strokeWidth="2" /></svg>Actual (bank feed)</span>
        {scenarios.map((s) => (
          <span key={s.id} className="flex items-center gap-1.5"><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke={SERIES_COLOR[s.role]} strokeWidth="2" strokeDasharray="5 3" /></svg>{s.name} (projected)</span>
        ))}
        <span className="flex items-center gap-1.5"><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke="var(--critical)" strokeWidth="1" strokeDasharray="2 3" /></svg>Minimum reserve</span>
      </div>
    </div>
  );
}

/** Lowest cash point per scenario as customer payments slip further. */
export function DelaySweep({ sweep, scenarios, reserve }: { sweep: { delay: number; minCash: Record<string, number> }[]; scenarios: Scenario[]; reserve: number }) {
  const W = 520;
  const H = 200;
  const pad = { l: 60, r: 16, t: 12, b: 30 };
  const vals = sweep.flatMap((s) => Object.values(s.minCash)).concat([reserve, 0]);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 4);
  const lo = Math.min(ticks[0], ...vals);
  const hi = Math.max(ticks[ticks.length - 1], ...vals);
  const maxD = sweep[sweep.length - 1].delay || 1;
  const x = (d: number) => pad.l + (d / maxD) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Lowest cash point versus payment delay" onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--rule)" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--muted)" className="tnum">{usd(t, { compact: true })}</text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--rule-strong)" strokeWidth={1.5} />
        <line x1={pad.l} x2={W - pad.r} y1={y(reserve)} y2={y(reserve)} stroke="var(--critical)" strokeDasharray="2 3" />
        {sweep.map((s) => (
          <text key={s.delay} x={x(s.delay)} y={H - 10} textAnchor="middle" fontSize={10} fill="var(--muted)">{s.delay === 0 ? "on time" : `+${s.delay}d`}</text>
        ))}
        {scenarios.map((sc) => (
          <g key={sc.id}>
            <path d={sweep.map((s, i) => `${i ? "L" : "M"}${x(s.delay)},${y(s.minCash[sc.id])}`).join("")} fill="none" stroke={SERIES_COLOR[sc.role]} strokeWidth={2} />
            {sweep.map((s) => <circle key={s.delay} cx={x(s.delay)} cy={y(s.minCash[sc.id])} r={4} fill={SERIES_COLOR[sc.role]} stroke="var(--surface)" strokeWidth={2} />)}
          </g>
        ))}
        {sweep.map((s) => (
          <rect key={s.delay} x={x(s.delay) - 20} y={pad.t} width={40} height={H - pad.t - pad.b} fill="transparent" onPointerEnter={() => setHover(s.delay)} />
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--ink-2)" pointerEvents="none" />}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-1 rounded-md border border-rule bg-surface px-3 py-2 text-xs shadow-sm" style={{ left: `${Math.min(60, (x(hover) / W) * 100 + 2)}%` }}>
          <div className="mb-1 text-muted">Customers pay {hover} days later</div>
          {scenarios.map((sc) => {
            const v = sweep.find((s) => s.delay === hover)!.minCash[sc.id];
            return (
              <div key={sc.id} className="tnum flex items-center justify-between gap-4">
                <strong className={v < 0 ? "text-critical" : ""}>{usd(v)}</strong>
                <span className="flex items-center gap-1 text-ink-2"><i className="inline-block h-0.5 w-3" style={{ background: SERIES_COLOR[sc.role] }} />{sc.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Stress grid: one cell per (sales decline x payment delay) at a chosen cost shock. Status with icon + label. */
export function StressGrid({ cells, costShock }: { cells: StressCell[]; costShock: number }) {
  const rows = [...new Set(cells.map((c) => c.salesDecline))];
  const cols = [...new Set(cells.map((c) => c.paymentDelayDays))];
  const cell = (s: number, d: number) => cells.find((c) => c.salesDecline === s && c.paymentDelayDays === d && c.costShock === costShock)!;
  const state = (c: StressCell) => (c.goesNegative ? { icon: "✕", label: "Runs out", bg: "color-mix(in oklab, var(--critical) 18%, var(--surface))", fg: "var(--critical-text)" } : c.breachesReserve ? { icon: "!", label: "Below reserve", bg: "color-mix(in oklab, var(--warning) 22%, var(--surface))", fg: "var(--ink)" } : { icon: "✓", label: "Holds", bg: "color-mix(in oklab, var(--good) 12%, var(--surface))", fg: "var(--good-text)" });
  return (
    <table className="w-full border-separate text-xs" style={{ borderSpacing: 2 }}>
      <thead>
        <tr>
          <th className="text-left font-normal text-muted">Sales ↓ / payments late →</th>
          {cols.map((d) => <th key={d} className="font-medium text-ink-2">{d === 0 ? "on time" : `+${d} days`}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s}>
            <th className="text-left font-medium text-ink-2">{s === 0 ? "no drop" : `−${Math.round(s * 100)}%`}</th>
            {cols.map((d) => {
              const c = cell(s, d);
              const st = state(c);
              return (
                <td key={d} title={`${st.label}: lowest cash ${usd(c.minCash)}`} className="rounded-[4px] px-2 py-1.5 text-center" style={{ background: st.bg, color: st.fg }}>
                  <div className="font-semibold">{st.icon} <span className="tnum">{usd(c.minCash, { compact: true })}</span></div>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Historical (solid) vs counterfactual (dashed) weekly cash. */
export function CounterfactualChart({ weekly, openingDate }: { weekly: { endDay: number; historical: number; counterfactual: number }[]; openingDate: string }) {
  const W = 760;
  const H = 240;
  const pad = { l: 64, r: 16, t: 12, b: 28 };
  const vals = weekly.flatMap((w) => [w.historical, w.counterfactual]);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 4);
  const lo = Math.min(ticks[0], ...vals);
  const hi = Math.max(ticks[ticks.length - 1], ...vals);
  const d0 = weekly[0].endDay;
  const d1 = weekly[weekly.length - 1].endDay;
  const x = (d: number) => pad.l + ((d - d0) / (d1 - d0 || 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const p = (k: "historical" | "counterfactual") => weekly.map((w, i) => `${i ? "L" : "M"}${x(w.endDay)},${y(w[k])}`).join("");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Historical cash versus counterfactual cash">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--rule)" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--muted)" className="tnum">{usd(t, { compact: true })}</text>
          </g>
        ))}
        <text x={pad.l} y={H - 8} fontSize={10} fill="var(--muted)">{shortDate(dayToDate(openingDate, d0))}</text>
        <text x={W - pad.r} y={H - 8} textAnchor="end" fontSize={10} fill="var(--muted)">{shortDate(dayToDate(openingDate, d1))}</text>
        <path d={p("counterfactual")} fill="none" stroke="var(--s-rec)" strokeWidth={2} strokeDasharray="6 4" />
        <path d={p("historical")} fill="none" stroke="var(--hist)" strokeWidth={2} />
      </svg>
      <div className="mt-1 flex gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5"><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke="var(--hist)" strokeWidth="2" /></svg>What happened (fact)</span>
        <span className="flex items-center gap-1.5"><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke="var(--s-rec)" strokeWidth="2" strokeDasharray="5 3" /></svg>If paid on time (estimate)</span>
      </div>
    </div>
  );
}
