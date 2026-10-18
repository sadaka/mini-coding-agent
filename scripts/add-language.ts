// npm run add-language <name> [.ext]  -- scaffolds a symbol provider; it does not implement language semantics (FR-55).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LANG_DIR = join(ROOT, "src/navigation/symbols/languages");
const INDEX = join(LANG_DIR, "index.ts");
const IMPORTS_MARK = "// add-language:imports";
const CALLS_MARK = "  // add-language:calls";

const SEED = `import { registerJavaScriptTypeScriptProviders } from "./javascript-typescript.js";
import { registerPythonProvider } from "./python.js";
${IMPORTS_MARK}

/** Registers every symbol provider. Call once at startup. \`npm run add-language\` appends to this file. */
export function registerAllLanguages(): void {
  registerJavaScriptTypeScriptProviders();
  registerPythonProvider();
${CALLS_MARK}
}
`;

const fail = (msg: string): never => {
  console.error(`add-language: ${msg}`);
  process.exit(1);
};

const [name = "", extArg] = process.argv.slice(2);
if (!/^[a-z][a-z0-9]{0,29}$/.test(name)) {
  fail(`invalid name "${name}": use 1-30 lowercase letters/digits starting with a letter (e.g. java, go, csharp)`);
}
const ext = (extArg ?? `.${name}`).toLowerCase();
if (!/^\.[a-z0-9]{1,10}$/.test(ext)) fail(`invalid extension "${ext}": e.g. .java`);

const Pascal = name[0]!.toUpperCase() + name.slice(1);
const providerFile = join(LANG_DIR, `${name}.ts`);
const testFile = join(ROOT, `tests/unit/navigation/${name}-provider.test.ts`);
const fixtureFile = join(ROOT, `tests/fixtures/symbols/${name}/Sample${ext}`);

for (const f of [providerFile, testFile, fixtureFile]) {
  if (existsSync(f)) fail(`${f.slice(ROOT.length + 1)} already exists; refusing to overwrite`);
}
if (existsSync(INDEX) && readFileSync(INDEX, "utf8").includes(`./${name}.js`)) fail(`"${name}" is already registered in languages/index.ts`);

// Extension clash: ask the registry, seeded exactly as production registers it.
const registry = await import(pathToFileURL(join(ROOT, "src/navigation/symbols/registry.ts")).href);
const all = await import(pathToFileURL(existsSync(INDEX) ? INDEX : join(LANG_DIR, "python.ts")).href);
registry.clearSymbolProviders();
if (existsSync(INDEX)) all.registerAllLanguages();
else {
  (await import(pathToFileURL(join(LANG_DIR, "javascript-typescript.ts")).href)).registerJavaScriptTypeScriptProviders();
  all.registerPythonProvider();
}
const taken = registry.getProviderForExtension(ext);
if (taken) fail(`extension ${ext} is already handled by the ${taken.language} provider`);

const write = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

write(providerFile, `import { registerSymbolProvider } from "../registry.js";
import type { SymbolProvider } from "../types.js";

// TODO(add-language): implement extraction. Use parseSource(\"${ext}\", source) from ../tree-sitter.js and walk the
// tree like python.ts does. Until then the provider finds nothing and find_symbol falls back to text search.
export const ${name}Provider: SymbolProvider = {
  language: "${name}",
  extensions: ["${ext}"],
  findSymbols: () => [],
};

/** Registered by languages/index.ts. Throws if ${ext} is already taken (registry contract). */
export function register${Pascal}Provider(): void {
  registerSymbolProvider(${name}Provider);
}
`);

write(fixtureFile, `// TODO(add-language): replace with real ${name} source covering each declaration kind,\n// plus comment/string decoys that must NOT be reported as symbols.\n`);

write(testFile, `import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { clearSymbolProviders, getProviderForExtension } from "../../../src/navigation/symbols/registry.js";
import { registerAllLanguages } from "../../../src/navigation/symbols/languages/index.js";

const fixture = "tests/fixtures/symbols/${name}/Sample${ext}";

beforeAll(() => {
  clearSymbolProviders();
  registerAllLanguages();
});

describe("${name} provider", () => {
  it("is registered for ${ext}", () => {
    expect(getProviderForExtension("${ext}")?.language).toBe("${name}");
  });

  it("has a fixture", () => {
    expect(readFileSync(fixture, "utf8").length).toBeGreaterThan(0);
  });

  it.todo("finds each declaration kind with correct start/end lines in the fixture");
  it.todo("ignores symbol-like text in comments and strings");
});
`);

const idx = existsSync(INDEX) ? readFileSync(INDEX, "utf8") : SEED;
if (!idx.includes(IMPORTS_MARK) || !idx.includes(CALLS_MARK)) fail("languages/index.ts lost its add-language markers; add them back");
write(
  INDEX,
  idx
    .replace(IMPORTS_MARK, `import { register${Pascal}Provider } from "./${name}.js";\n${IMPORTS_MARK}`)
    .replace(CALLS_MARK, `  register${Pascal}Provider();\n${CALLS_MARK}`),
);

console.log(`Created:\n  ${providerFile.slice(ROOT.length + 1)}\n  ${fixtureFile.slice(ROOT.length + 1)}\n  ${testFile.slice(ROOT.length + 1)}\nRegistered in: ${INDEX.slice(ROOT.length + 1)}\n`);

const run = (label: string, args: string[]) => {
  console.log(`> ${label}`);
  const r = spawnSync("npx", args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) fail(`${label} failed (scaffold files were left in place)`);
};
run("tsc --noEmit", ["tsc", "--noEmit"]);
run(`vitest run ${name}-provider`, ["vitest", "run", `tests/unit/navigation/${name}-provider.test.ts`]);

const wasm = join(ROOT, `node_modules/tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
console.log(`\nRemaining TODOs:
  1. Grammar: ${existsSync(wasm) ? `tree-sitter-wasms ships tree-sitter-${name}.wasm; add "${ext}": "${name}" to GRAMMAR_BY_EXT in src/navigation/symbols/tree-sitter.ts` : `no tree-sitter-${name}.wasm in tree-sitter-wasms; pick a grammar source or accept text-search only`}
  2. Write real fixture content in tests/fixtures/symbols/${name}/Sample${ext}
  3. Implement findSymbols in src/navigation/symbols/languages/${name}.ts
  4. Replace the it.todo cases in tests/unit/navigation/${name}-provider.test.ts with real assertions
  5. Call registerAllLanguages() at startup (nothing calls it yet)`);
