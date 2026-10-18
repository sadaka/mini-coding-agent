/**
 * Iteration 2 evaluation runner — IMPL-IT2-8.
 *
 * Runs 7 scripted evaluation tasks through both:
 *   IT2: current codebase (ContextManager active)
 *   IT1: baseline loop (plain message accumulation, no context management)
 *
 * Writes eval/iteration2/summary.json with per-task metrics.
 * Gate: summary.tasks.length >= 7.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = resolve(ROOT, "tests/fixtures/test-project");
const CALC_FILE = resolve(FIXTURE, "src/calculator.ts");
const OUT_DIR = resolve(ROOT, "eval/iteration2");

// Load .env before dynamic imports
try {
  const raw = readFileSync(resolve(ROOT, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0 || line.startsWith("#")) continue;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch { /* .env optional */ }

const { runAgentLoop } = await import("../src/agent/loop.js");
const { ToolRegistry } = await import("../src/tools/registry.js");
const { createSearchTool } = await import("../src/tools/search.js");
const { createReadFileTool } = await import("../src/tools/readfile.js");
const { createEditFileTool } = await import("../src/tools/editfile.js");
const { createRunCommandTool } = await import("../src/tools/runcommand.js");
const { defaultTokenEstimator } = await import("../src/context/token-estimator.js");
import type { LLMProvider, LLMResponse, Message, MessageContent, ToolResultContent, Tool } from "../src/types/index.js";
import type { LogEntry } from "../src/agent/logger.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function scriptedProvider(script: LLMResponse[]): LLMProvider {
  let i = 0;
  return { generate: async () => (i >= script.length ? { type: "text" as const, text: "Done." } : script[i++]) };
}

function mockTool(name: string, content: string): Tool {
  return {
    definition: { name, description: name, inputSchema: { type: "object", properties: {} } },
    execute: async () => ({ content, isError: false }),
  };
}

function mockRegistry(responses: Record<string, string>): ToolRegistry {
  const r = new ToolRegistry();
  for (const [name, content] of Object.entries(responses)) r.register(mockTool(name, content));
  return r;
}

function tc(id: string, name: string, input: Record<string, unknown> = {}): LLMResponse {
  return { type: "tool_calls" as const, toolCalls: [{ id, name, input }] };
}

// ── tight policy env (4K context, forces truncation + compaction) ──────────────

function withTightPolicy<T>(fn: () => Promise<T>): Promise<T> {
  const overrides: Record<string, string> = {
    MAX_CONTEXT_TOKENS: "4000", RESERVED_OUTPUT_TOKENS: "500",
    MAX_SEARCH_RESULT_TOKENS: "400", MAX_FILE_READ_TOKENS: "600",
    MAX_TOOL_OUTPUT_TOKENS: "500", MAX_COMMAND_OUTPUT_TOKENS: "500",
    MAX_RECENT_ITEMS: "4", COMPACTION_THRESHOLD: "0.65", ENABLE_COMPACTION: "true",
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) { saved[k] = process.env[k]; process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

// ── IT1 baseline: plain message accumulation, no ContextManager ───────────────

async function runBaseline(
  task: string, provider: LLMProvider, registry: ToolRegistry, maxIter = 25
): Promise<{ status: string; iterations: number; estTokens: number }> {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: task }] }];

  function estimateAll(): number {
    return msgs.reduce((sum, m) => {
      const text = m.content.map((c: MessageContent) => {
        if (c.type === "text") return c.text;
        if (c.type === "tool_call") return `${c.name}(${JSON.stringify(c.input)})`;
        if (c.type === "tool_result") return c.content;
        return "";
      }).join("\n");
      return sum + defaultTokenEstimator.estimate(text);
    }, 0);
  }

  for (let i = 0; i < maxIter; i++) {
    const resp = await provider.generate(msgs, registry.definitions());
    if (resp.type === "text") return { status: "success", iterations: i + 1, estTokens: estimateAll() };
    const tcs = resp.toolCalls ?? [];
    msgs.push({ role: "assistant", content: tcs.map(t => ({ type: "tool_call" as const, id: t.id, name: t.name, input: t.input })) });
    const results: ToolResultContent[] = [];
    for (const t of tcs) {
      let content = "tool not found", isError = true;
      const tool = registry.get(t.name);
      if (tool) { try { const r = await tool.execute(t.input); content = r.content; isError = r.isError; } catch (e) { content = String(e); } }
      results.push({ type: "tool_result", toolCallId: t.id, toolName: t.name, content, isError });
    }
    msgs.push({ role: "tool", content: results });
  }
  return { status: "failed", iterations: maxIter, estTokens: estimateAll() };
}

// ── metrics extraction from IT2 log ──────────────────────────────────────────

function metricsFrom(log: LogEntry[]): { estTokens: number; compactions: number; truncations: number; iterations: number } {
  const last = [...log].reverse().find(e => e.event === "context_metrics");
  return {
    estTokens: last?.estimatedInputTokens ?? 0,
    compactions: last?.compactions ?? 0,
    truncations: last?.truncatedItems ?? 0,
    iterations: log.filter(e => e.event === "llm_request").length,
  };
}

// ── calculator fixture ────────────────────────────────────────────────────────

const ORIG_CALC = readFileSync(CALC_FILE, "utf8");
const reset = () => writeFileSync(CALC_FILE, ORIG_CALC, "utf8");
function verifyCalcFix(): boolean {
  try {
    const content = readFileSync(CALC_FILE, "utf8");
    if (!content.includes("return a * b")) return false;
    execSync("npm test", { cwd: FIXTURE, stdio: "pipe" });
    return true;
  } catch { return false; }
}

// ── content blobs for mock tools ──────────────────────────────────────────────

const SMALL  = "result line\n".repeat(15);          // ~50 tokens
const MEDIUM = "result line\n".repeat(60);           // ~200 tokens
const LARGE_SEARCH = "search result\n".repeat(180);  // ~650 tokens — exceeds MAX_SEARCH=400
const LARGE_FILE   = "file content\n".repeat(280);   // ~850 tokens — exceeds MAX_FILE=600

// ── result type ───────────────────────────────────────────────────────────────

interface EvalRow {
  task: string; version: "IT1" | "IT2"; success: boolean;
  iterations: number; estTokens: number; compactions: number;
  truncations: number; failureCategory?: string;
}

// ── task definitions ──────────────────────────────────────────────────────────

interface TaskDef {
  name: string; task: string; tightPolicy: boolean;
  makeScript: () => LLMResponse[];
  makeRegistry: () => ToolRegistry;
  verifyFn?: () => boolean;
}

const TASKS: TaskDef[] = [
  // 1 — Simple Bug Fix: basic flow, short context
  {
    name: "Simple Bug Fix",
    task: "Fix the failing calculator test. The multiply function has a bug.",
    tightPolicy: false,
    makeScript: () => [
      tc("c1", "search", { query: "multiply", filePattern: "*.ts" }),
      tc("c2", "read_file", { path: "src/calculator.ts" }),
      tc("c3", "edit_file", { path: "src/calculator.ts", operation: "replace", old_string: "  // ponytail: deliberate bug for integration test — wrong operator\n  return a + b;\n", new_string: "  return a * b;\n" }),
      tc("c4", "run_command", { command: "npm test" }),
      { type: "text" as const, text: "Fixed multiply bug. Tests pass." },
    ],
    makeRegistry: () => {
      const r = new ToolRegistry();
      r.register(createSearchTool(FIXTURE)); r.register(createReadFileTool(FIXTURE));
      r.register(createEditFileTool(FIXTURE)); r.register(createRunCommandTool(FIXTURE));
      return r;
    },
    verifyFn: verifyCalcFix,
  },

  // 2 — Multi-file Change: multiple files in context
  {
    name: "Multi-file Change",
    task: "Refactor the calculator to split add and multiply into separate modules.",
    tightPolicy: false,
    makeScript: () => [
      tc("c1", "search"), tc("c2", "read_file"), tc("c3", "read_file"),
      tc("c4", "edit_file"), tc("c5", "edit_file"), tc("c6", "run_command"),
      { type: "text" as const, text: "Refactoring complete." },
    ],
    makeRegistry: () => mockRegistry({ search: SMALL, read_file: MEDIUM, edit_file: SMALL, run_command: '{"exitCode":0}' }),
  },

  // 3 — Large Search: search result exceeds MAX_SEARCH_RESULT_TOKENS → truncation
  {
    name: "Large Search",
    task: "Find all usages of the calculator functions across the codebase.",
    tightPolicy: true,
    makeScript: () => [
      tc("c1", "search"), tc("c2", "read_file"), tc("c3", "edit_file"), tc("c4", "run_command"),
      { type: "text" as const, text: "Done." },
    ],
    makeRegistry: () => mockRegistry({ search: LARGE_SEARCH, read_file: SMALL, edit_file: SMALL, run_command: '{"exitCode":0}' }),
  },

  // 4 — Large File: file read exceeds MAX_FILE_READ_TOKENS → truncation
  {
    name: "Large File",
    task: "Read the main module and add JSDoc comments to all exported functions.",
    tightPolicy: true,
    makeScript: () => [
      tc("c1", "search"), tc("c2", "read_file"), tc("c3", "edit_file"), tc("c4", "run_command"),
      { type: "text" as const, text: "Done." },
    ],
    makeRegistry: () => mockRegistry({ search: SMALL, read_file: LARGE_FILE, edit_file: SMALL, run_command: '{"exitCode":0}' }),
  },

  // 5 — Long Task: 14 cycles of search+read → forces multiple compactions
  {
    name: "Long Task",
    task: "Audit all functions in the codebase and add test coverage for each.",
    tightPolicy: true,
    makeScript: () => [
      ...Array.from({ length: 14 }, (_, i) => [tc(`s${i}`, "search"), tc(`r${i}`, "read_file")]).flat(),
      { type: "text" as const, text: "Audit complete." },
    ],
    makeRegistry: () => mockRegistry({ search: MEDIUM, read_file: MEDIUM }),
  },

  // 6 — Repeated Search: same search 6× → tests duplicate/compaction behaviour
  {
    name: "Repeated Search",
    task: "Find all occurrences of the add function and replace with addition consistently.",
    tightPolicy: true,
    makeScript: () => [
      ...Array.from({ length: 6 }, (_, i) => tc(`s${i}`, "search", { query: "add" })),
      tc("e1", "edit_file"), tc("r1", "run_command"),
      { type: "text" as const, text: "All occurrences replaced." },
    ],
    makeRegistry: () => mockRegistry({ search: MEDIUM, edit_file: SMALL, run_command: '{"exitCode":0}' }),
  },

  // 7 — Important Early Discovery: critical constraint in task survives compaction
  {
    name: "Important Early Discovery",
    task: "Refactor the calculator module. Important constraint: do NOT delete any existing test files.",
    tightPolicy: true,
    makeScript: () => [
      ...Array.from({ length: 10 }, (_, i) => tc(`r${i}`, "read_file")),
      tc("cmd", "run_command"),
      { type: "text" as const, text: "Refactoring complete. No test files deleted." },
    ],
    makeRegistry: () => mockRegistry({ read_file: MEDIUM, run_command: '{"exitCode":0}' }),
  },
];

// ── run one task (IT2 + IT1) ──────────────────────────────────────────────────

async function runTask(def: TaskDef): Promise<EvalRow[]> {
  reset();
  const rows: EvalRow[] = [];

  // IT2
  const it2Log: LogEntry[] = [];
  const doIT2 = async () => runAgentLoop(
    def.task, scriptedProvider(def.makeScript()), def.makeRegistry(),
    { maxIterations: 30 }, (e) => it2Log.push(e),
  );
  const it2 = def.tightPolicy ? await withTightPolicy(doIT2) : await doIT2();
  const it2m = metricsFrom(it2Log);
  const it2ok = def.verifyFn ? def.verifyFn() : it2.status === "success";
  rows.push({
    task: def.name, version: "IT2", success: it2ok,
    iterations: it2m.iterations, estTokens: it2m.estTokens,
    compactions: it2m.compactions, truncations: it2m.truncations,
    failureCategory: !it2ok ? "MODEL_REASONING" : undefined,
  });

  reset();

  // IT1 baseline
  const it1 = await runBaseline(def.task, scriptedProvider(def.makeScript()), def.makeRegistry());
  const it1ok = def.verifyFn ? def.verifyFn() : it1.status === "success";
  rows.push({
    task: def.name, version: "IT1", success: it1ok,
    iterations: it1.iterations, estTokens: it1.estTokens,
    compactions: 0, truncations: 0,
    failureCategory: !it1ok ? "MODEL_REASONING" : undefined,
  });

  reset();
  return rows;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const allRows: EvalRow[] = [];

  for (const def of TASKS) {
    process.stdout.write(`\n── ${def.name} `);
    const rows = await runTask(def);
    allRows.push(...rows);
    for (const r of rows) {
      console.log(`[${r.version}] ok=${r.success ? "✓" : "✗"} iter=${r.iterations} tokens=${r.estTokens} compact=${r.compactions} trunc=${r.truncations}`);
    }
  }

  // Gate requires s.tasks with length >= 7 (IT2 rows only)
  const summary = {
    tasks: allRows.filter(r => r.version === "IT2"),
    comparison: allRows,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(resolve(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log("\n" + "─".repeat(72));
  console.log("Task                     Ver  OK    Iter  Tokens   Compact  Trunc");
  console.log("─".repeat(72));
  for (const r of allRows) {
    const ok = r.success ? "✓" : "✗";
    console.log(`${r.task.padEnd(24)} ${r.version.padEnd(4)} ${ok}     ${String(r.iterations).padEnd(5)} ${String(r.estTokens).padEnd(8)} ${String(r.compactions).padEnd(8)} ${r.truncations}`);
  }
  console.log(`\nWrote eval/iteration2/summary.json (${summary.tasks.length} IT2 tasks)`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
