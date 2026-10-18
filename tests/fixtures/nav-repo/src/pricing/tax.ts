// Sales tax in cents for an amount in cents at a percentage rate.
export function taxFor(cents: number, ratePercent: number): number {
  const exact = (cents * ratePercent) / 100;
  return Math.floor(exact);
}
