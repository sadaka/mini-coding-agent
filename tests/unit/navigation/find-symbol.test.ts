import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_MATCHES, createFindSymbolTool } from "../../../src/navigation/find-symbol.js";
import { registerJavaScriptTypeScriptProviders } from "../../../src/navigation/symbols/languages/javascript-typescript.js";
import { registerPythonProvider } from "../../../src/navigation/symbols/languages/python.js";
import { clearSymbolProviders, registerSymbolProvider } from "../../../src/navigation/symbols/registry.js";
import { findRg } from "../../../src/navigation/rg.js";

const dirs: string[] = [];
function workspace(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "findsym-"));
  dirs.push(d);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  return d;
}
const find = async (root: string, symbol_name: string, path?: string, rgPath: string | null = null) =>
  (await createFindSymbolTool(root, { rgPath }).execute({ symbol_name, ...(path ? { path } : {}) })).content;

beforeEach(() => {
  clearSymbolProviders();
  registerJavaScriptTypeScriptProviders();
  registerPythonProvider();
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("source labels", () => {
  it("tree-sitter for a declaration in a supported language", async () => {
    const root = workspace({ "a.ts": "/** Does it. */\nexport function compute(x: number) {\n  return x;\n}\n" });
    const out = await find(root, "compute");
    expect(out).toContain("a.ts:2-4 function compute [tree-sitter]");
    expect(out).toContain("export function compute(x: number)");
    expect(out).toContain("Does it.");
    expect(out).not.toContain("text-search");
  });

  it("tree-sitter for Python, including a method", async () => {
    const root = workspace({ "m.py": "class K:\n    def run(self):\n        pass\n" });
    expect(await find(root, "run")).toContain("m.py:2-3 method run [tree-sitter]");
  });

  it("text-search for an unsupported language, never called a declaration", async () => {
    const root = workspace({ "a.rb": "class Widget\n  def build\n  end\nend\n" });
    const out = await find(root, "Widget");
    expect(out).toContain("a.rb:1: class Widget [text-search, not a confirmed declaration]");
    expect(out).not.toContain("[tree-sitter"); // and no kind/range column, unlike a structural row
    expect(out).not.toMatch(/a\.rb:\d+-\d+/);
  });

  it("tree-sitter+text-search when the declaration is also referenced in its file", async () => {
    const root = workspace({ "a.ts": "export function used() {}\n\nused();\nused();\n" });
    const out = await find(root, "used");
    expect(out).toContain("a.ts:1-1 function used [tree-sitter+text-search]");
    expect(out).toContain("also on lines: 3, 4");
  });

  it("a recursive call inside the declaration does not count as an outside reference", async () => {
    const root = workspace({ "a.ts": "function fact(n: number): number {\n  return n ? n * fact(n - 1) : 1;\n}\n" });
    expect(await find(root, "fact")).toContain("[tree-sitter]");
  });

  it("falls back to text-search when a supported file has the word only in a comment or string", async () => {
    const root = workspace({ "a.ts": "// ghost is mentioned here\nconst s = 'ghost';\n" });
    const out = await find(root, "ghost");
    expect(out).toContain("a.ts:1:");
    expect(out).toContain("a.ts:2:");
    expect(out).not.toContain("[tree-sitter");
  });

  it("mixes labels across files and sorts by path then line", async () => {
    const root = workspace({
      "b.rb": "def thing; end\n",
      "a.ts": "export class thing {}\n",
      "c.py": "def thing():\n    pass\n",
    });
    const out = await find(root, "thing");
    expect(out.indexOf("a.ts")).toBeLessThan(out.indexOf("b.rb"));
    expect(out.indexOf("b.rb")).toBeLessThan(out.indexOf("c.py"));
    expect(out).toContain("a.ts:1-1 class thing [tree-sitter]");
    expect(out).toContain("b.rb:1: def thing; end [text-search");
    expect(out).toContain("c.py:1-2 function thing [tree-sitter]");
  });

  it("returns every overload / duplicate definition as separate matches", async () => {
    const root = workspace({ "a.ts": "function dup(a: string): void;\nfunction dup(a: number): void;\nfunction dup(a: any) {}\n" });
    const out = await find(root, "dup");
    expect(out.match(/\[tree-sitter\]/g)).toHaveLength(3);
  });
});

describe("grammar failure still returns text matches (NFR-18)", () => {
  it("provider whose parse throws", async () => {
    clearSymbolProviders();
    registerSymbolProvider({ language: "ts", extensions: [".ts"], findSymbols: () => { throw new Error("boom"); } });
    const root = workspace({ "a.ts": "export function broken() {}\n" });
    const out = await find(root, "broken");
    expect(out).toContain("a.ts:1: export function broken() {} [text-search");
  });

  it("provider whose extension has no grammar", async () => {
    clearSymbolProviders();
    registerSymbolProvider({ language: "zz", extensions: [".zz"], findSymbols: () => [] });
    const root = workspace({ "a.zz": "sym here\n" });
    expect(await find(root, "sym")).toContain("a.zz:1: sym here [text-search");
  });
});

describe("matching rules", () => {
  it("matches whole words only and is case-sensitive", async () => {
    const root = workspace({ "a.rb": "address = 1\nadd = 2\nAdd = 3\nx.add(1)\n$add = 4\n" });
    const out = await find(root, "add");
    expect(out).toContain("a.rb:2:");
    expect(out).toContain("a.rb:4:");
    for (const bad of ["a.rb:1:", "a.rb:3:", "a.rb:5:"]) expect(out).not.toContain(bad);
  });

  it("names with regex metacharacters are literal", async () => {
    const root = workspace({ "a.js": "const $el = 1;\nconst xel = 2;\n" });
    const out = await find(root, "$el");
    expect(out).toContain("a.js:1-1 constant $el");
    expect(out).not.toContain("xel");
  });

  it("clear not-found result", async () => {
    const root = workspace({ "a.ts": "export const x = 1;\n" });
    const r = await createFindSymbolTool(root, { rgPath: null }).execute({ symbol_name: "nope" });
    expect(r).toEqual({ content: 'No symbol or text matches found for "nope".', isError: false });
  });

  it("empty symbol_name is an error", async () => {
    const root = workspace({});
    expect((await createFindSymbolTool(root).execute({ symbol_name: "  " })).isError).toBe(true);
  });
});

describe("scope and path", () => {
  const files = { "src/a.ts": "export function pick() {}\n", "lib/b.ts": "export function pick() {}\n" };

  it("path restricts to a directory", async () => {
    const out = await find(workspace(files), "pick", "lib");
    expect(out).toContain("lib/b.ts");
    expect(out).not.toContain("src/a.ts");
  });

  it("path may be a single file", async () => {
    const out = await find(workspace(files), "pick", "src/a.ts");
    expect(out).toContain("src/a.ts");
    expect(out).not.toContain("lib/b.ts");
  });

  it("rejects a missing path and a path outside the workspace", async () => {
    const root = workspace(files);
    const tool = createFindSymbolTool(root, { rgPath: null });
    expect(await tool.execute({ symbol_name: "pick", path: "nope" })).toMatchObject({ isError: true });
    expect(await tool.execute({ symbol_name: "pick", path: "../.." })).toMatchObject({ isError: true });
  });

  it("skips excluded dirs, hidden dirs, minified and binary files", async () => {
    const root = workspace({
      "src/a.ts": "export function pick() {}\n",
      "node_modules/pkg/i.js": "function pick() {}\n",
      "dist/o.js": "function pick() {}\n",
      ".hidden/h.ts": "function pick() {}\n",
      "src/app.min.js": "function pick() {}\n",
      "src/bin.dat": "pick\0pick",
    });
    const out = await find(root, "pick");
    expect(out).toContain("src/a.ts");
    for (const bad of ["node_modules", "dist", ".hidden", "min.js", "bin.dat"]) expect(out).not.toContain(bad);
  });
});

describe("bounds", () => {
  it("caps results and says so", async () => {
    const root = workspace(Object.fromEntries(Array.from({ length: MAX_MATCHES + 10 }, (_, i) => [`f${String(i).padStart(3, "0")}.rb`, "target\n"])));
    const out = await find(root, "target");
    expect(out.match(/\[text-search/g)).toHaveLength(MAX_MATCHES);
    expect(out).toContain(`[Results truncated at ${MAX_MATCHES} of ${MAX_MATCHES + 10}]`);
  });
});

describe.skipIf(!findRg())("rg and built-in agree", () => {
  it("same output either way", async () => {
    const root = workspace({ "a.ts": "export function same() {}\nsame();\n", "b.rb": "same\n" });
    expect(await find(root, "same", undefined, findRg())).toBe(await find(root, "same", undefined, null));
  });
});

it("a failing rg falls back to the built-in scan (NFR-18)", async () => {
  const root = workspace({ "a.rb": "needle\n", "fake-rg": "#!/bin/sh\nexit 2\n" });
  chmodSync(join(root, "fake-rg"), 0o755);
  expect(await find(root, "needle", "a.rb", join(root, "fake-rg"))).toContain("a.rb:1: needle [text-search");
});
