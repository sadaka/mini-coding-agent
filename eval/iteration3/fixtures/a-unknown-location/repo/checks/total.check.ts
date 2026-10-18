import assert from "node:assert/strict";
import { totalWithTax } from "../src/cart/cart.ts";

assert.equal(totalWithTax([{ name: "mug", priceCents: 1999, qty: 1 }], 0.0825), 2164);
assert.equal(totalWithTax([{ name: "pen", priceCents: 100, qty: 3 }], 0), 300);
console.log("ok");
