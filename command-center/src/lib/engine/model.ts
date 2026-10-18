// Client-safe types for the projection engine. ProjectionInputs is plain JSON:
// the server derives it once from the books, and the browser can rerun
// projections from it when a numeric assumption changes (no model call).

export interface ARItem {
  invoiceId: string;
  customerId: string;
  customerName: string;
  amount: number;
  expectedDay: number;
  daysPastDue: number;
  atRisk: boolean;
}

export interface APItem {
  billId: string;
  vendorName: string;
  category: string;
  amount: number;
  dueDay: number;
}

export interface RecurringItem {
  key: string;
  vendorName: string;
  category: string;
  amount: number;
  intervalDays: number;
  nextDay: number;
  payLagDays: number;
  billIds: string[];
}

export interface ProjectionInputs {
  companyId: string;
  companyName: string;
  openingDate: string;
  asOfDay: number;
  openingCash: number;
  openingCashSource: string | null;
  openAR: ARItem[];
  openAP: APItem[];
  /** Average new invoiced sales per week over the trailing window. */
  weeklyInvoicedSales: number;
  /** Average register / card sales per week (cash on the day). */
  weeklyPosSales: number;
  /** Share of an invoice collected in week k after issue. */
  collectionCurve: number[];
  uncollectedShare: number;
  /** Variable supplier cost per $ of sales volume (trailing window). */
  variableCostRatio: number;
  variableCostLagDays: number;
  weeklyPayroll: number;
  medianWeeklyWage: number;
  recurring: RecurringItem[];
  /** Irregular, non-variable overhead per week (trailing average). */
  weeklyOverhead: number;
  /** Of which historical growth / marketing spend per week. */
  weeklyMarketingHistorical: number;
  defaultReserve: number;
  history: { endDay: number; closing: number }[];
  trailingWeeks: number;
}

export interface Hire {
  count: number;
  weeklyWage: number; // per person, cents
  startWeek: number;
}

export interface OwnerDraw {
  amount: number;
  week: number;
}

export interface OneTime {
  label: string;
  amount: number; // positive = cash out
  week: number;
}

export interface Levers {
  hires: Hire[];
  marketingWeekly: number; // added spend per week, cents
  marketingStartWeek: number;
  marketingLiftPct: number; // assumed sales lift once marketing runs (0 = none assumed)
  marketingLiftLagWeeks: number;
  ownerDraws: OwnerDraw[];
  priceChangePct: number;
  priceElasticity: number; // % volume change per 1% price change (negative)
  salesChangePct: number; // stress: demand change
  paymentDelayDays: number; // stress: customers pay this much later
  costShockPct: number; // stress: supplier and overhead cost increase
  collectOverdue: { recoveryPct: number; withinDays: number } | null;
  vendorTermsExtraDays: number; // negotiated extra days on new supplier bills
  earlyPayDiscount: { discountPct: number; adoptionPct: number } | null;
  oneTime: OneTime[];
  includeAtRisk: boolean; // count >90-day overdue invoices as collectable
}

export const NO_LEVERS: Levers = {
  hires: [],
  marketingWeekly: 0,
  marketingStartWeek: 0,
  marketingLiftPct: 0,
  marketingLiftLagWeeks: 4,
  ownerDraws: [],
  priceChangePct: 0,
  priceElasticity: -1,
  salesChangePct: 0,
  paymentDelayDays: 0,
  costShockPct: 0,
  collectOverdue: null,
  vendorTermsExtraDays: 0,
  earlyPayDiscount: null,
  oneTime: [],
  includeAtRisk: false,
};

export interface Scenario {
  id: string;
  name: string;
  role: "current" | "proposed" | "recommended" | "alternative";
  levers: Levers;
  description?: string;
}

export interface WeekRow {
  week: number;
  startDay: number;
  endDay: number;
  opening: number;
  inflows: { openAR: number; newSales: number; pos: number; recovered: number };
  outflows: {
    payroll: number;
    newHires: number;
    recurring: number;
    openAP: number;
    variable: number;
    overhead: number;
    marketing: number;
    ownerDraws: number;
    oneTime: number;
  };
  net: number;
  closing: number;
  revenue: number; // accrual view: sales earned this week
  operatingCost: number; // accrual view: costs incurred this week
}

export interface ProjectionSummary {
  endingCash: number;
  minCash: number;
  minWeek: number;
  weeksBelowReserve: number;
  firstBreachWeek: number | null;
  firstNegativeWeek: number | null;
  totalIn: number;
  totalOut: number;
  revenue: number;
  operatingProfit: number;
  margin: number | null;
}

export interface Projection {
  scenarioId: string;
  reserve: number;
  weeks: WeekRow[];
  summary: ProjectionSummary;
}
