import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { Tool, ToolDefinition, ToolResult } from "../types/index.js";
import { findRg, rgMatches, type LineHit } from "./rg.js";
import { createRepositoryScope, type RepositoryScope } from "./scope.js";
import { locateSymbols } from "./symbols/locator.js";
import { getProviderForExtension } from "./symbols/registry.js";
import type { SymbolMatch } from "./symbols/types.js";

export const MAX_MATCHES = 50;
const MAX_HITS_PER_FILE = 50; // raw line hits per file before the word filter
const MAX_REFS = 5;
const MAX_LINE_CHARS = 300;
const MAX_SCAN_FILES = 20000;
const MAX_FILE_BYTES = 1024 * 1024;

const DEFINITION: ToolDefinition = {
  name: "find_symbol",
  description:
    "Find where a symbol (function, class, method, type, variable) is defined. Supported languages are parsed (source 'tree-sitter'); " +
    "elsewhere, or when parsing finds nothing, whole-word text matches are returned (source 'text-search') and are NOT confirmed declarations. " +
    "'tree-sitter+text-search' means a parsed declaration that is also referenced elsewhere in its file (see 'also on lines'). " +
    "Ignored, generated, hidden, minified and binary files are skipped. Paths and line numbers can be passed to read_file.",
  inputSchema: {
    type: "object",
    properties: {
      symbol_name: { type: "string", description: "Exact symbol name (case-sensitive)" },
      path: { type: "string", description: "Subdirectory or file to search in (optional, defaults to workspace root)" },
    },
    required: ["symbol_name"],
  },
};

type Result = { path: string; line: number; text: string };
type Row = Omit<SymbolMatch, "path"> & { path: string; refs?: number[] };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ponytail: collectFiles/textFiles/scanMatches mirror src/tools/search.ts (kept out of that file by task scope).
// If the scope rules there change, change them here too; extract a shared module when a task allows touching both.

/** Sorted, scope-filtered candidate files (absolute paths). */
async function collectFiles(scope: RepositoryScope, start: string): Promise<{ files: string[]; capped: boolean }> {
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
      } else if (e.isFile()) {
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

/** Drops binary, oversized and unreadable files. */
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

/** Built-in case-sensitive substring scan, used when rg is missing or fails. */
async function scanMatches(files: string[], query: string, maxPerFile: number) {
  const out = new Map<string, LineHit[]>();
  for (const f of files) {
    const text = await readFile(f, "utf8").catch(() => null);
    if (text === null) continue;
    const hits: LineHit[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < maxPerFile; i++) {
      if (lines[i].includes(query)) hits.push({ line: i + 1, text: lines[i] });
    }
    if (hits.length) out.set(f, hits);
  }
  return out;
}

/** `rgPath`: undefined = look for rg on PATH, null = force the built-in scan. */
export function createFindSymbolTool(workspaceRoot: string, opts: { rgPath?: string | null } = {}): Tool {
  return {
    definition: DEFINITION,
    async execute(input): Promise<ToolResult> {
      const name = String(input.symbol_name ?? "").trim();
      if (!name) return { content: "symbol_name is required.", isError: true };
      const subPath = input.path ? String(input.path) : ".";

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
      if (s.isDirectory()) ({ files, capped } = await collectFiles(scope, resolve(workspaceRoot, subPath)));
      else files = [resolve(workspaceRoot, subPath)];

      const candidates = await textFiles(scope, files);
      const rg = opts.rgPath === undefined ? findRg() : opts.rgPath;
      // rg failing for any reason falls back to the built-in scan (NFR-18).
      const raw =
        (rg && rgMatches(rg, candidates, name, true, MAX_HITS_PER_FILE)) ||
        (await scanMatches(candidates, name, MAX_HITS_PER_FILE));
      const word = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`);

      const rows: Row[] = [];
      for (const f of candidates) {
        const hits = (raw.get(f) ?? []).filter((h) => word.test(h.text));
        if (!hits.length) continue; // a declaration always contains its own name
        const path = relative(workspaceRoot, f);

        let structural: SymbolMatch[] | null = null;
        if (getProviderForExtension(extname(f))) {
          const source = await readFile(f, "utf8").catch(() => null);
          if (source !== null) structural = await locateSymbols(path, source, { name });
        }

        if (structural?.length) {
          for (const m of structural) {
            const refs = hits.map((h) => h.line).filter((l) => !structural!.some((d) => l >= d.startLine && l <= d.endLine));
            rows.push(refs.length ? { ...m, source: "tree-sitter+text-search", refs } : m);
          }
        } else {
          for (const h of hits) rows.push({ name, kind: "unknown", path, startLine: h.line, endLine: h.line, signature: h.text.trim().slice(0, MAX_LINE_CHARS), source: "text-search" });
        }
      }

      if (rows.length === 0) return { content: `No symbol or text matches found for "${name}".`, isError: false };

      rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine));
      const shown = rows.slice(0, MAX_MATCHES);
      const lines = shown.map((r) => {
        if (r.source === "text-search") return `${r.path}:${r.startLine}: ${r.signature} [text-search, not a confirmed declaration]`;
        const head = `${r.path}:${r.startLine}-${r.endLine} ${r.kind} ${r.name} [${r.source}]`;
        const doc = r.docstring ? `\n  ${r.docstring.split("\n")[0]}` : "";
        const refs = r.refs ? `\n  also on lines: ${r.refs.slice(0, MAX_REFS).join(", ")}${r.refs.length > MAX_REFS ? ", ..." : ""}` : "";
        return `${head}\n  ${r.signature ?? ""}${doc}${refs}`;
      });
      let note = rows.length > MAX_MATCHES ? `\n[Results truncated at ${MAX_MATCHES} of ${rows.length}]` : "";
      if (capped) note += "\n[Scan stopped at file limit - narrow the path]";
      return { content: lines.join("\n") + note, isError: false };
    },
  };
}
