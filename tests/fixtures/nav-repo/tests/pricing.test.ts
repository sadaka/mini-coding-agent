import assert from "node:assert/strict";
import { invoiceTotal } from "../src/pricing/invoice.ts";

assert.equal(invoiceTotal([{ cents: 1999 }], 8.25), 2164);
assert.equal(invoiceTotal([{ cents: 1000, percentOff: 10 }], 0), 900);
console.log("ok");
