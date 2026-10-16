/**
 * Lower bound of the Wilson score interval for a proportion.
 * Used to rank relationships so that "3 of 3" does not outrank "40 of 50":
 * a high rate backed by little evidence gets a lower score.
 */
export function wilsonLowerBound(p: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const phat = Math.min(1, Math.max(0, p));
  const z2 = z * z;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
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
