// DeterministicProvider: keyword and regex rules. Works with no API key, and
// is the "deterministic baseline" in the evaluation.
import type { Task } from "../pipeline/task";
import { emptyTask, RECORD_TYPES } from "../pipeline/task";
import type { CompanyCandidate, ExplainInput, RankedCompany, ReasoningProvider, ScenarioProposal, Usage } from "./types";
import { NO_USAGE } from "./types";

const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, "a couple of": 2, few: 3,
};

/** "$20,000", "$20k", "20k", "1.5m", "20 thousand" -> dollars. */
export function parseMoney(s: string): number | null {
  const m = s.match(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?\b/i);
  if (!m) return null;
  let v = Number(m[1].replace(/,/g, ""));
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand") v *= 1_000;
  if (unit === "m" || unit === "million") v *= 1_000_000;
  return Number.isFinite(v) ? v : null;
}

const MONEY = String.raw`\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|thousand|million)?|\d[\d,]*(?:\.\d+)?\s?(?:k|thousand)\b`;

function amountNear(text: string, keyword: RegExp, window = 60): number | null {
  const k = text.search(keyword);
  if (k < 0) return null;
  const slice = text.slice(Math.max(0, k - 25), k + window);
  const m = slice.match(new RegExp(MONEY, "i"));
  return m ? parseMoney(m[0]) : null;
}

function pctNear(text: string, keyword: RegExp, window = 50): number | null {
  const k = text.search(keyword);
  if (k < 0) return null;
  const m = text.slice(Math.max(0, k - 20), k + window).match(/(\d+(?:\.\d+)?)\s?(%|percent)/i);
  return m ? Number(m[1]) / 100 : null;
}

export function parseTask(request: string): Task {
  const t = emptyTask(request.trim().slice(0, 200) || "Review my finances");
  const s = request.toLowerCase();
  const d = t.decisions;

  // Hiring
  const hire = s.match(/\bhir(?:e|ing)\s+(?:(\d+|a couple of|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\s+)?(?:new\s+|more\s+|additional\s+|extra\s+|full[- ]time\s+|part[- ]time\s+)*(employees?|people|persons?|staff|workers?|hires?|someone|sales\s?(?:people|person|reps?)|\w+)?/);
  if (hire) {
    const n = hire[1] ? (WORD_NUM[hire[1]] ?? Number(hire[1])) : 1;
    d.hireCount = Number.isFinite(n) && n > 0 ? n : 1;
    const salary = s.match(/(\$\s?\d[\d,]*(?:\.\d+)?\s?k?)\s*(?:\/|per|a)\s*(year|yr|annum|hour|hr|week|wk|month|mo)\b/);
    if (salary) {
      const v = parseMoney(salary[1]) ?? 0;
      const per = salary[2];
      d.hireAnnualSalary = per.startsWith("h") ? v * 40 * 52 : per.startsWith("w") ? v * 52 : per.startsWith("mo") ? v * 12 : v;
    }
  }

  // Marketing
  if (/\bmarketing|advertis|ad spend|promotion/.test(s) && /(increase|more|boost|raise|add|double|grow|spend|invest|bump)/.test(s)) {
    d.marketingIncreaseRequested = true;
    const amt = amountNear(s, /marketing|advertis|ad spend/);
    if (amt !== null) {
      const perWeek = /marketing[^.]{0,40}(per|a|\/)\s*week/.test(s);
      d.marketingMonthlyIncrease = perWeek ? amt * 4.33 : amt;
    }
  }

  // Owner draw
  if (/owner'?s?\s*(draw|distribution)|\bdraw\b|pay myself|take (?:some )?(?:money|cash) out|distribution/.test(s)) {
    d.ownerDrawRequested = true;
    d.ownerDrawAmount = amountNear(s, /owner'?s?\s*(draw|distribution)|\bdraw\b|pay myself|money out|cash out|distribution/);
  }

  // Pricing
  const PRICE_UP = /(rais(?:e|ing)|increas(?:e|ing)|hik(?:e|ing)|lift(?:ing)?|bump(?:ing)?)\s+(?:our |my |all )?prices?|price (increase|hike|change)/;
  const PRICE_DOWN = /(cut(?:ting)?|lower(?:ing)?|reduc(?:e|ing)|drop(?:ping)?)\s+(?:our |my |all )?prices?|price cut/;
  if (PRICE_UP.test(s) || PRICE_DOWN.test(s)) {
    const p = pctNear(s, /price/);
    const down = PRICE_DOWN.test(s) && !PRICE_UP.test(s);
    d.priceChangePct = p !== null ? (down ? -p : p) : down ? -0.05 : 0.05;
  }

  // Equipment
  if (/(buy|purchase|lease|invest in|get)\s+(?:a |an |new |some )*(equipment|machine|truck|van|vehicle|oven|roaster|computer|forklift|espresso)/.test(s)) {
    d.equipmentAmount = amountNear(s, /equipment|machine|truck|van|vehicle|oven|roaster|computer|forklift|espresso/, 80);
  }

  // Terms and discounts
  if (/(supplier|vendor)s?[^.]{0,40}(terms|net \d+|more time|longer)|extend(?:ed)? (?:payment )?terms|net\s?\d+/.test(s)) {
    const m = s.match(/(\d+)\s*(?:more |extra |additional )?days/);
    const net = s.match(/net\s?(\d+)/);
    d.vendorTermsExtraDays = m ? Number(m[1]) : net ? Math.max(0, Number(net[1]) - 7) : 15;
  }
  if (/early[- ]pay(ment)?\s*discount|discount for (paying|early)|\d+%\s*off for (paying|early)|2\/10/.test(s)) {
    d.earlyPayDiscountPct = pctNear(s, /discount|off for/) ?? 0.02;
  }

  // Stress
  const delay = s.match(/(\d+)\s*days?\s*(late|delay|slower|later)|delay(?:ed|s)?\s*(?:by\s*)?(\d+)\s*days/);
  const hypothetical = /what (happens|if)|\bif\b|test|suppose|scenario|stress|worst case|could/.test(s);
  const delayPhrase = /(payments?|customers?|clients?|invoices?|collections?)[^.]{0,40}(delay|late|slow|later)|pay(ing)? late|delayed payments?/.test(s);
  if ((delayPhrase && hypothetical) || delay) {
    t.stress.requested = true;
    t.stress.paymentDelayDays = delay ? Number(delay[1] ?? delay[3]) : null;
  }
  const drop = s.match(/(sales|revenue|demand)[^.]{0,30}(drop|fall|decline|down|decrease)[^.]{0,15}?(\d+)\s?%/);
  const dropBefore = s.match(/(\d+)\s?%\s*(?:drop|fall|decline|decrease|dip)\s*(?:in\s*)?(?:sales|revenue|demand)|(\d+)\s?%\s*(?:sales|revenue|demand)\s*(?:drop|fall|decline|decrease|dip)/);
  if (drop || dropBefore || /(sales|revenue|demand)[^.]{0,20}(drop|fall|decline|slump)/.test(s)) {
    t.stress.requested = true;
    t.stress.salesDropPct = drop ? Number(drop[3]) / 100 : dropBefore ? Number(dropBefore[1] ?? dropBefore[2]) / 100 : null;
  }
  const cost = s.match(/costs?[^.]{0,30}(rise|spike|increase|jump|up)[^.]{0,15}?(\d+)\s?%/);
  if (cost || /cost (spike|shock)/.test(s)) {
    t.stress.requested = true;
    t.stress.costShockPct = cost ? Number(cost[2]) / 100 : null;
  }
  if (/stress[- ]test|worst case|what could go wrong|break my plan|safest/.test(s)) t.stress.requested = true;

  // Investigation, leaks, anomalies
  t.wantsInvestigation = /investigat|flag (?:any )?problems|problems i should fix|what should i fix|check (?:my )?(?:books|finances)|health check|review my finances|anything wrong|red flags/.test(s);
  t.wantsProfitLeaks = /leak|margin|unprofitable|losing money|where am i losing|cost(s)? (?:are )?(?:rising|creeping)|profitab/.test(s);
  t.wantsAnomalies = /duplicate|unusual|anomal|suspicious|weird|odd (?:charge|transaction)|double[- ]?(?:charged|paid|billed)/.test(s);

  // Counterfactual
  const cf = request.match(/what if\s+(.+?)\s+(?:had\s+)?paid\s+(?:me\s+)?on time/i) ?? request.match(/if\s+(.+?)\s+had paid/i);
  if (cf) {
    const who = cf[1].replace(/^(my |our |the )/i, "").trim();
    t.counterfactual = { kind: "on_time_payment", customerName: /^(all |every|customers|everyone|clients)/i.test(who) ? null : who };
  }

  // Questions
  if (/profit[^.]{0,40}cash|cash[^.]{0,40}profit/.test(s)) t.questionKind = "profit_vs_cash";
  else if (/who owes|owe me|owes me|receivables?|paying late|late pay|overdue|outstanding invoices/.test(s)) t.questionKind = "top_debtors";
  else if (/biggest (?:cost|expense)|spend(?:ing)? the most|top expenses|where (?:is|does) my money go|largest (?:cost|expense)/.test(s)) t.questionKind = "top_expenses";
  else if (/runway|run out of (?:cash|money)|how long (?:can|will)/.test(s)) t.questionKind = "runway";
  else if (/how much cash|cash position|bank balance|cash on hand/.test(s)) t.questionKind = "cash_position";
  else if (/revenue trend|sales trend|growing|revenue (?:going|over time)|sales (?:going|over time)/.test(s)) t.questionKind = "revenue_trend";
  else if (/\bmargins?\b/.test(s) && !t.wantsProfitLeaks) t.questionKind = "margin";

  // Constraints
  const horizon = s.match(/next\s+(\d+)\s+(days?|weeks?|months?)/);
  if (horizon) {
    const n = Number(horizon[1]);
    t.constraints.horizonDays = Math.min(365, horizon[2].startsWith("w") ? n * 7 : horizon[2].startsWith("m") ? n * 30 : n);
  } else if (/next (?:quarter|three months)/.test(s)) t.constraints.horizonDays = 90;
  const reserve = s.match(new RegExp(String.raw`(?:keep|maintain|never (?:go|drop) below|at least)\s+(?:at least\s+)?(${MONEY})`, "i"));
  if (reserve) t.constraints.minCashReserve = parseMoney(reserve[1]);

  // Company hint: "for <Name>" / "at <Name>"
  const hint = request.match(/\b(?:for|at|of)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,4})/);
  if (hint && !/^(The|My|Our|Next|I)$/.test(hint[1])) t.companyHint = hint[1];

  // Decision type
  const dd = t.decisions;
  const nDecisions = [dd.hireCount, dd.marketingIncreaseRequested || null, dd.ownerDrawRequested || null, dd.priceChangePct, dd.equipmentAmount].filter(Boolean).length;
  t.decisionType = decisionTypeFor(t, s);

  // Missing info
  if (dd.hireCount && dd.hireAnnualSalary === null) t.missingInfo.push("salary for the new hires");
  if (dd.marketingIncreaseRequested && dd.marketingMonthlyIncrease === null) t.missingInfo.push("size of the marketing increase");
  if (dd.ownerDrawRequested && dd.ownerDrawAmount === null) t.missingInfo.push("owner draw amount");
  if (t.stress.requested && t.stress.paymentDelayDays === null && /delay|late/.test(s)) t.missingInfo.push("how many days late customers might pay");
  if (dd.equipmentAmount === null && t.decisionType === "equipment") t.missingInfo.push("equipment cost");

  t.requiredRecords = requiredRecordsFor(t);
  if (nDecisions || t.stress.requested) t.desiredComparisons.push("current plan vs proposal vs recommended plan");
  return t;
}

/** Decision type implied by a task's extracted fields (s = lowercased request text). */
export function decisionTypeFor(t: Task, s: string): Task["decisionType"] {
  const dd = t.decisions;
  const n = [dd.hireCount, dd.marketingIncreaseRequested || null, dd.ownerDrawRequested || null, dd.priceChangePct, dd.equipmentAmount].filter(Boolean).length;
  if (n >= 2) return "growth_plan";
  if (dd.hireCount) return "hiring";
  if (dd.marketingIncreaseRequested) return "marketing";
  if (dd.ownerDrawRequested) return "owner_draw";
  if (dd.priceChangePct) return "pricing";
  if (dd.equipmentAmount !== null || /equipment/.test(s)) return "equipment";
  if (dd.vendorTermsExtraDays || dd.earlyPayDiscountPct || /payment terms|terms/.test(s)) return "payment_terms";
  if (t.counterfactual) return "counterfactual";
  if (t.wantsAnomalies) return "anomaly_check";
  if (t.stress.requested) return "stress_test";
  if (t.questionKind === "profit_vs_cash" || t.questionKind === "margin" || t.wantsProfitLeaks) return "profit_question";
  if (t.questionKind === "top_debtors") return "receivables_question";
  if (t.questionKind === "top_expenses") return "expense_question";
  if (t.questionKind === "cash_position" || t.questionKind === "runway" || t.questionKind === "revenue_trend") return "cash_question";
  return "general_question";
}

/** Record types a task needs (also used to check Gemini's answer for completeness). */
export function requiredRecordsFor(t: Task): Task["requiredRecords"] {
  const need = new Set<(typeof RECORD_TYPES)[number]>();
  const dd = t.decisions;
  const simulate = Boolean(dd.hireCount || dd.marketingIncreaseRequested || dd.ownerDrawRequested || dd.priceChangePct || dd.equipmentAmount || dd.vendorTermsExtraDays || dd.earlyPayDiscountPct || t.stress.requested);
  if (simulate) ["bank", "invoices", "customer_payments", "bills", "bill_payments", "employees"].forEach((r) => need.add(r as never));
  if (dd.hireCount) need.add("payroll");
  if (t.wantsInvestigation || t.wantsAnomalies) ["invoices", "customer_payments", "bills", "bank", "journal"].forEach((r) => need.add(r as never));
  if (t.wantsProfitLeaks || t.questionKind === "margin") ["pnl", "bills", "invoices", "journal"].forEach((r) => need.add(r as never));
  switch (t.questionKind) {
    case "profit_vs_cash":
      ["pnl", "balance_sheet", "bank"].forEach((r) => need.add(r as never));
      break;
    case "top_debtors":
      ["invoices", "customer_payments"].forEach((r) => need.add(r as never));
      break;
    case "top_expenses":
      ["bills", "bank"].forEach((r) => need.add(r as never));
      break;
    case "cash_position":
      ["bank", "invoices", "customer_payments", "bills", "bill_payments"].forEach((r) => need.add(r as never));
      break;
    case "runway":
      ["bank", "bills"].forEach((r) => need.add(r as never));
      break;
    case "revenue_trend":
      need.add("pnl");
      break;
  }
  if (t.counterfactual) ["invoices", "customer_payments", "bank"].forEach((r) => need.add(r as never));
  if (!need.size) ["bank", "invoices", "customer_payments", "bills", "bill_payments"].forEach((r) => need.add(r as never));
  return RECORD_TYPES.filter((r) => need.has(r));
}

const STOP = new Set(["the", "and", "co", "co.", "inc", "inc.", "llc", "company", "group", "&", "of", "supply", "services", "my", "for", "a", "an"]);

function stem(w: string): string {
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9&']+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
}

/** Token overlap between the request and each company's name and industry. */
export function rankByOverlap(request: string, candidates: CompanyCandidate[]): RankedCompany[] {
  const req = new Set(tokens(request));
  return candidates
    .map((c) => {
      const nameHits = [...new Set(tokens(c.name))].filter((w) => req.has(w));
      const indHits = [...new Set(tokens(c.industry))].filter((w) => req.has(w) && !nameHits.includes(w));
      const score = Math.min(1, nameHits.length * 0.45 + indHits.length * 0.15);
      return { id: c.id, score, reason: nameHits.length ? `name matches "${nameHits.join(" ")}"` : indHits.length ? `industry matches "${indHits.join(" ")}"` : "no match" };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

export class DeterministicProvider implements ReasoningProvider {
  readonly name = "deterministic" as const;
  model() {
    return null;
  }
  async extractIntent(request: string) {
    return { task: parseTask(request), usage: NO_USAGE, attempts: 1, fellBack: false };
  }
  async rankCompanies(request: string, candidates: CompanyCandidate[]): Promise<{ ranked: RankedCompany[]; usage: Usage }> {
    return { ranked: rankByOverlap(request, candidates), usage: NO_USAGE };
  }
  async proposeScenarios(): Promise<{ proposals: ScenarioProposal[]; usage: Usage }> {
    return { proposals: [], usage: NO_USAGE };
  }
  async explain(input: ExplainInput) {
    return { text: input.draft, usage: NO_USAGE };
  }
}
