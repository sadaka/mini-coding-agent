import { beforeEach, describe, expect, it } from "vitest";
import { clearSymbolProviders, getProviderForExtension, registerSymbolProvider } from "../../../src/navigation/symbols/registry.js";
import type { SymbolProvider } from "../../../src/navigation/symbols/types.js";

const provider = (language: string, extensions: string[]): SymbolProvider => ({ language, extensions, findSymbols: () => [] });

beforeEach(clearSymbolProviders);

describe("symbol provider registry", () => {
  it("returns the provider registered for each of its extensions", () => {
    const ts = provider("ts", [".ts", ".tsx"]);
    registerSymbolProvider(ts);
    expect(getProviderForExtension(".ts")).toBe(ts);
    expect(getProviderForExtension(".tsx")).toBe(ts);
  });

  it("returns no provider for an unsupported or empty extension", () => {
    registerSymbolProvider(provider("py", [".py"]));
    expect(getProviderForExtension(".rb")).toBeUndefined();
    expect(getProviderForExtension("")).toBeUndefined();
  });

  it("rejects a duplicate extension and leaves the registry unchanged", () => {
    const a = provider("a", [".js"]);
    registerSymbolProvider(a);
    expect(() => registerSymbolProvider(provider("b", [".ts", ".js"]))).toThrow(/already registered for \.js \(a\)/);
    expect(getProviderForExtension(".js")).toBe(a);
    expect(getProviderForExtension(".ts")).toBeUndefined(); // no partial registration
  });

  it("is case-insensitive and tolerates a missing leading dot", () => {
    const p = provider("py", ["PY"]);
    registerSymbolProvider(p);
    expect(getProviderForExtension(".py")).toBe(p);
    expect(getProviderForExtension("Py")).toBe(p);
    expect(() => registerSymbolProvider(provider("other", [".PY"]))).toThrow(/already registered/);
  });
});
