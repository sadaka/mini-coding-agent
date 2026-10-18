import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { locateSymbols } from "../../../src/navigation/symbols/locator.js";
import { clearSymbolProviders, getProviderForExtension } from "../../../src/navigation/symbols/registry.js";
import { registerPythonProvider } from "../../../src/navigation/symbols/languages/python.js";
import type { SymbolKind } from "../../../src/navigation/symbols/types.js";

const file = "tests/fixtures/symbols/python/sample.py";
const find = async (name: string, kind?: SymbolKind) =>
  (await locateSymbols(file, readFileSync(file, "utf8"), { name, kind }))!;

beforeAll(() => {
  clearSymbolProviders();
  registerPythonProvider();
});

it("is registered for .py", () => {
  expect(getProviderForExtension(".py")?.language).toBe("python");
});

describe("definitions and line ranges", () => {
  it.each<[string, SymbolKind, number, number]>([
    ["top", "function", 6, 13],
    ["inner", "function", 11, 12], // nested in a function
    ["fetch", "function", 16, 17], // async
    ["decorated", "function", 20, 22], // range includes the decorator
    ["Point", "class", 25, 44],
    ["__init__", "method", 31, 32],
    ["move", "method", 34, 37],
    ["helper", "function", 35, 36], // nested in a method is a function, not a method
    ["make", "method", 39, 41],
    ["Meta", "class", 43, 44], // nested class
  ])("%s is a %s at %i-%i", async (name, kind, start, end) => {
    const hits = await find(name);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind, startLine: start, endLine: end });
  });

  it("captures signature and dedented docstring", async () => {
    const [top] = await find("top");
    expect(top!.signature).toBe("def top(a, b=1) -> int");
    expect(top!.docstring).toBe("Adds things.\n\nSecond line.");
    expect((await find("Point"))[0]).toMatchObject({ signature: "class Point(Base)", docstring: "A point." });
    expect((await find("fetch"))[0]!.signature).toBe("async def fetch(url: str)");
    expect((await find("make"))[0]!.docstring).toBeUndefined();
  });

  it("filters by kind", async () => {
    expect(await find("Point", "function")).toEqual([]);
    expect(await find("move", "method")).toHaveLength(1);
  });
});

it("ignores comments, string contents, imports and plain assignments", async () => {
  for (const n of ["ghost_line", "ghost_docstring", "fake_in_string", "os", "decoy", "CONST"]) {
    expect(await find(n), n).toEqual([]);
  }
});
