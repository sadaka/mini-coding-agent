import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPEN_CLASS, toggled } from "../js/menu.js";

assert.deepEqual(toggled(["menu"]), ["menu", OPEN_CLASS]);
assert.deepEqual(toggled(["menu", OPEN_CLASS]), ["menu"]);
const css = readFileSync(new URL("../css/menu.css", import.meta.url), "utf8");
assert.ok(css.includes(`.${OPEN_CLASS}`), `menu.css has no rule for .${OPEN_CLASS}`);
console.log("ok");
