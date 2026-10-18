import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENTRY_CEILING, createListDirectoryTool } from "../../../src/navigation/list-directory.js";
import { createRepositoryScope } from "../../../src/navigation/scope.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "listdir-"));
  dirs.push(d);
  return d;
}
function put(root: string, ...files: string[]) {
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "x");
  }
}
const list = (root: string, input: Record<string, unknown> = {}) =>
  createListDirectoryTool(createRepositoryScope(root)).execute(input);

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("list_directory", () => {
  it("lists in deterministic order, directories marked, default-excluded and hidden skipped", async () => {
    const d = tmp();
    put(d, "b.ts", "a.ts", "src/x.ts", "node_modules/m.js", ".env", "app.min.js");
    const r = await list(d);
    expect(r.isError).toBe(false);
    expect(r.content.split("\n")).toEqual(["a.ts", "b.ts", "src/"]);
  });

  it("includeHidden shows dotfiles but still excludes defaults", async () => {
    const d = tmp();
    put(d, ".env", "a.ts", ".git/config");
    expect((await list(d, { includeHidden: true })).content.split("\n")).toEqual([".env", "a.ts"]);
  });

  it("honours depth and clamps it", async () => {
    const d = tmp();
    put(d, "src/deep/f.ts", "src/g.ts");
    expect((await list(d, { depth: 1 })).content).toBe("src/");
    expect((await list(d, { depth: 2 })).content.split("\n")).toEqual(["src/", "src/deep/", "src/g.ts"]);
    expect((await list(d, { depth: 99 })).content).toContain("src/deep/f.ts");
    expect((await list(d, { depth: -3 })).content).toBe("src/");
  });

  it("respects .gitignore in a Git repo", async () => {
    const d = tmp();
    execFileSync("git", ["init", "-q"], { cwd: d });
    put(d, ".gitignore", "a.ts", "secret.txt");
    writeFileSync(join(d, ".gitignore"), "secret.txt\n");
    const r = await list(d, { includeHidden: true });
    expect(r.content.split("\n")).toEqual([".gitignore", "a.ts"]);
  });

  it("truncates at the entry ceiling with a notice", async () => {
    const d = tmp();
    for (let i = 0; i < ENTRY_CEILING + 5; i++) writeFileSync(join(d, `f${String(i).padStart(4, "0")}.txt`), "");
    const r = await list(d);
    expect(r.isError).toBe(false);
    const lines = r.content.split("\n");
    expect(lines.length).toBe(ENTRY_CEILING + 1);
    expect(lines.at(-1)).toMatch(/^\[Truncated at 500 entries/);
  });

  it("lists a subdirectory with workspace-relative paths", async () => {
    const d = tmp();
    put(d, "src/a.ts");
    expect((await list(d, { path: "src" })).content).toBe("src/a.ts");
  });

  it("errors clearly on missing dir, file, ../ escape and symlink escape", async () => {
    const d = tmp();
    const outside = tmp();
    put(d, "f.txt");
    symlinkSync(outside, join(d, "link"));
    expect(await list(d, { path: "nope" })).toMatchObject({ isError: true, content: "Directory not found: nope" });
    expect(await list(d, { path: "f.txt" })).toMatchObject({ isError: true, content: "Not a directory: f.txt" });
    expect(await list(d, { path: "../" })).toMatchObject({ isError: true });
    expect((await list(d, { path: "../" })).content).toMatch(/outside the workspace/);
    expect((await list(d, { path: "link" })).content).toMatch(/outside the workspace/);
  });

  it("lists a symlink but does not descend into it", async () => {
    const d = tmp();
    const outside = tmp();
    put(outside, "secret.txt");
    symlinkSync(outside, join(d, "link"));
    const r = await list(d, { depth: 3 });
    expect(r.content).toBe("link");
  });
});
