import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { Tool, ToolDefinition, ToolResult } from "../types/index.js";
import type { RepositoryScope } from "./scope.js";

export const RESULT_CEILING = 200;
export const SCAN_CEILING = 20000;

const DEFINITION: ToolDefinition = {
  name: "find_tests",
  description:
    "List likely test files by naming convention (*.test.ts/js, *.spec.ts/js, test_*.py, *_test.py, files under tests/, test/, __tests__/, and similar names in other languages). " +
    "Convention only: no test framework is detected.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to search, relative to workspace root (default '.')" },
    },
  },
};

const TEST_DIRS = new Set(["tests", "test", "__tests__"]);
const CODE_EXT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py",
  ".java", ".kt", ".go", ".rb", ".rs", ".cs", ".php", ".swift", ".scala", ".c", ".cc", ".cpp",
]);
// name.test.x, name_test.x, name-spec.x ; test_name.x ; FooTest.x / FooTests.x / FooSpec.x
const NAME_PATTERNS = [/[._-](test|spec)\.[a-z0-9]+$/i, /^test_.+\.[a-z0-9]+$/i, /[a-z0-9](Test|Tests|Spec)\.[a-z0-9]+$/];

/** Pure convention check on a workspace-relative path. */
export function isTestPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const name = basename(rel);
  if (NAME_PATTERNS.some((p) => p.test(name))) return true;
  return parts.slice(0, -1).some((d) => TEST_DIRS.has(d)) && CODE_EXT.has(extname(name).toLowerCase());
}

export function createFindTestsTool(scope: RepositoryScope): Tool {
  return {
    definition: DEFINITION,
    async execute(input): Promise<ToolResult> {
      const target = String(input.path ?? ".") || ".";
      let real: string;
      try {
        real = scope.resolveReal(target);
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
      const s = await stat(real).catch(() => null);
      if (!s) return { content: `Directory not found: ${target}`, isError: true };
      if (!s.isDirectory()) return { content: `Not a directory: ${target}`, isError: true };

      const found: string[] = [];
      let scanned = 0;
      let stopped: "results" | "scan" | null = null;

      async function walk(abs: string): Promise<void> {
        const entries = (await readdir(abs, { withFileTypes: true }))
          .filter((e) => !e.name.startsWith("."))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const kept = new Set(scope.filter(entries.map((e) => relative(scope.root, join(abs, e.name)))));
        for (const e of entries) {
          const rel = relative(scope.root, join(abs, e.name));
          if (!kept.has(rel)) continue;
          if (e.isDirectory()) {
            await walk(join(abs, e.name)); // symlinks are not followed
          } else if (e.isFile()) {
            if (++scanned > SCAN_CEILING) stopped = "scan";
            else if (isTestPath(rel)) {
              if (found.length >= RESULT_CEILING) stopped = "results";
              else found.push(rel);
            }
          }
          if (stopped) return;
        }
      }

      await walk(resolve(scope.root, target));

      if (found.length === 0 && !stopped) return { content: "No test files found.", isError: false };
      let content = found.join("\n");
      if (stopped === "results") content += `\n[Truncated at ${RESULT_CEILING} files - narrow the path]`;
      if (stopped === "scan") content += `\n[Scan stopped at ${SCAN_CEILING} files - narrow the path]`;
      return { content, isError: false };
    },
  };
}
