// The decision sentences of the bottom line, from simulation results only.
// Client-safe: the browser regenerates them when an assumption is edited.
import { usd } from "../engine/format";
import { shortChanges } from "../engine/plan";
import type { Assumption } from "./assumptions";
import { specFromAssumptions } from "./assumptions";
import type { ExplainFact } from "./explain";
import type { SimulationResult } from "./simulate";

export function joinList(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

export function simulationHeadline(sim: SimulationResult, assumptions: Assumption[], overdueAmount: number | null): { parts: string[]; facts: ExplainFact[] } {
  const facts: ExplainFact[] = [];
  const fact = (label: string, text: string) => {
    facts.push({ label, text });
    return text;
  };
  const parts: string[] = [];
  const a = (id: string) => assumptions.find((x) => x.id === id)?.value ?? 0;
  const reserve = fact("reserve", usd(a("reserve")));
  const days = a("stressDelayDays");
  const delay = fact("stress delay days", `${days} days`);
  const P = sim.projections;
  const S = sim.stressedProjections;
  const F = sim.feasible;
  const rec = P.recommended;
  const prop = P.proposed;
  if (prop && rec && sim.search) {
    const spec = specFromAssumptions(assumptions, true);
    const recLevers = sim.scenarios.find((x) => x.id === "recommended")!.levers;
    const short = shortChanges(recLevers, spec.request, usd).map((c) =>
      c === "chase overdue invoices first" && overdueAmount ? `chase the ${fact("overdue", usd(overdueAmount))} of overdue invoices` : c,
    );
    if (F.proposed) {
      parts.push(`Your plan holds up: doing it now keeps cash above the ${reserve} reserve (low ${fact("proposal base min", usd(prop.summary.minCash))}) and above zero even if customers pay ${delay} late (low ${fact("proposal stress min", usd(S.proposed.summary.minCash))}).`);
      if (short.length) parts.push(`To add headroom: ${joinList(short)}.`);
    } else if (F.recommended) {
      const problem =
        S.proposed.summary.minCash < 0
          ? `runs out of cash if customers pay ${delay} late (low ${fact("proposal stress min", usd(S.proposed.summary.minCash))})`
          : `drops below your ${reserve} reserve (low ${fact("proposal base min", usd(prop.summary.minCash))})`;
      const asked = [spec.request.hires, spec.request.marketingWeekly, spec.request.ownerDraw, spec.request.priceChangePct, spec.request.oneTime].filter(Boolean).length;
      parts.push(asked > 1 ? `Don't do it all at once: doing everything now ${problem}.` : `Not right away: doing it now ${problem}.`);
      parts.push(`Safest plan: ${joinList(short)}. Cash then stays above ${reserve} (low ${fact("recommended base min", usd(rec.summary.minCash))}) and above zero even with a ${days}-day slip (low ${fact("recommended stress min", usd(S.recommended.summary.minCash))}).`);
    } else {
      parts.push(`No version of this plan is safe yet: even the most cautious one falls to ${fact("recommended stress min", usd(S.recommended.summary.minCash))} if customers pay ${delay} late.`);
      if (overdueAmount) parts.push(`Fix collections first: ${fact("overdue", usd(overdueAmount))} is overdue.`);
    }
  } else if (P.current) {
    const s = S.current.summary;
    parts.push(`If customers pay ${delay} late, cash bottoms out at ${fact("stress min", usd(s.minCash))} in week ${s.minWeek + 1}${s.firstBreachWeek !== null ? `, below your ${reserve} reserve from week ${s.firstBreachWeek + 1}` : `, still above your ${reserve} reserve`}.`);
    const bp = sim.stress?.breakingPoints.find((b) => b.axis === "paymentDelayDays");
    if (bp?.breaksZeroAt !== null && bp?.breaksZeroAt !== undefined) parts.push(`Cash would run out at about ${fact("delay to zero", `${bp.breaksZeroAt} days`)} of delay.`);
  }
  return { parts, facts };
}
