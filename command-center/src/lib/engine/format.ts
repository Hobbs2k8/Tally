// Display helpers shared by server and client. Input money is integer cents.

export function usd(cents: number, opts: { compact?: boolean; sign?: boolean } = {}): string {
  const v = cents / 100;
  const sign = opts.sign && v > 0 ? "+" : "";
  if (opts.compact && Math.abs(v) >= 1000) {
    const k = Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : `${(v / 1000).toFixed(1)}k`;
    return `${sign}${v < 0 ? "-" : ""}$${k.replace("-", "")}`;
  }
  const s = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return `${sign}${v < 0 ? "-" : ""}$${s}`;
}

export function pct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
