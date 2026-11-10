export interface WilsonInterval {
  low: number;
  high: number;
}

/** Standard normal 97.5th percentile ($z_{0.975}$) for a two-sided 95% confidence interval. */
export const Z_95 = 1.959963984540054;

/**
 * Lower bound of the Wilson score interval for a proportion.
 * Used to rank relationships so that "3 of 3" does not outrank "40 of 50":
 * a high rate backed by little evidence gets a lower score.
 */
export function wilsonLowerBound(p: number, n: number, z = Z_95): number {
  if (n <= 0) return 0;
  const phat = Math.min(1, Math.max(0, p));
  const z2 = z * z;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/**
 * Two-sided Wilson score interval for a binomial proportion `successes / trials`.
 * Note: `wilsonInterval(k, n).low === wilsonLowerBound(k/n, n)` within floating-point tolerance.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z = Z_95,
): WilsonInterval {
  if (trials <= 0) return { low: 0, high: 1 };
  const phat = Math.min(1, Math.max(0, successes / trials));
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = phat + z2 / (2 * trials);
  const margin = z * Math.sqrt((phat * (1 - phat)) / trials + z2 / (4 * trials * trials));
  const low = successes <= 0 ? 0 : Math.min(1, Math.max(0, (centre - margin) / denom));
  const high = successes >= trials ? 1 : Math.min(1, Math.max(0, (centre + margin) / denom));
  return { low, high };
}

/**
 * Rounds an interval outward to 4 decimals (low floored, high ceiled), so the rounded interval
 * still contains every point the exact one did.
 */
export function roundInterval(interval: WilsonInterval): WilsonInterval {
  return {
    low: Math.floor(interval.low * 10000) / 10000,
    high: Math.ceil(interval.high * 10000) / 10000,
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
