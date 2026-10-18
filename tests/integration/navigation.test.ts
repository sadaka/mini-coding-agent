/**
 * AC-36: the full agent on a multi-file repository, driven by a scripted LLM that navigates with
 * find_tests, search, find_symbol and a ranged read_file (not the requirements-document order, and
 * no list_directory). The script reads each tool's output to choose its next call, so it exercises
 * the real output formats. Assertions are on the final repository and the verification command,
 * not on the sequence.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMResponse, Message } from "../../src/types/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createSearchTool } from "../../src/tools/search.js";
import { createReadFileTool } from "../../src/tools/readfile.js";
import { createEditFileTool } from "../../src/tools/editfile.js";
import { createRunCommandTool } from "../../src/tools/runcommand.js";
import { runAgentLoop } from "../../src/agent/loop.js";
import { registerJavaScriptTypeScriptProviders } from "../../src/navigation/symbols/languages/javascript-typescript.js";

vi.setConfig({ testTimeout: 60_000 });

let workspace: string;
beforeAll(() => {
  registerJavaScriptTypeScriptProviders();
  workspace = mkdtempSync(join(tmpdir(), "nav-repo-"));
  cpSync(resolve(import.meta.dirname, "../fixtures/nav-repo"), workspace, { recursive: true });
});
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

/** Text of the tool_result blocks in the latest tool message the provider was sent. */
function lastResult(messages: Message[]): string {
  const last = messages[messages.length - 1];
  return last.content.flatMap((c) => (c.type === "tool_result" ? [c.content] : [])).join("\n");
}

/** Chooses each call from the previous result; fails the run (via an error) if a result is not what a model could use. */
function navigatingModel(): LLMProvider {
  let step = 0;
  let declaration = { path: "", start: 0, end: 0 };
  let line = "";
  const call = (name: string, input: Record<string, unknown>): LLMResponse => ({
    type: "tool_calls",
    toolCalls: [{ id: `c${step}`, name, input }],
  });
  return {
    generate: async (messages) => {
      const prev = step === 0 ? "" : lastResult(messages);
      switch (step++) {
        case 0: return call("find_tests", {});
        case 1: return call("search", { query: "tax" });
        case 2: return call("find_symbol", { symbol_name: "taxFor" });
        case 3: {
          const m = /^(.+?):(\d+)-(\d+) function taxFor \[tree-sitter/m.exec(prev);
          if (!m) throw new Error(`find_symbol gave no tree-sitter declaration:\n${prev}`);
          declaration = { path: m[1], start: +m[2], end: +m[3] };
          return call("read_file", { path: declaration.path, startLine: declaration.start, endLine: declaration.end });
        }
        case 4: {
          const m = /^\d+\t(.*Math\.floor.*)$/m.exec(prev);
          if (!m) throw new Error(`ranged read did not show the rounding line:\n${prev}`);
          line = m[1];
          return call("edit_file", { path: declaration.path, operation: "replace", old_string: line, new_string: line.replace("Math.floor", "Math.round") });
        }
        case 5: return call("run_command", { command: "npm test" });
        default: return { type: "text", text: "Rounded the tax instead of truncating it; npm test passes." };
      }
    },
  };
}

describe("integration: unknown-location fix by navigation (AC-36)", () => {
  it("finds, reads, fixes and verifies without a fixed navigation order", async () => {
    const registry = new ToolRegistry();
    registry.register(createSearchTool(workspace));
    registry.register(createReadFileTool(workspace));
    registry.register(createEditFileTool(workspace));
    registry.register(createRunCommandTool(workspace));

    const result = await runAgentLoop("Invoice totals are sometimes a cent short. Fix it.", navigatingModel(), registry, { workspaceRoot: workspace });

    expect(result.status).toBe("success");
    expect(result.verificationPerformed).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.changesMade).toEqual(["src/pricing/tax.ts"]);
    expect(result.navigation?.callsByType).toMatchObject({ find_tests: 1, find_symbol: 1 });

    // Final repository state, checked outside the agent.
    expect(readFileSync(join(workspace, "src/pricing/tax.ts"), "utf8")).toContain("Math.round(exact)");
    expect(readFileSync(join(workspace, "src/pricing/discount.ts"), "utf8")).toContain("Math.round"); // untouched
    const verify = spawnSync("npm", ["test"], { cwd: workspace, encoding: "utf8" });
    expect(verify.status, verify.stdout + verify.stderr).toBe(0);
  });
});
