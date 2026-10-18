import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { locateSymbols } from "../../../src/navigation/symbols/locator.js";
import { clearSymbolProviders, getProviderForExtension } from "../../../src/navigation/symbols/registry.js";
import { registerJavaScriptTypeScriptProviders } from "../../../src/navigation/symbols/languages/javascript-typescript.js";
import type { SymbolKind } from "../../../src/navigation/symbols/types.js";

const fx = (f: string) => `tests/fixtures/symbols/ts/${f}`;
const find = async (f: string, name: string, kind?: SymbolKind) =>
  (await locateSymbols(fx(f), readFileSync(fx(f), "utf8"), { name, kind }))!;

beforeAll(() => {
  clearSymbolProviders();
  registerJavaScriptTypeScriptProviders();
});

describe("registration", () => {
  it.each([".ts", ".tsx", ".js", ".jsx"])("%s has a provider", (ext) => {
    expect(getProviderForExtension(ext)).toBeDefined();
  });
});

describe("sample.ts declaration kinds and line ranges", () => {
  it.each<[string, SymbolKind, number, number]>([
    ["add", "function", 9, 11],
    ["localHelper", "function", 13, 17],
    ["Calculator", "class", 21, 31],
    ["handle", "method", 24, 24],
    ["run", "method", 28, 30],
    ["Shape", "class", 33, 35],
    ["area", "method", 34, 34],
    ["external", "function", 37, 37],
    ["multiply", "function", 42, 42],
    ["SCALE", "constant", 42, 42],
    ["counter", "variable", 43, 43],
    ["legacy", "variable", 44, 44],
    ["User", "interface", 48, 51],
    ["UserId", "type", 53, 53],
    ["Color", "type", 55, 58],
    ["Geometry", "module", 60, 64],
    ["default", "function", 66, 66],
  ])("%s is a %s at %i-%i", async (name, kind, start, end) => {
    const hits = await find("sample.ts", name, kind);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find((h) => h.startLine === start);
    expect(hit, `${name} @${start}`).toBeDefined();
    expect(hit!.endLine).toBe(end);
  });

  it("captures signature and docstring", async () => {
    const [add] = await find("sample.ts", "add");
    expect(add!.signature).toBe("export function add(a: number, b: number): number");
    expect(add!.docstring).toBe("Adds two numbers.\nReturns the sum.");
    const [user] = await find("sample.ts", "User");
    expect(user!.docstring).toBe("A user.");
  });

  it("ignores comments, string contents, locals and destructuring", async () => {
    for (const n of ["ghostLine", "GhostBlock", "fakeInString", "FakeClass", "insideLocal", "nestedFn", "d1", "d2"]) {
      expect(await find("sample.ts", n), n).toEqual([]);
    }
  });

  it("returns every overload", async () => {
    expect((await find("sample.ts", "overloaded")).map((h) => h.startLine)).toEqual([38, 39, 40]);
  });

  it("filters by kind", async () => {
    expect(await find("sample.ts", "add", "class")).toEqual([]);
  });
});

describe("sample.tsx and sample.js", () => {
  it("finds JSX-file declarations", async () => {
    expect((await find("sample.tsx", "Button"))[0]).toMatchObject({ kind: "function", startLine: 4, docstring: "Button component." });
    expect((await find("sample.tsx", "Panel"))[0]).toMatchObject({ kind: "function", startLine: 6, endLine: 8 });
    expect((await find("sample.tsx", "Widget"))[0]).toMatchObject({ kind: "class", startLine: 10, endLine: 14 });
    expect((await find("sample.tsx", "render"))[0]).toMatchObject({ kind: "method", startLine: 11, endLine: 13 });
  });

  it("finds JS declarations and ignores the comment", async () => {
    expect((await find("sample.js", "greet"))[0]).toMatchObject({ kind: "function", startLine: 3, endLine: 5, docstring: "Greets someone." });
    expect((await find("sample.js", "LIMIT"))[0]).toMatchObject({ kind: "constant", startLine: 7 });
    expect((await find("sample.js", "state"))[0]).toMatchObject({ kind: "variable", startLine: 8 });
    expect((await find("sample.js", "double"))[0]).toMatchObject({ kind: "function", startLine: 10 });
    expect((await find("sample.js", "Counter"))[0]).toMatchObject({ kind: "class", startLine: 12, endLine: 16 });
    expect((await find("sample.js", "inc"))[0]).toMatchObject({ kind: "method", startLine: 13, endLine: 15 });
    expect(await find("sample.js", "ghostLine")).toEqual([]);
  });
});
