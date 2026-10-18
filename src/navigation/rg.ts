import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export interface LineHit {
  line: number;
  text: string;
}

/** First executable `rg` on PATH, or null. A shell function named rg is not an executable. */
export function findRg(pathEnv: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, process.platform === "win32" ? "rg.exe" : "rg");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

const CHUNK = 200; // keeps argv well under OS limits

/**
 * Line matches per file (absolute path), at most `maxPerFile` each. Returns null if rg
 * fails so the caller falls back to the built-in scan (NFR-18). rg only matches lines:
 * the file list, scope rules and ordering are decided by the caller.
 */
export function rgMatches(
  rgPath: string,
  files: string[],
  query: string,
  caseSensitive: boolean,
  maxPerFile: number,
): Map<string, LineHit[]> | null {
  const out = new Map<string, LineHit[]>();
  for (let i = 0; i < files.length; i += CHUNK) {
    const args = [
      "--no-config", "--no-messages", "--fixed-strings", "--line-number", "--with-filename",
      "--null", "--no-heading", "--color", "never", "--max-count", String(maxPerFile),
      caseSensitive ? "--case-sensitive" : "--ignore-case", "-e", query, "--", ...files.slice(i, i + CHUNK),
    ];
    const r = spawnSync(rgPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    for (const row of r.stdout.split("\n")) {
      const nul = row.indexOf("\0");
      if (nul < 0) continue;
      const m = /^(\d+):(.*)$/s.exec(row.slice(nul + 1));
      if (!m) continue;
      const file = row.slice(0, nul);
      const hits = out.get(file) ?? [];
      hits.push({ line: Number(m[1]), text: m[2] });
      out.set(file, hits);
    }
  }
  return out;
}
