import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RESULT_CEILING, createFindTestsTool, isTestPath } from "../../../src/navigation/find-tests.js";
import { createRepositoryScope } from "../../../src/navigation/scope.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "findtests-"));
  dirs.push(d);
  return d;
};
function put(root: string, ...files: string[]) {
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "x");
  }
}
const find = (root: string, input: Record<string, unknown> = {}) =>
  createFindTestsTool(createRepositoryScope(root)).execute(input);
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("isTestPath conventions", () => {
  it.each([
    "src/a.test.ts", "src/a.spec.js", "a.test.tsx", "lib/b.spec.mjs", "pkg/test_util.py", "pkg/util_test.py",
    "tests/helper.ts", "test/x.js", "src/__tests__/y.ts", "tests/unit/deep/z.py", "src/UserTest.java", "a/b_test.go", "spec/none/FooSpec.scala",
  ])("matches %s", (p) => expect(isTestPath(p)).toBe(true));

  it.each([
    "src/a.ts", "src/testing.ts", "src/contest.js", "README.md", "src/latest.py", "tests/data.json", "tests/fixtures/img.png", "docs/tests.md", "src/attest.ts",
  ])("does not match %s", (p) => expect(isTestPath(p)).toBe(false));
});

describe("find_tests", () => {
  it("returns TS, JS and Python test files sorted, and nothing outside the conventions", async () => {
    const d = tmp();
    put(d, "src/app.ts", "src/app.test.ts", "src/util.js", "src/util.spec.js", "py/mod.py", "py/test_mod.py", "py/mod_test.py",
      "tests/e2e/flow.ts", "tests/data.json", "README.md", "src/testing.ts");
    const r = await find(d);
    expect(r.isError).toBe(false);
    expect(r.content.split("\n")).toEqual([
      "py/mod_test.py", "py/test_mod.py", "src/app.test.ts", "src/util.spec.js", "tests/e2e/flow.ts",
    ]);
  });

  it("applies scope: default-excluded, hidden, minified and gitignored tests are skipped", async () => {
    const d = tmp();
    execFileSync("git", ["init", "-q"], { cwd: d });
    writeFileSync(join(d, ".gitignore"), "generated/\n");
    put(d, "node_modules/p/a.test.js", ".hidden/b.test.js", "generated/c.test.js", "dist/d.test.js", "src/keep.test.ts");
    expect((await find(d)).content).toBe("src/keep.test.ts");
  });

  it("restricts to a subdirectory with workspace-relative output", async () => {
    const d = tmp();
    put(d, "a/x.test.ts", "b/y.test.ts");
    expect((await find(d, { path: "b" })).content).toBe("b/y.test.ts");
  });

  it("says so when nothing matches", async () => {
    const d = tmp();
    put(d, "src/a.ts");
    expect(await find(d)).toEqual({ content: "No test files found.", isError: false });
  });

  it("truncates at the result ceiling with a notice", async () => {
    const d = tmp();
    for (let i = 0; i < RESULT_CEILING + 3; i++) put(d, `t/f${String(i).padStart(4, "0")}.test.ts`);
    const lines = (await find(d)).content.split("\n");
    expect(lines).toHaveLength(RESULT_CEILING + 1);
    expect(lines.at(-1)).toMatch(/^\[Truncated at 200 files/);
  });

  it("errors on missing dir, file, ../ and symlink escape; does not follow symlinked dirs", async () => {
    const d = tmp();
    const outside = tmp();
    put(d, "f.txt");
    put(outside, "leak.test.ts");
    symlinkSync(outside, join(d, "link"));
    expect((await find(d, { path: "nope" })).content).toBe("Directory not found: nope");
    expect((await find(d, { path: "f.txt" })).content).toBe("Not a directory: f.txt");
    expect((await find(d, { path: "../" })).content).toMatch(/outside the workspace/);
    expect((await find(d, { path: "link" })).content).toMatch(/outside the workspace/);
    expect((await find(d)).content).toBe("No test files found.");
  });
});
