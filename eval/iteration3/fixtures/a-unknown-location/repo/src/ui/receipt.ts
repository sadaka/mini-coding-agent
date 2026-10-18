import { totalWithTax, type Line } from "../cart/cart.ts";
import { dollars } from "./format.ts";

export function receipt(lines: Line[]): string {
  const rows = lines.map((l) => `${l.qty} x ${l.name}  ${dollars(l.priceCents * l.qty)}`);
  return [...rows, `TOTAL ${dollars(totalWithTax(lines, 0.0825))}`].join("\n");
}
