import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolDefinition, ToolResult } from "../types/index.js";
import { resolveInWorkspace } from "./workspace.js";

const DEFINITION: ToolDefinition = {
  name: "edit_file",
  description:
    "Write or edit a file within the workspace.\n" +
    "To create or fully overwrite a file, pass 'path' and 'content'.\n" +
    "To change part of an existing file, pass 'path', 'old_string' and 'new_string' — " +
    "old_string must appear exactly once, so include surrounding lines if needed.\n" +
    "Prefer old_string/new_string for small edits to a large file: rewriting a whole file " +
    "costs far more output tokens and can be cut off mid-call.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace root" },
      content: { type: "string", description: "Full file content — creates or overwrites the file" },
      old_string: { type: "string", description: "Exact existing text to replace (must occur exactly once)" },
      new_string: { type: "string", description: "Text to replace old_string with" },
      operation: {
        type: "string",
        enum: ["write", "replace"],
        description: "Optional. Inferred from the fields above; only needed to disambiguate.",
      },
    },
    required: ["path"],
  },
};

export function createEditFileTool(workspaceRoot: string): Tool {
  const modifiedFiles = new Set<string>();

  return {
    definition: DEFINITION,
    async execute(input): Promise<ToolResult> {
      const filePath = String(input.path ?? "");

      // 'operation' is redundant — the payload already says which edit this is. Models
      // routinely omit it (most editing tools infer it) and no error message reliably
      // corrects that, so derive it and use an explicit value only when it is valid.
      const explicit = String(input.operation ?? "").trim().toLowerCase();
      const hasOldString = typeof input.old_string === "string" && input.old_string.length > 0;
      const hasContent = typeof input.content === "string";
      const operation =
        explicit === "write" || explicit === "replace" ? explicit
        : hasOldString ? "replace"
        : hasContent ? "write"
        : "";

      let resolved: string;
      try {
        resolved = resolveInWorkspace(workspaceRoot, filePath);
      } catch (err) {
        return { content: String(err instanceof Error ? err.message : err), isError: true };
      }

      if (operation === "write") {
        const content = String(input.content ?? "");
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, content, "utf8");
        modifiedFiles.add(filePath);
        return { content: `Written: ${filePath}`, isError: false };
      }

      if (operation === "replace") {
        const oldStr = String(input.old_string ?? "");
        const newStr = String(input.new_string ?? "");

        if (!oldStr) return { content: "old_string must not be empty", isError: true };

        let existing: string;
        try {
          existing = await readFile(resolved, "utf8");
        } catch {
          return { content: `File not found: ${filePath}`, isError: true };
        }

        const count = existing.split(oldStr).length - 1;
        if (count === 0) return { content: `old_string not found in ${filePath}`, isError: true };
        if (count > 1) return { content: `old_string matches ${count} times in ${filePath}; must match exactly once`, isError: true };

        const updated = existing.replace(oldStr, newStr);
        await writeFile(resolved, updated, "utf8");
        modifiedFiles.add(filePath);
        return { content: `Replaced in: ${filePath}`, isError: false };
      }

      return {
        content:
          `Could not tell which edit to make. Received keys: [${Object.keys(input).join(", ")}]. ` +
          `To overwrite a file pass 'content'. To change part of it pass 'old_string' and 'new_string'.`,
        isError: true,
      };
    },
  };
}
