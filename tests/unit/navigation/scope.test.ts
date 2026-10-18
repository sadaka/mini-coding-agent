import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BINARY_NOTICE, createRepositoryScope } from "../../../src/navigation/scope.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "scope-"));
  dirs.push(d);
  return d;
}
function gitRepo(): string {
  const d = tmp();
  execFileSync("git", ["init", "-q"], { cwd: d });
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("RepositoryScope defaults", () => {
  it("excludes the default directories at any depth, but not vendor", () => {
    const s = createRepositoryScope(tmp());
    for (const p of [".git/config", "node_modules/a.js", "dist/x.js", "build/x", "coverage/lcov", ".cache/x", ".tmp/x", "temp/x", "pkg/node_modules/y.js"]) {
      expect(s.isDefaultExcluded(p), p).toBe(true);
    }
    expect(s.isDefaultExcluded("vendor/lib.js")).toBe(false);
    expect(s.isDefaultExcluded("src/app.ts")).toBe(false);
  });

  it("excludes minified js/css but not look-alikes", () => {
    const s = createRepositoryScope(tmp());
    expect(s.isDefaultExcluded("web/app.min.js")).toBe(true);
    expect(s.isDefaultExcluded("web/site.min.css")).toBe(true);
    expect(s.isDefaultExcluded("web/admin.js")).toBe(false);
    expect(s.isDefaultExcluded("web/min.js")).toBe(false);
  });

  it("NAV_EXCLUDE_DIRS replaces the default list", () => {
    const s = createRepositoryScope(tmp(), { ...process.env, NAV_EXCLUDE_DIRS: "vendor, out" });
    expect(s.isDefaultExcluded("vendor/a.js")).toBe(true);
    expect(s.isDefaultExcluded("out/a.js")).toBe(true);
    expect(s.isDefaultExcluded("node_modules/a.js")).toBe(false);
  });
});

describe("RepositoryScope .gitignore handling", () => {
  it("filters git-ignored paths in a Git repo, keeps order, keeps tracked-looking files", () => {
    const d = gitRepo();
    writeFileSync(join(d, ".gitignore"), "secrets/\n*.log\n");
    mkdirSync(join(d, "secrets"));
    writeFileSync(join(d, "secrets", "k.txt"), "x");
    const s = createRepositoryScope(d);
    expect(s.isGitRepo).toBe(true);
    expect(s.filter(["src/b.ts", "secrets/k.txt", "run.log", "src/a.ts", "node_modules/z.js"])).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("handles paths with spaces and odd characters", () => {
    const d = gitRepo();
    writeFileSync(join(d, ".gitignore"), "my dir/\n");
    const s = createRepositoryScope(d);
    expect(s.filter(["my dir/a b.txt", "keep me.txt"])).toEqual(["keep me.txt"]);
  });

  it("outside a Git repo only the defaults apply and .gitignore is not read", () => {
    const d = tmp();
    writeFileSync(join(d, ".gitignore"), "secrets/\n");
    const s = createRepositoryScope(d);
    expect(s.isGitRepo).toBe(false);
    expect(s.filter(["secrets/k.txt", "dist/x.js", "src/a.ts"])).toEqual(["secrets/k.txt", "src/a.ts"]);
  });

  it("degrades to defaults when git is unavailable", () => {
    const d = gitRepo();
    writeFileSync(join(d, ".gitignore"), "secrets/\n");
    const s = createRepositoryScope(d, { PATH: "" });
    expect(s.isGitRepo).toBe(false);
    expect(s.filter(["secrets/k.txt", "dist/x.js"])).toEqual(["secrets/k.txt"]);
  });
});

describe("RepositoryScope binary detection", () => {
  it("flags a file with a NUL byte and not plain text", async () => {
    const d = tmp();
    writeFileSync(join(d, "a.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    writeFileSync(join(d, "a.txt"), "hello\nworld\n");
    writeFileSync(join(d, "empty.txt"), "");
    const s = createRepositoryScope(d);
    expect(await s.isBinary(join(d, "a.bin"))).toBe(true);
    expect(await s.isBinary(join(d, "a.txt"))).toBe(false);
    expect(await s.isBinary(join(d, "empty.txt"))).toBe(false);
  });

  it("exposes the exact notice text", () => {
    expect(BINARY_NOTICE).toBe("binary file - content not displayed");
  });
});

describe("RepositoryScope workspace boundary", () => {
  it("resolves inside paths, including ones that do not exist yet", () => {
    const d = tmp();
    mkdirSync(join(d, "src"));
    const s = createRepositoryScope(d);
    expect(s.resolveReal("src")).toMatch(/src$/);
    expect(s.resolveReal("src/new/file.ts")).toMatch(/src\/new\/file\.ts$/);
    expect(s.resolveReal(".")).toBe(s.resolveReal(""));
  });

  it("rejects lexical traversal and absolute outside paths", () => {
    const s = createRepositoryScope(tmp());
    expect(() => s.resolveReal("../etc/passwd")).toThrow(/outside the workspace/);
    expect(() => s.resolveReal("/etc/passwd")).toThrow(/outside the workspace/);
    expect(() => s.resolveReal("a/../../x")).toThrow(/outside the workspace/);
  });

  it("rejects a symlink that points outside, for files and directories", () => {
    const d = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(outside, join(d, "link"));
    symlinkSync(join(outside, "secret.txt"), join(d, "file-link"));
    const s = createRepositoryScope(d);
    expect(() => s.resolveReal("link")).toThrow(/outside the workspace/);
    expect(() => s.resolveReal("link/secret.txt")).toThrow(/outside the workspace/);
    expect(() => s.resolveReal("file-link")).toThrow(/outside the workspace/);
    expect(() => s.resolveReal("link/not-yet/created.txt")).toThrow(/outside the workspace/);
  });

  it("allows a symlink that stays inside the workspace", () => {
    const d = tmp();
    mkdirSync(join(d, "real"));
    writeFileSync(join(d, "real", "a.txt"), "x");
    symlinkSync(join(d, "real"), join(d, "alias"));
    const s = createRepositoryScope(d);
    expect(s.resolveReal("alias/a.txt")).toMatch(/real\/a\.txt$/);
  });

  it("does not treat a sibling directory with a shared prefix as inside", () => {
    const base = tmp();
    mkdirSync(join(base, "ws"));
    mkdirSync(join(base, "ws-evil"));
    const s = createRepositoryScope(join(base, "ws"));
    expect(() => s.resolveReal("../ws-evil/x")).toThrow(/outside the workspace/);
  });

  it("rejects a symlink to a sibling whose path merely shares the root prefix", () => {
    const base = tmp();
    mkdirSync(join(base, "ws"));
    mkdirSync(join(base, "ws-evil"));
    writeFileSync(join(base, "ws-evil", "x.txt"), "x");
    symlinkSync(join(base, "ws-evil"), join(base, "ws", "link"));
    const s = createRepositoryScope(join(base, "ws"));
    expect(() => s.resolveReal("link/x.txt")).toThrow(/outside the workspace/);
  });
});
