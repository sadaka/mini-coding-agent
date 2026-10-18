// Discounts are applied before tax; the tax rules live elsewhere.
export function discounted(cents: number, percentOff: number): number {
  return Math.round(cents * (1 - percentOff / 100));
}
