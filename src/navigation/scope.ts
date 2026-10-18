import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { open } from "node:fs/promises";

// `vendor/` is deliberately absent: its meaning differs by ecosystem (FR-42).
export const DEFAULT_EXCLUDED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".tmp",
  "temp",
] as const;

const MINIFIED = /\.min\.(js|css)$/;
const BINARY_SNIFF_BYTES = 8192;
export const BINARY_NOTICE = "binary file - content not displayed";

export interface RepositoryScope {
  readonly root: string;
  readonly excludedDirs: readonly string[];
  readonly isGitRepo: boolean;
  /** Default exclusions + minified files. Pure, no I/O. `rel` is workspace-relative. */
  isDefaultExcluded(rel: string): boolean;
  /** Subset of `rels` ignored by .gitignore (empty set outside a Git repo). */
  gitIgnored(rels: string[]): Set<string>;
  /** Drops default-excluded and git-ignored paths, keeps input order. */
  filter(rels: string[]): string[];
  /** Resolves `target` inside the workspace following symlinks; throws if it escapes. */
  resolveReal(target: string): string;
  isBinary(absPath: string): Promise<boolean>;
}

// NAV_EXCLUDE_DIRS (comma separated) replaces the default list.
export function createRepositoryScope(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): RepositoryScope {
  const absRoot = resolve(root);
  const realRoot = realpathSync(absRoot);
  const configured = env.NAV_EXCLUDE_DIRS?.split(",").map((s) => s.trim()).filter(Boolean);
  const excludedDirs = configured?.length ? configured : [...DEFAULT_EXCLUDED_DIRS];
  const excluded = new Set(excludedDirs);

  // ponytail: one git probe per scope, not per path; if git appears later in the task the
  // scope will not notice. Recreate the scope per task.
  const git = (args: string[], input?: string) =>
    spawnSync("git", ["-C", absRoot, ...args], { env, input, encoding: "utf8" });
  const probe = git(["rev-parse", "--is-inside-work-tree"]);
  const isGitRepo = !probe.error && probe.status === 0 && probe.stdout.trim() === "true";

  function isDefaultExcluded(rel: string): boolean {
    const parts = rel.split(/[\\/]/).filter(Boolean);
    return parts.some((p) => excluded.has(p)) || MINIFIED.test(parts[parts.length - 1] ?? "");
  }

  function gitIgnored(rels: string[]): Set<string> {
    if (!isGitRepo || rels.length === 0) return new Set();
    const r = git(["check-ignore", "-z", "--stdin"], rels.join("\0") + "\0");
    // exit 1 = nothing ignored; anything else non-zero = git failed, treat as not ignored.
    if (r.error || (r.status !== 0 && r.status !== 1)) return new Set();
    return new Set(r.stdout.split("\0").filter(Boolean));
  }

  function filter(rels: string[]): string[] {
    const kept = rels.filter((p) => !isDefaultExcluded(p));
    const ignored = gitIgnored(kept);
    return ignored.size ? kept.filter((p) => !ignored.has(p)) : kept;
  }

  function resolveReal(target: string): string {
    const abs = resolve(absRoot, target);
    const lexical = relative(absRoot, abs);
    if (lexical.startsWith("..") || isAbsolute(lexical)) {
      throw new Error(`Path is outside the workspace: ${target}`);
    }
    // Real path of the deepest existing ancestor, so not-yet-existing targets still work.
    let probePath = abs;
    while (!existsSync(probePath)) probePath = dirname(probePath);
    const realProbe = realpathSync(probePath);
    const rest = relative(probePath, abs);
    const real = rest ? resolve(realProbe, rest) : realProbe;
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`Path is outside the workspace: ${target}`);
    }
    return real;
  }

  async function isBinary(absPath: string): Promise<boolean> {
    const fh = await open(absPath, "r");
    try {
      const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  }

  return { root: absRoot, excludedDirs, isGitRepo, isDefaultExcluded, gitIgnored, filter, resolveReal, isBinary };
}
