/**
 * Integration test: full agent loop through real tools against the fixture repo.
 * The LLM is mocked to emit a deterministic sequence of tool calls that mirrors
 * what a real model would do to fix the calculator bug.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { LLMProvider, LLMResponse } from "../src/types/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createSearchTool } from "../src/tools/search.js";
import { createReadFileTool } from "../src/tools/readfile.js";
import { createEditFileTool } from "../src/tools/editfile.js";
import { createRunCommandTool } from "../src/tools/runcommand.js";
import { runAgentLoop } from "../src/agent/loop.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/test-project");
const CALCULATOR_PATH = resolve(FIXTURE, "src/calculator.ts");

// Save/restore the fixture so repeated test runs start from the broken state
let originalCalculator: string;
beforeEach(async () => { originalCalculator = await readFile(CALCULATOR_PATH, "utf8"); });
afterEach(async () => { await writeFile(CALCULATOR_PATH, originalCalculator, "utf8"); });

function scriptedProvider(script: LLMResponse[]): LLMProvider {
  let i = 0;
  return {
    generate: async (_messages, _tools) => {
      if (i >= script.length) return { type: "text" as const, text: "Task complete." };
      return script[i++];
    },
  };
}

describe("integration: calculator bug fix via mocked LLM", () => {
  it("searches, reads, edits, runs tests, and reports verified success", async () => {
    const registry = new ToolRegistry();
    registry.register(createSearchTool(FIXTURE));
    registry.register(createReadFileTool(FIXTURE));
    registry.register(createEditFileTool(FIXTURE));
    registry.register(createRunCommandTool(FIXTURE));

    const provider = scriptedProvider([
      // Step 1: search for multiply
      {
        type: "tool_calls",
        toolCalls: [{ id: "c1", name: "search", input: { query: "multiply", filePattern: "*.ts" } }],
      },
      // Step 2: read the file
      {
        type: "tool_calls",
        toolCalls: [{ id: "c2", name: "read_file", input: { path: "src/calculator.ts" } }],
      },
      // Step 3: fix the bug — replace `return a + b` in multiply with `return a * b`
      {
        type: "tool_calls",
        toolCalls: [{
          id: "c3",
          name: "edit_file",
          input: {
            path: "src/calculator.ts",
            operation: "replace",
            old_string: "  // ponytail: deliberate bug for integration test — wrong operator\n  return a + b;\n",
            new_string: "  return a * b;\n",
          },
        }],
      },
      // Step 4: run tests
      {
        type: "tool_calls",
        toolCalls: [{ id: "c4", name: "run_command", input: { command: "npm test" } }],
      },
      // Step 5: done
      { type: "text", text: "Fixed multiply bug. Tests pass." },
    ]);

    const result = await runAgentLoop(
      "Fix the failing calculator test",
      provider,
      registry,
    );

    expect(result.status).toBe("success");
    expect(result.changesMade).toContain("src/calculator.ts");
    expect(result.verificationPerformed).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.finalMessage).toContain("Fixed");
  }, 30_000); // spawns a nested `npm test`: 1.3s alone, ~4-5s under full-suite load, so the 5s default flaked

  it("no @google/genai import outside providers/gemini (AC-13)", () => {
    // Static check: import.meta.dirname is tests/, walk up to src/ and verify
    const { execSync } = require("node:child_process");
    const srcDir = resolve(import.meta.dirname, "../src");
    let out = "";
    try {
      out = execSync(`grep -r "@google/genai" "${srcDir}" --include="*.ts" -l`, { encoding: "utf8" });
    } catch {
      out = "";
    }
    const files = out.trim().split("\n").filter(Boolean);
    const bad = files.filter((f) => !f.includes("providers/gemini"));
    expect(bad, `@google/genai imported outside providers/gemini: ${bad.join(", ")}`).toHaveLength(0);
  });
});
