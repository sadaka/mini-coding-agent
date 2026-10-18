#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GeminiAdapter } from "../providers/gemini/index.js";
import { ClaudeAdapter } from "../providers/claude/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { createSearchTool } from "../tools/search.js";
import { createReadFileTool } from "../tools/readfile.js";
import { createEditFileTool } from "../tools/editfile.js";
import { createRunCommandTool } from "../tools/runcommand.js";
import { runAgentLoop } from "../agent/loop.js";
import type { NavigationMetrics } from "../navigation/metrics.js";
import type { LogEntry } from "../agent/logger.js";
import { registerJavaScriptTypeScriptProviders } from "../navigation/symbols/languages/javascript-typescript.js";
import { registerPythonProvider } from "../navigation/symbols/languages/python.js";

function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env is optional
  }
}

function formatResult(entry: LogEntry, debugContext = false, debugNavigation = false): string | null {
  switch (entry.event) {
    case "task_started":
      return `\n► Task: ${entry.detail}`;
    case "tool_started":
      return `  · ${entry.toolName}…`;
    case "tool_completed":
      return `  ✓ ${entry.toolName} (${entry.durationMs}ms)`;
    case "tool_failed":
      return `  ✗ ${entry.toolName} failed: ${entry.detail}`;
    case "verification_started":
      return `  · Verifying: ${entry.detail}`;
    case "verification_completed":
      return `  ${entry.success ? "✓" : "✗"} Verification ${entry.success ? "passed" : "failed"}`;
    case "context_metrics":
      if (!debugContext) return null;
      return (
        `  [context] items=${entry.contextItems} tokens=${entry.estimatedInputTokens}` +
        ` util=${((entry.utilization ?? 0) * 100).toFixed(1)}%` +
        ` truncated=${entry.truncatedItems ?? 0} dropped=${entry.droppedItems ?? 0}` +
        ` compactions=${entry.compactions ?? 0}`
      );
    case "navigation_scope_filtered":
      return debugNavigation ? `  [nav] scope ${entry.detail}` : null;
    case "directory_listed":
    case "search_completed":
    case "symbol_search_completed":
    case "test_discovery_completed":
      return debugNavigation
        ? `  [nav] ${entry.operation} ${entry.detail} → ${entry.resultCount} lines${entry.source ? ` (${entry.source})` : ""}`
        : null;
    case "navigation_duplicate_detected":
      return debugNavigation ? `  [nav] repeat #${entry.resultCount}: ${entry.toolName} ${entry.detail}` : null;
    case "navigation_result_truncated":
      return debugNavigation ? `  [nav] ${entry.operation} output truncated at its ceiling` : null;
    default:
      return null;
  }
}

function formatNavigationSummary(nav: NavigationMetrics, truncations: number): string {
  const calls = Object.entries(nav.callsByType).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
  return (
    `  [nav] summary: calls ${calls}; files discovered=${nav.filesDiscovered} read=${nav.filesRead};` +
    ` repeats=${nav.repeatedSearches}; symbol matches=${nav.symbolMatches}` +
    ` (tree-sitter ${nav.treeSitterSymbolMatches}, fallback ${nav.fallbackSymbolMatches}); truncated outputs=${truncations}`
  );
}

async function main() {
  loadEnv();

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      workspace: { type: "string", short: "w" },
      model: { type: "string", short: "m" },
      provider: { type: "string", short: "p" },
      "max-iterations": { type: "string" },
      "debug-context": { type: "boolean" },
      "debug-navigation": { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  const task = positionals[0];
  if (!task) {
    console.error("Usage: engineering-agent \"<task>\" [--workspace <path>] [--model <model>]");
    process.exit(1);
  }

  const workspaceRoot = resolve(typeof values.workspace === "string" ? values.workspace : process.cwd());
  const maxIterations = values["max-iterations"] ? parseInt(values["max-iterations"] as string, 10) : undefined;
  const debugContext = values["debug-context"] === true;
  const debugNavigation = values["debug-navigation"] === true;
  registerJavaScriptTypeScriptProviders();
  registerPythonProvider();

  const registry = new ToolRegistry();
  registry.register(createSearchTool(workspaceRoot));
  registry.register(createReadFileTool(workspaceRoot));
  registry.register(createEditFileTool(workspaceRoot));
  registry.register(createRunCommandTool(workspaceRoot));

  const providerName = typeof values.provider === "string" ? values.provider : (process.env.AGENT_PROVIDER ?? "gemini");
  if (typeof values.model === "string") {
    if (providerName === "claude") process.env.CLAUDE_MODEL = values.model;
    else process.env.GEMINI_MODEL = values.model;
  }

  let provider;
  try {
    if (providerName === "claude") provider = new ClaudeAdapter();
    else provider = new GeminiAdapter();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const logEntries: LogEntry[] = [];
  const sink = (entry: LogEntry) => {
    logEntries.push(entry);
    const line = formatResult(entry, debugContext, debugNavigation);
    if (line) process.stdout.write(line + "\n");
  };

  const result = await runAgentLoop(task, provider, registry, { maxIterations, workspaceRoot }, sink);

  if (debugNavigation && result.navigation) {
    const truncations = logEntries.filter((e) => e.event === "navigation_result_truncated").length;
    console.log(formatNavigationSummary(result.navigation, truncations));
  }

  console.log("\n" + "─".repeat(60));

  if (result.status === "success") {
    console.log("✓ Task completed successfully");
  } else {
    if (result.reason === "iteration_limit") {
      console.log("✗ Task failed: iteration limit reached — agent stopped without completing the task");
    } else {
      console.log(`✗ Task failed: ${result.reason ?? "unknown error"}`);
    }
  }

  if (result.changesMade.length > 0) {
    console.log(`\nFiles modified:\n${result.changesMade.map((f) => `  ${f}`).join("\n")}`);
  } else {
    console.log("\nNo files modified.");
  }

  if (result.verificationPerformed) {
    console.log(`\nVerification: ${result.verificationPassed ? "PASSED" : "FAILED"}`);
  } else {
    console.log("\nVerification: not performed");
  }

  if (result.finalMessage) {
    console.log(`\nAgent message:\n  ${result.finalMessage}`);
  }

  process.exit(result.status === "success" ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
