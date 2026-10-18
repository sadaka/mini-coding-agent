import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Tool, ToolDefinition, ToolResult } from "../types/index.js";
import type { RepositoryScope } from "./scope.js";

export const MAX_DEPTH = 5;
export const ENTRY_CEILING = 500;

const DEFINITION: ToolDefinition = {
  name: "list_directory",
  description:
    "List files and directories in a workspace directory. Skips ignored, generated and hidden entries. Directories end with '/'.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to workspace root (default '.')" },
      depth: { type: "number", description: `Levels to descend, 1-${MAX_DEPTH} (default 1)` },
      includeHidden: { type: "boolean", description: "Include dotfiles (default false)" },
    },
  },
};

export function createListDirectoryTool(scope: RepositoryScope): Tool {
  return {
    definition: DEFINITION,
    async execute(input): Promise<ToolResult> {
      const target = String(input.path ?? ".") || ".";
      const depth = Math.min(MAX_DEPTH, Math.max(1, Math.floor(Number(input.depth ?? 1)) || 1));
      const includeHidden = input.includeHidden === true;

      let real: string;
      try {
        real = scope.resolveReal(target);
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
      const s = await stat(real).catch(() => null);
      if (!s) return { content: `Directory not found: ${target}`, isError: true };
      if (!s.isDirectory()) return { content: `Not a directory: ${target}`, isError: true };

      const out: string[] = [];
      let truncated = false;

      // Walk the lexical path so entries are reported workspace-relative.
      async function walk(abs: string, level: number): Promise<void> {
        const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        const rels = entries
          .filter((e) => includeHidden || !e.name.startsWith("."))
          .map((e) => relative(scope.root, join(abs, e.name)));
        const kept = new Set(scope.filter(rels));
        for (const e of entries) {
          const rel = relative(scope.root, join(abs, e.name));
          if (!kept.has(rel)) continue;
          if (out.length >= ENTRY_CEILING) {
            truncated = true;
            return;
          }
          const isDir = e.isDirectory(); // symlinks are listed, never followed
          out.push(isDir ? rel + "/" : rel);
          if (isDir && level < depth) {
            await walk(join(abs, e.name), level + 1);
            if (truncated) return;
          }
        }
      }

      await walk(resolve(scope.root, target), 1);

      let content = out.join("\n") || "(empty)";
      if (truncated) content += `\n[Truncated at ${ENTRY_CEILING} entries - narrow the path or lower depth]`;
      return { content, isError: false };
    },
  };
}
