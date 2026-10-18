import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 }); // each case spawns npm/tsx (and tsc + vitest on success)

const REPO = process.cwd();
let copy: string;

/** Everything FR-55/AC-32 says the command must not touch: all existing files in these places. */
const PROTECTED = ["src/agent", "src/context", "src/providers", "src/cli", "src/tools", "src/navigation"];
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else out.set(r, createHash("sha1").update(readFileSync(join(root, r))).digest("hex"));
    }
  };
  for (const p of PROTECTED) walk(p);
  return out;
}

const add = (...args: string[]) =>
  spawnSync("npm", ["run", "--silent", "add-language", ...args], { cwd: copy, encoding: "utf8" });
const out = (r: ReturnType<typeof add>) => r.stdout + r.stderr;

beforeAll(() => {
  copy = mkdtempSync(join(tmpdir(), "addlang-"));
  for (const f of ["src", "tests", "scripts", "package.json", "tsconfig.json", "vitest.config.ts"]) {
    cpSync(join(REPO, f), join(copy, f), { recursive: true });
  }
  // tests/unit/eval/*.test.ts import the harness (which imports the cost meter), so the copy's tsc needs these files to resolve them.
  for (const f of ["run.ts", "check-results.ts", "real-context/run.ts"]) {
    cpSync(join(REPO, "eval/iteration3", f), join(copy, "eval/iteration3", f), { recursive: true });
  }
  rmSync(join(copy, "tests/fixtures/symbols/ts"), { recursive: true, force: true }); // not needed, keeps the copy small
  symlinkSync(join(REPO, "node_modules"), join(copy, "node_modules"));
});
afterAll(() => rmSync(copy, { recursive: true, force: true }));

describe("add-language", () => {
  it.each(["", "Java", "1java", "ja-va", "../evil", "a b", "x".repeat(31)])("refuses invalid name %j and writes nothing", (bad) => {
    const before = snapshot(copy);
    const r = add(bad);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/invalid name/);
    expect(snapshot(copy)).toEqual(before);
    expect(existsSync(join(copy, "src/navigation/symbols/languages/index.ts"))).toBe(false);
  });

  it("scaffolds java: files created, registered, tsc and the new test pass, TODOs printed", () => {
    const before = snapshot(copy);
    const r = add("java");
    expect(out(r)).toContain("Remaining TODOs");
    expect(r.status, out(r)).toBe(0);

    for (const f of [
      "src/navigation/symbols/languages/java.ts",
      "src/navigation/symbols/languages/index.ts",
      "tests/fixtures/symbols/java/Sample.java",
      "tests/unit/navigation/java-provider.test.ts",
    ]) expect(existsSync(join(copy, f)), f).toBe(true);

    const index = readFileSync(join(copy, "src/navigation/symbols/languages/index.ts"), "utf8");
    expect(index).toContain('import { registerJavaProvider } from "./java.js";');
    expect(index).toMatch(/registerPythonProvider\(\);\n\s+registerJavaProvider\(\);/); // seeded with existing languages
    expect(out(r)).toMatch(/tree-sitter-java\.wasm/);

    // static check: the only differences in protected dirs are the two new files
    const after = snapshot(copy);
    const changed = [...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => k).sort();
    expect(changed).toEqual(["src/navigation/symbols/languages/index.ts", "src/navigation/symbols/languages/java.ts"]);
    for (const [k, v] of before) expect(after.get(k), `${k} was modified or removed`).toBe(v);
  });

  it("refuses a duplicate and leaves files untouched", () => {
    const before = snapshot(copy);
    const r = add("java");
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/already exists/);
    expect(snapshot(copy)).toEqual(before);
  });

  it("a second language appends to the index without disturbing the first", () => {
    const r = add("go");
    expect(r.status, out(r)).toBe(0);
    const index = readFileSync(join(copy, "src/navigation/symbols/languages/index.ts"), "utf8");
    expect(index).toMatch(/registerJavaProvider\(\);\n\s+registerGoProvider\(\);/); // java kept, go appended after it
    expect(index).toContain("// add-language:calls");
  });

  it("refuses an existing language (python) and an extension already taken", () => {
    const before = snapshot(copy);
    expect(out(add("python"))).toMatch(/already exists/);
    const clash = add("pyx", ".py");
    expect(clash.status).not.toBe(0);
    expect(out(clash)).toMatch(/extension \.py is already handled by the python provider/);
    expect(snapshot(copy)).toEqual(before);
  });
});
