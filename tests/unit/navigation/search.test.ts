import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRg, rgMatches } from "../../../src/navigation/rg.js";
import { createSearchTool } from "../../../src/tools/search.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "search-"));
  dirs.push(d);
  return d;
};
function put(root: string, rel: string, body = "x") {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
}
const scriptDir = mkdtempSync(join(tmpdir(), "search-rg-")); // outlives afterEach cleanup
afterAll(() => rmSync(scriptDir, { recursive: true, force: true }));
let scripts = 0;
function script(body: string): string {
  const p = join(scriptDir, `rg${scripts++}`);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// Real ripgrep: a PATH rg if installed, else the Claude binary run as rg.
const claude = process.env.CLAUDE_CODE_EXECPATH;
const realRg = findRg() ?? (claude && existsSync(claude) ? script(`ARGV0=rg exec "${claude}" "$@"`) : null);

let ws: string;
beforeEach(() => {
  ws = tmp();
  put(ws, "src/b.ts", "const Needle = 1;\nother\n");
  put(ws, "src/a.ts", "// needle here\nneedle again\n");
  put(ws, "src/deep/c.js", "needle");
  put(ws, "README.md", "NEEDLE doc\n");
  put(ws, "node_modules/m.js", "needle");
  put(ws, "dist/o.js", "needle");
  put(ws, "app.min.js", "needle");
  put(ws, ".hidden/h.ts", "needle");
  put(ws, "bin.dat", "needle\0binary");
  put(ws, "needle-notes.txt", "nothing relevant");
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const run = (input: Record<string, unknown>, rgPath: string | null = null) =>
  createSearchTool(ws, { rgPath }).execute(input);

describe("search modes (built-in)", () => {
  it("content: ordered by path then line, excluded/minified/hidden/binary skipped", async () => {
    const r = await run({ query: "needle" });
    expect(r.content.split("\n")).toEqual([
      "README.md:1: NEEDLE doc",
      "src/a.ts:1: // needle here",
      "src/a.ts:2: needle again",
      "src/b.ts:1: const Needle = 1;",
      "src/deep/c.js:1: needle",
    ]);
  });

  it("filename: matches paths only, no line numbers", async () => {
    const r = await run({ query: "needle", mode: "filename" });
    expect(r.content).toBe("needle-notes.txt");
  });

  it("both: filename hits first, then content hits", async () => {
    const lines = (await run({ query: "needle", mode: "both" })).content.split("\n");
    expect(lines[0]).toBe("needle-notes.txt");
    expect(lines).toContain("src/a.ts:2: needle again");
    expect(lines).toHaveLength(6);
  });

  it("honors caseSensitive, filePattern, path and maxResults", async () => {
    expect((await run({ query: "Needle", caseSensitive: true })).content).toBe("src/b.ts:1: const Needle = 1;");
    expect((await run({ query: "needle", filePattern: "*.js" })).content).toBe("src/deep/c.js:1: needle");
    expect((await run({ query: "needle", path: "src/deep" })).content).toBe("src/deep/c.js:1: needle");
    const r = await run({ query: "needle", maxResults: 2 });
    expect(r.content).toBe("README.md:1: NEEDLE doc\nsrc/a.ts:1: // needle here\n[Results truncated at 2]");
  });

  it("keeps the 'No results found.' message and rejects a bad mode", async () => {
    expect((await run({ query: "zzz" })).content).toBe("No results found.");
    expect((await run({ query: "zzz", mode: "fuzzy" })).isError).toBe(true);
  });

  it("rejects ../ and symlink escape, errors on a missing path", async () => {
    const outside = tmp();
    symlinkSync(outside, join(ws, "link"));
    expect((await run({ query: "x", path: "../" })).content).toMatch(/outside the workspace/);
    expect((await run({ query: "x", path: "link" })).content).toMatch(/outside the workspace/);
    expect((await run({ query: "x", path: "nope" })).content).toBe("Path not found: nope");
  });

  it("respects .gitignore in a Git repo", async () => {
    execFileSync("git", ["init", "-q"], { cwd: ws });
    writeFileSync(join(ws, ".gitignore"), "src/deep/\n");
    expect((await run({ query: "needle", filePattern: "*.js" })).content).toBe("No results found.");
  });
});

describe("search rg parity (NFR-18)", () => {
  it.skipIf(!realRg)("real rg and built-in scan return identical output", async () => {
    // Guard against a vacuous pass: rg itself must work, not silently fall back.
    const direct = rgMatches(realRg!, [join(ws, "src/a.ts")], "needle", false, 10);
    expect(direct?.get(join(ws, "src/a.ts"))).toEqual([
      { line: 1, text: "// needle here" },
      { line: 2, text: "needle again" },
    ]);
    for (const input of [
      { query: "needle" },
      { query: "Needle", caseSensitive: true },
      { query: "needle", mode: "both" },
      { query: "needle", maxResults: 3 },
      { query: "needle", filePattern: "*.ts" },
      { query: "zzz" },
    ]) {
      expect((await run(input, realRg)).content, JSON.stringify(input)).toBe((await run(input, null)).content);
    }
  });

  it("falls back to the built-in scan when the rg executable fails", async () => {
    const broken = script("echo boom >&2; exit 2");
    expect((await run({ query: "needle" }, broken)).content).toBe((await run({ query: "needle" }, null)).content);
  });

  it("falls back when rg is not executable at all", async () => {
    expect((await run({ query: "needle" }, "/nonexistent/rg")).content).toContain("src/a.ts:2: needle again");
  });
});
