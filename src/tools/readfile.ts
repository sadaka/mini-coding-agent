import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { Tool, ToolDefinition, ToolResult } from "../types/index.js";
import { BINARY_NOTICE, createRepositoryScope } from "../navigation/scope.js";

const OUTPUT_CAP = 100 * 1024; // 100KB
const DEFINITION: ToolDefinition = {
  name: "read_file",
  description:
    "Read a file or a line range from it within the workspace. Each line is prefixed with its line number and a tab; " +
    "the prefix is not part of the file. contextLines adds lines around startLine-endLine.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace root" },
      startLine: { type: "number", description: "First line to read, 1-indexed (optional)" },
      endLine: { type: "number", description: "Last line to read, inclusive (optional)" },
      contextLines: { type: "number", description: "Extra lines before startLine and after endLine (optional)" },
    },
    required: ["path"],
  },
};

const err = (content: string): ToolResult => ({ content, isError: true });
const isCount = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min;

// `onChunk` reports every chunk read from disk; tests use it to prove ranged reads stop early.
export function createReadFileTool(workspaceRoot: string, opts: { onChunk?: (bytes: number) => void } = {}): Tool {
  const scope = createRepositoryScope(workspaceRoot);
  return {
    definition: DEFINITION,
    async execute(input): Promise<ToolResult> {
      const filePath = String(input.path ?? "");

      let resolved: string;
      try {
        resolved = scope.resolveReal(filePath);
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }

      const s = await stat(resolved).catch(() => null);
      if (!s || !s.isFile()) return err(`File not found: ${filePath}`);

      const { startLine, endLine, contextLines } = input;
      if (startLine !== undefined && !isCount(startLine, 1)) return err(`Invalid startLine: ${startLine} (must be an integer >= 1)`);
      if (endLine !== undefined && !isCount(endLine, 1)) return err(`Invalid endLine: ${endLine} (must be an integer >= 1)`);
      if (contextLines !== undefined && !isCount(contextLines, 0)) return err(`Invalid contextLines: ${contextLines} (must be an integer >= 0)`);
      if (startLine !== undefined && endLine !== undefined && (endLine as number) < (startLine as number)) {
        return err(`Invalid range: endLine ${endLine} is before startLine ${startLine}`);
      }

      try {
        if (await scope.isBinary(resolved)) return { content: BINARY_NOTICE, isError: false };
      } catch (e) {
        return err(`Failed to read file: ${e instanceof Error ? e.message : e}`);
      }

      // Context only widens an explicit range; a whole-file read has nothing to widen.
      const ctx = (contextLines as number | undefined) ?? 0;
      const from = Math.max(1, ((startLine as number | undefined) ?? 1) - (startLine !== undefined ? ctx : 0));
      const to = endLine !== undefined ? (endLine as number) + ctx : Infinity;

      const rows: string[] = [];
      let size = 0;
      let lineNo = 0;
      let truncated = false;

      // Returns false when reading should stop.
      const emit = (text: string): boolean => {
        lineNo++;
        if (lineNo < from) return true;
        if (lineNo > to) return false;
        const row = `${lineNo}\t${text}`;
        const room = OUTPUT_CAP - size;
        if (row.length + 1 > room) {
          rows.push(row.slice(0, Math.max(0, room)));
          truncated = true;
          return false;
        }
        rows.push(row);
        size += row.length + 1;
        return true;
      };

      let stopped = false;
      try {
        const decoder = new StringDecoder("utf8");
        let carry = "";
        outer: for await (const chunk of createReadStream(resolved, { highWaterMark: 64 * 1024 })) {
          opts.onChunk?.((chunk as Buffer).length);
          const parts = (carry + decoder.write(chunk as Buffer)).split("\n");
          carry = parts.pop()!.slice(0, OUTPUT_CAP); // a single endless line cannot grow memory
          for (const p of parts) {
            if (!emit(p.replace(/\r$/, ""))) {
              stopped = true;
              break outer;
            }
          }
        }
        if (!stopped) {
          const rest = carry + decoder.end();
          if (rest !== "") stopped = !emit(rest.replace(/\r$/, ""));
        }
      } catch (e) {
        return err(`Failed to read file: ${e instanceof Error ? e.message : e}`);
      }

      // Reached end of file without stopping, so lineNo is the file's line count.
      if (!stopped && startLine !== undefined && rows.length === 0) {
        return err(`startLine ${startLine} is beyond the end of the file (${lineNo} lines)`);
      }

      return { content: rows.join("\n") + (truncated ? "\n[Output truncated at 100KB]" : ""), isError: false };
    },
  };
}
