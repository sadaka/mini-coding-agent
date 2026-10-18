import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locateSymbols } from "../../../src/navigation/symbols/locator.js";
import { clearSymbolProviders, registerSymbolProvider } from "../../../src/navigation/symbols/registry.js";
import { ensureGrammar, hasGrammarFor, loadLanguageFromFile, parseSource } from "../../../src/navigation/symbols/tree-sitter.js";
import type { SymbolProvider } from "../../../src/navigation/symbols/types.js";

const dir = mkdtempSync(join(tmpdir(), "ts-spike-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// DECISION-cf6c7e6b: this spike is the gate that web-tree-sitter and the grammar bundle work on this Node.
describe("grammar spike", () => {
  it.each([
    [".ts", "interface A { x: number }\nexport function f(a: string): number { return 1 }\nclass C { m() {} }\n", "interface_declaration"],
    [".tsx", "const X = () => <div className='a'/>;\n", "lexical_declaration"],
    [".js", "export default function g() {}\nconst h = () => 1;\n", "export_statement"],
    [".jsx", "const X = () => <div/>;\n", "lexical_declaration"],
    [".py", "class P:\n    def m(self):\n        pass\n\ndef top():\n    pass\n", "class_definition"],
  ])("%s sources load and parse without error", async (ext, src, firstNode) => {
    expect(hasGrammarFor(ext)).toBe(true);
    expect(await ensureGrammar(ext)).toBe(true);
    const tree = parseSource(ext, src)!;
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.child(0)!.type).toBe(firstNode);
  });

  it("a syntax error still yields a partial tree and does not throw", async () => {
    await ensureGrammar(".py");
    const tree = parseSource(".py", "def broken(:\n  pass\nclass Ok:\n  pass\n")!;
    expect(tree.rootNode.hasError).toBe(true);
    expect(tree.rootNode.descendantsOfType("class_definition").length).toBeGreaterThan(0);
  });

  it("an unsupported extension is a handled failure, not a crash", async () => {
    expect(hasGrammarFor(".rb")).toBe(false);
    expect(await ensureGrammar(".rb")).toBe(false);
    expect(await ensureGrammar("")).toBe(false);
    expect(parseSource(".rb", "puts 1")).toBeNull();
  });

  it("a missing or corrupt grammar file degrades to null", async () => {
    expect(await loadLanguageFromFile(join(dir, "nope.wasm"))).toBeNull();
    const bad = join(dir, "bad.wasm");
    writeFileSync(bad, "this is not wasm");
    expect(await loadLanguageFromFile(bad)).toBeNull();
    const truncated = join(dir, "trunc.wasm");
    writeFileSync(truncated, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    expect(await loadLanguageFromFile(truncated)).toBeNull();
  });
});

describe("locator", () => {
  const fake: SymbolProvider = {
    language: "fake",
    extensions: [".py"],
    findSymbols: (src, q) => (src.includes(q.name) ? [{ name: q.name, kind: "function", startLine: 1, endLine: 2, source: "tree-sitter" }] : []),
  };
  beforeEach(clearSymbolProviders);

  it("returns null with no provider so the caller can fall back to text", async () => {
    expect(await locateSymbols("a.py", "def f(): pass", { name: "f" })).toBeNull();
  });

  it("returns null for an extension with a provider but no grammar", async () => {
    registerSymbolProvider({ ...fake, extensions: [".rb"] });
    expect(await locateSymbols("a.rb", "def f; end", { name: "f" })).toBeNull();
  });

  it("fills in path and source, and distinguishes 'none found' ([]) from 'unavailable' (null)", async () => {
    registerSymbolProvider(fake);
    expect(await locateSymbols("pkg/a.py", "def calc(): pass", { name: "calc" })).toEqual([
      { name: "calc", kind: "function", startLine: 1, endLine: 2, path: "pkg/a.py", source: "tree-sitter" },
    ]);
    expect(await locateSymbols("pkg/a.py", "def other(): pass", { name: "calc" })).toEqual([]);
  });

  it("a throwing provider degrades to null", async () => {
    registerSymbolProvider({ ...fake, findSymbols: () => { throw new Error("boom"); } });
    expect(await locateSymbols("a.py", "x", { name: "f" })).toBeNull();
  });
});
