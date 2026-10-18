import { readFile, stat } from "node:fs/promises";
import type { Tool, ToolDefinition, ToolResult } from "../types/index.js";
import { resolveInWorkspace } from "./workspace.js";

const OUTPUT_CAP = 100 * 1024; // 100KB
const DEFINITION: ToolDefinition = {
  name: "read_file",
  description: "Read a file or a line range from it within the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace root" },
      startLine: { type: "number", description: "First line to read, 1-indexed (optional)" },
      endLine: { type: "number", description: "Last line to read, inclusive (optional)" },
    },
    required: ["path"],
  },
};

export function createReadFileTool(workspaceRoot: string): Tool {
  return {
    definition: DEFINITION,
    async execute(input): Promise<ToolResult> {
      const filePath = String(input.path ?? "");

      let resolved: string;
      try {
        resolved = resolveInWorkspace(workspaceRoot, filePath);
      } catch (err) {
        return { content: String(err instanceof Error ? err.message : err), isError: true };
      }

      const s = await stat(resolved).catch(() => null);
      if (!s || !s.isFile()) return { content: `File not found: ${filePath}`, isError: true };

      let text: string;
      try {
        text = await readFile(resolved, "utf8");
      } catch (err) {
        return { content: `Failed to read file: ${err instanceof Error ? err.message : err}`, isError: true };
      }

      if (input.startLine !== undefined || input.endLine !== undefined) {
        const lines = text.split("\n");
        const start = Math.max(1, Number(input.startLine ?? 1)) - 1;
        const end = Math.min(lines.length, Number(input.endLine ?? lines.length));
        text = lines.slice(start, end).join("\n");
      }

      if (text.length > OUTPUT_CAP) {
        text = text.slice(0, OUTPUT_CAP) + "\n[Output truncated at 100KB]";
      }

      return { content: text, isError: false };
    },
  };
}
