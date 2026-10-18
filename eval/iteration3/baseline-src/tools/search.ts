import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Tool, ToolDefinition, ToolResult } from "../types/index.js";
import { resolveInWorkspace } from "./workspace.js";

const MAX_RESULTS = 50;
const DEFINITION: ToolDefinition = {
  name: "search",
  description:
    "Search for files or code within the workspace by text query. Returns file path, line number, and matching text.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for" },
      path: { type: "string", description: "Subdirectory to search in (optional, defaults to workspace root)" },
      filePattern: { type: "string", description: "Glob-style file extension filter, e.g. '*.ts' (optional)" },
      caseSensitive: { type: "boolean", description: "Case-sensitive search (default false)" },
      maxResults: { type: "number", description: `Maximum results to return (default ${MAX_RESULTS})` },
    },
    required: ["query"],
  },
};

async function walk(dir: string, pattern: string | undefined, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, pattern, results);
    } else if (!pattern || matchesPattern(entry.name, pattern)) {
      results.push(full);
    }
  }
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
  return name === pattern;
}

export function createSearchTool(workspaceRoot: string): Tool {
  return {
    definition: DEFINITION,
    async execute(input): Promise<ToolResult> {
      const query = String(input.query ?? "");
      const subPath = input.path ? String(input.path) : ".";
      const filePattern = input.filePattern ? String(input.filePattern) : undefined;
      const caseSensitive = Boolean(input.caseSensitive ?? false);
      const maxResults = Math.min(Number(input.maxResults ?? MAX_RESULTS), MAX_RESULTS);

      let searchRoot: string;
      try {
        searchRoot = resolveInWorkspace(workspaceRoot, subPath);
      } catch (err) {
        return { content: String(err instanceof Error ? err.message : err), isError: true };
      }

      const s = await stat(searchRoot).catch(() => null);
      if (!s) return { content: `Path not found: ${subPath}`, isError: true };

      const files: string[] = [];
      if (s.isDirectory()) {
        await walk(searchRoot, filePattern, files);
      } else {
        files.push(searchRoot);
      }

      const needle = caseSensitive ? query : query.toLowerCase();
      const hits: string[] = [];

      outer: for (const file of files) {
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
          if (haystack.includes(needle)) {
            const rel = relative(workspaceRoot, file);
            hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
            if (hits.length >= maxResults) break outer;
          }
        }
      }

      if (hits.length === 0) return { content: "No results found.", isError: false };
      const truncated = hits.length >= maxResults ? `\n[Results truncated at ${maxResults}]` : "";
      return { content: hits.join("\n") + truncated, isError: false };
    },
  };
}
