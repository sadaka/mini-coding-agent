import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Tool, ToolDefinition, ToolResult } from "../types/index.js";
import { resolveInWorkspace } from "./workspace.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_CAP = 100 * 1024;

// Read-only shell utilities safe for codebase exploration. Shared with the tool
// description so what the model is told can't drift from what is enforced.
const READ_ONLY_COMMANDS = [
  "find", "grep", "ls", "cat", "wc", "head", "tail", "echo",
] as const;

const DEFINITION: ToolDefinition = {
  name: "run_command",
  description:
    "Run a single allowlisted command in the workspace. Returns exit code, stdout, stderr, and timedOut flag.\n" +
    "IMPORTANT: there is NO shell. Pipes (|), redirects (> <), chaining (&& ; ), backticks and $(...) " +
    "are rejected — pass one command with its arguments only.\n" +
    `Allowed: ${READ_ONLY_COMMANDS.join(", ")}, python, python3, npx, node <file-in-workspace>, ` +
    "npm test, npm run <script-in-package.json>.\n" +
    "To find text inside files use the 'search' tool, not grep. To list files by name use " +
    "'find . -name \"*.html\"' with no pipe.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Single command with arguments, no shell operators (e.g. 'npm test')" },
      cwd: { type: "string", description: "Subdirectory to run in (optional, defaults to workspace root)" },
      timeoutMs: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
    },
    required: ["command"],
  },
};

async function loadPackageScripts(workspaceRoot: string): Promise<Set<string>> {
  try {
    const pkgPath = join(workspaceRoot, "package.json");
    const text = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set();
  }
}

export async function isAllowed(
  command: string,
  workspaceRoot: string
): Promise<{ allowed: boolean; reason?: string }> {
  // Commands run with shell:false, so these are never interpreted — they would be
  // passed to the binary as literal arguments and fail confusingly
  // (e.g. "find: |: unknown primary or operator").
  const shellChar = /[|&;<>`$()]|\n/.exec(command);
  if (shellChar) {
    return {
      allowed: false,
      reason:
        `Shell operator '${shellChar[0]}' is not supported: commands run without a shell, ` +
        `so pipes, redirects and chaining do not work. Run a single command instead, ` +
        `or use the 'search' tool to find text across files.`,
    };
  }

  const parts = command.trim().split(/\s+/);
  const [cmd, sub, ...rest] = parts;

  if (cmd === "npm") {
    if (sub === "test") return { allowed: true };
    if (sub === "run") {
      const scripts = await loadPackageScripts(workspaceRoot);
      const scriptName = rest[0];
      if (scriptName && (scripts.has(scriptName) || ["build", "lint"].includes(scriptName))) {
        return { allowed: true };
      }
      return { allowed: false, reason: `npm run ${scriptName ?? ""} is not in package.json scripts` };
    }
    return { allowed: false, reason: `npm ${sub} is not allowed` };
  }

  if (cmd === "node") {
    const filePath = rest[0] ?? sub;
    if (filePath) {
      try {
        const resolved = resolve(workspaceRoot, filePath);
        if (resolved.startsWith(workspaceRoot + "/") || resolved === workspaceRoot) {
          return { allowed: true };
        }
      } catch {
        // fall through to deny
      }
    }
    return { allowed: false, reason: "node file must resolve inside the workspace" };
  }

  if ((READ_ONLY_COMMANDS as readonly string[]).includes(cmd)) return { allowed: true };

  // Language runtime shortcuts
  if (cmd === "python" || cmd === "python3") return { allowed: true };
  if (cmd === "npx") return { allowed: true };

  return { allowed: false, reason: `Command '${cmd}' is not in the allowlist` };
}

export function createRunCommandTool(workspaceRoot: string): Tool {
  return {
    definition: DEFINITION,
    async execute(input): Promise<ToolResult> {
      const command = String(input.command ?? "");
      const subDir = input.cwd ? String(input.cwd) : ".";
      const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      let cwd: string;
      try {
        cwd = resolveInWorkspace(workspaceRoot, subDir);
      } catch (err) {
        return { content: String(err instanceof Error ? err.message : err), isError: true };
      }

      const { allowed, reason } = await isAllowed(command, workspaceRoot);
      if (!allowed) {
        return { content: `Command denied: ${reason ?? "not allowed"}`, isError: true };
      }

      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let totalBytes = 0;
        let truncated = false;
        let timedOut = false;

        const [cmd, ...args] = command.split(/\s+/);
        const child = spawn(cmd, args, { cwd, shell: false });

        const onData = (chunk: Buffer) => {
          if (truncated) return;
          totalBytes += chunk.length;
          if (totalBytes > DEFAULT_OUTPUT_CAP) {
            truncated = true;
          }
        };

        child.stdout.on("data", (chunk: Buffer) => {
          onData(chunk);
          if (!truncated) stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          onData(chunk);
          if (!truncated) stderr += chunk.toString();
        });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);

        child.on("close", (exitCode) => {
          clearTimeout(timer);
          const notice = truncated ? "\n[Output truncated at 100KB]" : "";
          const content = JSON.stringify({
            exitCode: exitCode ?? -1,
            stdout: stdout + (truncated ? notice : ""),
            stderr: stderr + (truncated && !stdout ? notice : ""),
            timedOut,
          });
          resolve({ content, isError: timedOut || (exitCode !== 0) });
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ content: `Spawn error: ${err.message}`, isError: true });
        });
      });
    },
  };
}
