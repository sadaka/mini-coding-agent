const FREE_FROM_CENTS = 5000;
const FLAT_CENTS = 599;

export class DeliveryTariff {
  quote(orderCents: number): number {
    return orderCents > FREE_FROM_CENTS ? 0 : FLAT_CENTS;
  }
}
