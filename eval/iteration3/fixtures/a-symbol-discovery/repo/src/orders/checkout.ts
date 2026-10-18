import { DeliveryTariff } from "../fulfilment/tariff.ts";

export function orderTotal(itemsCents: number): number {
  return itemsCents + new DeliveryTariff().quote(itemsCents);
}
