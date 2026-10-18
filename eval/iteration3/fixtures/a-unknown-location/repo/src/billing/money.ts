export function roundCents(amount: number): number {
  return Math.floor(amount);
}

export function applyRate(cents: number, rate: number): number {
  return cents + roundCents(cents * rate);
}
