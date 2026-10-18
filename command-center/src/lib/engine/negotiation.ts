// Negotiation Coach: compares payment-term, discount and price changes on
// liquidity (minimum cash) and margin. Counterparty behaviour is an explicit,
// labeled assumption in every option.
import type { Levers, ProjectionInputs } from "./model";
import { project } from "./projection";

export interface NegotiationOption {
  id: string;
  title: string;
  behaviorAssumption: string; // what we assume the customer/vendor does
  minCashDelta: number;
  endingCashDelta: number;
  operatingProfitDelta: number;
  marginDelta: number | null;
}

export function compareTermOptions(
  inputs: ProjectionInputs,
  base: Levers,
  reserve: number,
  horizon: number,
  opts: { vendorExtraDays?: number; discountPct?: number; discountAdoption?: number; priceChangePct?: number; priceElasticity?: number } = {},
): NegotiationOption[] {
  const p0 = project(inputs, base, reserve, horizon);
  const variants: { id: string; title: string; assumption: string; levers: Levers }[] = [];
  const vd = opts.vendorExtraDays ?? 15;
  variants.push({
    id: "vendor-terms",
    title: `Ask suppliers for ${vd} more days to pay`,
    assumption: `Assumes suppliers accept net +${vd} days on new bills with no price change.`,
    levers: { ...base, vendorTermsExtraDays: base.vendorTermsExtraDays + vd },
  });
  if (inputs.weeklyInvoicedSales > 0) {
    const d = opts.discountPct ?? 0.02;
    const a = opts.discountAdoption ?? 0.3;
    variants.push({
      id: "early-pay-discount",
      title: `Offer customers ${Math.round(d * 100)}% off for paying within 10 days`,
      assumption: `Assumes ${Math.round(a * 100)}% of new invoice value takes the discount and pays in about a week.`,
      levers: { ...base, earlyPayDiscount: { discountPct: d, adoptionPct: a } },
    });
  }
  const pc = opts.priceChangePct ?? 0.03;
  const el = opts.priceElasticity ?? -1;
  variants.push({
    id: "price-change",
    title: `Raise prices ${Math.round(pc * 100)}%`,
    assumption: `Assumes volume changes ${el}% for each 1% price change (elasticity ${el}).`,
    levers: { ...base, priceChangePct: base.priceChangePct + pc, priceElasticity: el },
  });
  return variants.map((v) => {
    const p = project(inputs, v.levers, reserve, horizon);
    return {
      id: v.id,
      title: v.title,
      behaviorAssumption: v.assumption,
      minCashDelta: p.summary.minCash - p0.summary.minCash,
      endingCashDelta: p.summary.endingCash - p0.summary.endingCash,
      operatingProfitDelta: p.summary.operatingProfit - p0.summary.operatingProfit,
      marginDelta: p.summary.margin !== null && p0.summary.margin !== null ? p.summary.margin - p0.summary.margin : null,
    };
  });
}
