import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Tool, ToolDefinition, ToolResult } from "../types/index.js";
import { findRg, rgMatches, type LineHit } from "../navigation/rg.js";
import { createRepositoryScope, type RepositoryScope } from "../navigation/scope.js";

const MAX_RESULTS = 50;
const MAX_SCAN_FILES = 20000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 300;
const MODES = ["content", "filename", "both"] as const;
type Mode = (typeof MODES)[number];

const DEFINITION: ToolDefinition = {
  name: "search",
  description:
    "Search the workspace. mode 'content' (default) returns file:line: text for lines containing the query; " +
    "'filename' returns paths containing the query; 'both' returns filename matches then content matches. " +
    "Ignored, generated, hidden, minified and binary files are skipped. Results are ordered by path then line.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for" },
      mode: { type: "string", enum: [...MODES], description: "content (default), filename or both" },
      path: { type: "string", description: "Subdirectory to search in (optional, defaults to workspace root)" },
      filePattern: { type: "string", description: "Glob-style file extension filter, e.g. '*.ts' (optional)" },
      caseSensitive: { type: "boolean", description: "Case-sensitive search (default false)" },
      maxResults: { type: "number", description: `Maximum results to return (default ${MAX_RESULTS})` },
    },
    required: ["query"],
  },
};

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
  return name === pattern;
}

/** Sorted, scope-filtered, text-only candidate files (absolute paths). Same input for rg and built-in. */
async function collectFiles(
  scope: RepositoryScope,
  start: string,
  pattern: string | undefined,
): Promise<{ files: string[]; capped: boolean }> {
  const files: string[] = [];
  let capped = false;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    const visible = entries.filter((e) => !e.name.startsWith("."));
    const kept = new Set(scope.filter(visible.map((e) => relative(scope.root, join(dir, e.name)))));
    for (const e of visible) {
      const full = join(dir, e.name);
      if (!kept.has(relative(scope.root, full))) continue;
      if (capped) return;
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && (!pattern || matchesPattern(e.name, pattern))) {
        if (files.length >= MAX_SCAN_FILES) {
          capped = true;
          return;
        }
        files.push(full);
      }
    }
  }

  await walk(start);
  return { files, capped };
}

async function textFiles(scope: RepositoryScope, files: string[]): Promise<string[]> {
  const ok: string[] = [];
  for (const f of files) {
    try {
      if ((await stat(f)).size > MAX_FILE_BYTES || (await scope.isBinary(f))) continue;
      ok.push(f);
    } catch {
      /* unreadable: skip */
    }
  }
  return ok;
}

async function scanMatches(files: string[], query: string, caseSensitive: boolean, maxPerFile: number) {
  const out = new Map<string, LineHit[]>();
  const needle = caseSensitive ? query : query.toLowerCase();
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(f, "utf8");
    } catch {
      continue;
    }
    const hits: LineHit[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < maxPerFile; i++) {
      if ((caseSensitive ? lines[i] : lines[i].toLowerCase()).includes(needle)) hits.push({ line: i + 1, text: lines[i] });
    }
    if (hits.length) out.set(f, hits);
  }
  return out;
}

/** `rgPath`: undefined = look for rg on PATH, null = force the built-in scan. */
export function createSearchTool(workspaceRoot: string, opts: { rgPath?: string | null } = {}): Tool {
  return {
    definition: DEFINITION,
    async execute(input): Promise<ToolResult> {
      const query = String(input.query ?? "");
      const subPath = input.path ? String(input.path) : ".";
      const filePattern = input.filePattern ? String(input.filePattern) : undefined;
      const caseSensitive = Boolean(input.caseSensitive ?? false);
      const maxResults = Math.min(Number(input.maxResults ?? MAX_RESULTS), MAX_RESULTS);
      const mode = String(input.mode ?? "content") as Mode;
      if (!MODES.includes(mode)) {
        return { content: `Invalid mode: ${mode}. Use content, filename or both.`, isError: true };
      }

      const scope = createRepositoryScope(workspaceRoot);
      let real: string;
      try {
        real = scope.resolveReal(subPath);
      } catch (err) {
        return { content: String(err instanceof Error ? err.message : err), isError: true };
      }
      const s = await stat(real).catch(() => null);
      if (!s) return { content: `Path not found: ${subPath}`, isError: true };

      let files: string[];
      let capped = false;
      if (s.isDirectory()) {
        ({ files, capped } = await collectFiles(scope, resolve(workspaceRoot, subPath), filePattern));
      } else {
        files = [resolve(workspaceRoot, subPath)];
      }

      const rel = (f: string) => relative(workspaceRoot, f);
      const hits: string[] = [];

      if (mode !== "content") {
        const n = caseSensitive ? query : query.toLowerCase();
        for (const f of files) {
          if (hits.length >= maxResults) break;
          if ((caseSensitive ? rel(f) : rel(f).toLowerCase()).includes(n)) hits.push(rel(f));
        }
      }

      if (mode !== "filename" && hits.length < maxResults) {
        const candidates = await textFiles(scope, files);
        const remaining = maxResults - hits.length;
        const rg = opts.rgPath === undefined ? findRg() : opts.rgPath;
        // rg failing for any reason falls back to the built-in scan (NFR-18).
        const found =
          (rg && rgMatches(rg, candidates, query, caseSensitive, remaining)) ||
          (await scanMatches(candidates, query, caseSensitive, remaining));
        outer: for (const f of candidates) {
          for (const h of found.get(f) ?? []) {
            hits.push(`${rel(f)}:${h.line}: ${h.text.trim().slice(0, MAX_LINE_CHARS)}`);
            if (hits.length >= maxResults) break outer;
          }
        }
      }

      if (hits.length === 0) return { content: "No results found.", isError: false };
      let note = hits.length >= maxResults ? `\n[Results truncated at ${maxResults}]` : "";
      if (capped) note += `\n[Scan stopped at ${MAX_SCAN_FILES} files - narrow the path]`;
      return { content: hits.join("\n") + note, isError: false };
    },
  };
}
