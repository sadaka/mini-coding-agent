// Prints the shipping label for a parcel; shipping cost is not decided here.
export function label(name: string, city: string): string {
  return `SHIPPING TO: ${name}, ${city}`;
}
