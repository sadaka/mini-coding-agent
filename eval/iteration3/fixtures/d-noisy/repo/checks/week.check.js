import assert from "node:assert/strict";
import { weeklyEmail } from "../src/report/email.js";

// 2024-05-15 is a Wednesday; weeks start on Monday.
assert.equal(weeklyEmail("2024-05-15"), "Your week: 2024-05-13, 2024-05-14, 2024-05-15, 2024-05-16, 2024-05-17, 2024-05-18, 2024-05-19");
// A Sunday belongs to the week that began the previous Monday.
assert.ok(weeklyEmail("2024-05-19").startsWith("Your week: 2024-05-13"));
console.log("ok");
