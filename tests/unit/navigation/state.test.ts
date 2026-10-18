import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerNavigationTools } from "../../../src/navigation/index.js";
import { createNavigationState, type SearchRecord } from "../../../src/navigation/state.js";
import { registerJavaScriptTypeScriptProviders } from "../../../src/navigation/symbols/languages/javascript-typescript.js";
import { registerPythonProvider } from "../../../src/navigation/symbols/languages/python.js";
import { clearSymbolProviders } from "../../../src/navigation/symbols/registry.js";
import { ToolRegistry } from "../../../src/tools/registry.js";

const dirs: string[] = [];
function workspace(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "navstate-"));
  dirs.push(d);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  return d;
}
const FILES = {
  "src/calc.ts": "export function add(a: number) { return a; }\nadd(1);\n",
  "src/util.py": "def helper():\n    pass\n",
  "src/notes.rb": "add here\n",
  "[slug].tsx": "export const x = 1;\n", // a name that looks like a truncation marker
  "tests/calc.test.ts": "x\n",
};

function setup() {
  const root = workspace(FILES);
  const dups: SearchRecord[] = [];
  const state = createNavigationState(root, (r) => dups.push({ ...r }));
  const registry = new ToolRegistry();
  registerNavigationTools(registry, root, state);
  const call = (name: string, input: Record<string, unknown> = {}) => registry.get(name)!.execute(input);
  return { root, state, registry, call, dups };
}

beforeEach(() => {
  clearSymbolProviders();
  registerJavaScriptTypeScriptProviders();
  registerPythonProvider();
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("registerNavigationTools", () => {
  it("registers list_directory, find_symbol and find_tests", () => {
    const { registry } = setup();
    expect(registry.definitions().map((d) => d.name).sort()).toEqual(["find_symbol", "find_tests", "list_directory"]);
  });

  it("returns exactly what the unwrapped tool returns", async () => {
    const { call } = setup();
    const r = await call("find_tests");
    expect(r).toEqual({ content: "tests/calc.test.ts", isError: false });
  });
});

describe("records discoveries from the real tools", () => {
  it("list_directory: explored dir and files, not directories", async () => {
    const { call, state } = setup();
    await call("list_directory", { path: "src" });
    expect([...state.exploredDirs]).toEqual(["src"]);
    expect([...state.files].sort()).toEqual(["src/calc.ts", "src/notes.rb", "src/util.py"]);
  });

  it("list_directory keeps a file named like a truncation marker, and ignores real markers", async () => {
    const { call, state } = setup();
    await call("list_directory");
    expect(state.files.has("[slug].tsx")).toBe(true);
    expect([...state.files].some((f) => f.startsWith("[Truncated"))).toBe(false);
  });

  it("find_tests: tests and files", async () => {
    const { call, state } = setup();
    await call("find_tests");
    expect([...state.tests]).toEqual(["tests/calc.test.ts"]);
    expect(state.files.has("tests/calc.test.ts")).toBe(true);
  });

  it("find_symbol: declarations as symbols, usages and text matches as references", async () => {
    const { call, state } = setup();
    await call("find_symbol", { symbol_name: "add" });
    expect([...state.symbols.values()]).toEqual([{ name: "add", kind: "function", path: "src/calc.ts", startLine: 1, endLine: 1 }]);
    expect([...state.references].sort()).toEqual(["src/calc.ts:2", "src/notes.rb:1"]); // usage + unsupported-language text hit
    expect([...state.files].sort()).toEqual(["src/calc.ts", "src/notes.rb"]);
  });

  it("an error result records the search but discovers nothing", async () => {
    const { call, state } = setup();
    await call("list_directory", { path: "missing" });
    expect(state.searches.size).toBe(1);
    expect(state.exploredDirs.size + state.files.size).toBe(0);
  });

  it("empty results add nothing", async () => {
    const { call, state } = setup();
    await call("find_symbol", { symbol_name: "nope" });
    await call("list_directory", { path: "src/empty-not-here" });
    expect(state.symbols.size + state.references.size + state.files.size).toBe(0);
  });
});

describe("repeats (FR-57)", () => {
  it("an identical search is recorded, reported, and still executed", async () => {
    const { call, state, dups } = setup();
    const first = await call("find_symbol", { symbol_name: "add" });
    const second = await call("find_symbol", { symbol_name: "add" });
    expect(second).toEqual(first); // executed, same real result
    expect(state.searches.size).toBe(1);
    expect([...state.searches.values()][0]).toMatchObject({ tool: "find_symbol", count: 2 });
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatchObject({ tool: "find_symbol", count: 2 });
  });

  it("a repeat is not blocked even when the file changed in between", async () => {
    const { call, root } = setup();
    await call("find_symbol", { symbol_name: "fresh" });
    writeFileSync(join(root, "src/new.ts"), "export const fresh = 1;\n");
    expect((await call("find_symbol", { symbol_name: "fresh" })).content).toContain("src/new.ts");
  });

  it("different arguments or tools are not repeats; key order and empty values are ignored", async () => {
    const { call, state, dups } = setup();
    await call("find_symbol", { symbol_name: "add" });
    await call("find_symbol", { symbol_name: "helper" });
    await call("find_symbol", { symbol_name: "add", path: "src" });
    await call("list_directory", { path: "src" });
    await call("list_directory", { path: "src", includeHidden: undefined });
    expect(state.searches.size).toBe(4);
    expect(dups).toHaveLength(1); // only the list_directory pair
  });

  it("argument order and empty-string values do not hide a repeat", async () => {
    const { call, state, dups } = setup();
    await call("find_symbol", { symbol_name: "add", path: "src" });
    await call("find_symbol", { path: "src", symbol_name: "add" });
    await call("find_symbol", { path: "src", symbol_name: "add", extra: "" });
    expect(state.searches.size).toBe(1);
    expect(dups).toHaveLength(2);
  });
});

describe("reset and persistence", () => {
  it("reset empties everything so a new task starts clean", async () => {
    const { call, state } = setup();
    await call("list_directory", { path: "src" });
    await call("find_symbol", { symbol_name: "add" });
    await call("find_tests");
    expect(state.files.size).toBeGreaterThan(0);
    state.reset();
    for (const c of [state.exploredDirs, state.files, state.tests, state.symbols, state.references, state.searches]) expect(c.size).toBe(0);
    // and a search after reset is first-time again, not a repeat
    await call("find_tests");
    expect([...state.searches.values()][0]!.count).toBe(1);
  });

  it("state.ts does not touch the filesystem (nothing persisted)", () => {
    const src = readFileSync("src/navigation/state.ts", "utf8");
    expect(src).not.toMatch(/node:fs|node:child_process|writeFile|localStorage/);
  });
});
