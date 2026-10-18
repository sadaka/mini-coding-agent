import assert from "node:assert/strict";
import { orderTotal } from "../src/orders/checkout.ts";

assert.equal(orderTotal(5000), 5000);
assert.equal(orderTotal(4999), 4999 + 599);
console.log("ok");
