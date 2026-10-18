import { applyRate } from "../billing/money.ts";

export interface Line { name: string; priceCents: number; qty: number }

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
}

export function totalWithTax(lines: Line[], rate: number): number {
  return applyRate(subtotal(lines), rate);
}
