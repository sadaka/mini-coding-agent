import { discounted } from "./discount.ts";
import { taxFor } from "./tax.ts";

export interface Item { cents: number; percentOff?: number }

export function invoiceTotal(items: Item[], taxRatePercent: number): number {
  const net = items.reduce((sum, i) => sum + discounted(i.cents, i.percentOff ?? 0), 0);
  return net + taxFor(net, taxRatePercent);
}
