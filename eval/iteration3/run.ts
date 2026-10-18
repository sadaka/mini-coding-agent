/**
 * Iteration 3 evaluation harness (FR-62, FR-64, AC-38).
 *
 * Runs a fixture task against the frozen Iteration 2 source ("baseline", eval/iteration3/baseline-src) or the
 * current source, records a trace of every tool call, computes the section 33 metrics from that trace and the
 * ground-truth manifest, and re-runs the manifest's verification command outside the agent. A run succeeds only
 * if that command passes; the agent's own claim is recorded but never trusted.
 *
 * Real providers cost money: the CLI refuses to start without --model and a --max-runs cap (DECISION-8791b3de).
 *
 *   tsx eval/iteration3/run.ts --provider claude --model M --max-runs 60 [--task DIR ...] [--runs 5] [--out FILE]
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { LLMProvider, Message, Tool, ToolResult } from "../../src/types/index.js";
import { defaultTokenEstimator } from "../../src/context/token-estimator.js";
import { installMeter } from "./real-context/run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
export const FIXTURES = join(HERE, "fixtures");

export type Source = "baseline" | "current";

export interface Manifest {
  task: string;
  repo_type: string;
  relevant_files: string[];
  acceptable_files: string[];
  target_symbols: string[];
  verification: { command: string };
}

/** One tool call as the agent made it. `startMs` is relative to the start of the run. */
export interface TraceCall {
  tool: string;
  input: Record<string, unknown>;
  isError: boolean;
  output: string;
  startMs: number;
}

export interface Metrics {
  navigationCalls: number;
  callsByType: Record<string, number>;
  searches: number;
  directoryListings: number;
  symbolSearches: number;
  repeatedSearches: number;
  filesRead: number;
  relevantFilesRead: number;
  acceptableFilesRead: number;
  irrelevantFilesRead: number;
  /** Tool calls made before the first successful read of a relevant file; null if none was ever read. */
  toolCallsBeforeFirstRelevantRead: number | null;
  msToFirstRelevantRead: number | null;
  treeSitterSymbolMatches: number;
  fallbackSymbolMatches: number;
  irrelevantSymbolMatches: number;
}

export interface RunResult {
  task: string;
  source: Source;
  run: number;
  agentStatus: string;
  agentClaimedSuccess: boolean;
  verificationExitCode: number | null;
  verified: boolean;
  /** Equals `verified`: the independent check decides, never the agent. */
  success: boolean;
  metrics: Metrics;
  efficiency: { llmCalls: number; totalContextSentTokens: number; peakContextTokens: number; wallMs: number };
}

export function loadManifest(taskDir: string): Manifest {
  return JSON.parse(readFileSync(join(taskDir, "manifest.json"), "utf8")) as Manifest;
}

const norm = (p: string) => posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
const SEARCH_TOOLS = new Set(["search", "list_directory", "find_symbol", "find_tests"]);
const DECLARATION = /^(.+?):(\d+)-(\d+) (\w+) (\S+) \[tree-sitter/;
const TEXT_MATCH = /^(.+?):(\d+): .* \[text-search/;

/** Pure: everything here comes from the trace and the manifest, never from the agent's own report (FR-62). */
export function computeMetrics(trace: TraceCall[], manifest: Manifest): Metrics {
  const relevant = new Set(manifest.relevant_files.map(norm));
  const acceptable = new Set(manifest.acceptable_files.map(norm));
  const known = (p: string) => relevant.has(p) || acceptable.has(p);

  const callsByType: Record<string, number> = {};
  const seen = new Set<string>();
  let repeatedSearches = 0;
  let tsMatches = 0;
  let fallbackMatches = 0;
  let irrelevantMatches = 0;
  const read = new Set<string>();
  let firstRelevant: number | null = null;

  trace.forEach((c, i) => {
    callsByType[c.tool] = (callsByType[c.tool] ?? 0) + 1;
    if (SEARCH_TOOLS.has(c.tool)) {
      const key = c.tool + JSON.stringify(Object.entries(c.input).sort(([a], [b]) => (a < b ? -1 : 1)));
      if (seen.has(key)) repeatedSearches++;
      seen.add(key);
    }
    if (c.tool === "read_file" && !c.isError && typeof c.input.path === "string") {
      const p = norm(c.input.path);
      read.add(p);
      if (firstRelevant === null && relevant.has(p)) firstRelevant = i;
    }
    if (c.tool === "find_symbol" && !c.isError) {
      for (const line of c.output.split("\n")) {
        const decl = DECLARATION.exec(line);
        const text = decl ? null : TEXT_MATCH.exec(line);
        if (!decl && !text) continue;
        if (decl) tsMatches++;
        else fallbackMatches++;
        if (!known(norm((decl ?? text)![1]!))) irrelevantMatches++;
      }
    }
  });

  const nav = ["list_directory", "find_symbol", "find_tests"];
  return {
    navigationCalls: nav.reduce((n, t) => n + (callsByType[t] ?? 0), 0),
    callsByType,
    searches: callsByType.search ?? 0,
    directoryListings: callsByType.list_directory ?? 0,
    symbolSearches: callsByType.find_symbol ?? 0,
    repeatedSearches,
    filesRead: read.size,
    relevantFilesRead: [...read].filter((p) => relevant.has(p)).length,
    acceptableFilesRead: [...read].filter((p) => acceptable.has(p)).length,
    irrelevantFilesRead: [...read].filter((p) => !known(p)).length,
    toolCallsBeforeFirstRelevantRead: firstRelevant,
    msToFirstRelevantRead: firstRelevant === null ? null : trace[firstRelevant]!.startMs,
    treeSitterSymbolMatches: tsMatches,
    fallbackSymbolMatches: fallbackMatches,
    irrelevantSymbolMatches: irrelevantMatches,
  };
}

// The two sources expose the same module shapes (baseline-src is a verbatim copy of Iteration 2 src).
interface Loaded {
  runAgentLoop: (task: string, provider: LLMProvider, registry: ToolRegistry, config?: object) => Promise<{ status: string }>;
  ToolRegistry: new () => ToolRegistry;
  tools: Array<(root: string) => Tool>;
}
interface ToolRegistry {
  register(tool: Tool): void;
}

const loaded = new Map<Source, Promise<Loaded>>();
function load(source: Source): Promise<Loaded> {
  let p = loaded.get(source);
  if (!p) {
    const dir = source === "baseline" ? join(HERE, "baseline-src") : join(ROOT, "src");
    const mod = (rel: string) => import(pathToFileURL(join(dir, rel)).href);
    p = (async () => {
      const [loop, reg, search, readfile, edit, run] = await Promise.all(
        ["agent/loop.ts", "tools/registry.ts", "tools/search.ts", "tools/readfile.ts", "tools/editfile.ts", "tools/runcommand.ts"].map(mod),
      );
      if (source === "current") {
        // The CLI does this at startup (IMPL-IT3-14); find_symbol needs the providers registered.
        (await mod("navigation/symbols/languages/javascript-typescript.ts")).registerJavaScriptTypeScriptProviders();
        (await mod("navigation/symbols/languages/python.ts")).registerPythonProvider();
      }
      return {
        runAgentLoop: loop.runAgentLoop,
        ToolRegistry: reg.ToolRegistry,
        tools: [search.createSearchTool, readfile.createReadFileTool, edit.createEditFileTool, run.createRunCommandTool],
      };
    })();
    loaded.set(source, p);
  }
  return p;
}

const textOf = (m: Message) =>
  m.content.map((c) => (c.type === "text" ? c.text : c.type === "tool_call" ? `${c.name}(${JSON.stringify(c.input)})` : c.type === "tool_result" ? c.content : "")).join("\n");

export interface RunOptions {
  /** A directory under fixtures/ holding description.txt, manifest.json and repo/. */
  taskDir: string;
  source: Source;
  run: number;
  makeProvider: (workspace: string) => LLMProvider;
  maxIterations?: number;
}

export async function runOnce(opts: RunOptions): Promise<RunResult> {
  const manifest = loadManifest(opts.taskDir);
  const description = readFileSync(join(opts.taskDir, "description.txt"), "utf8").trim();
  const workspace = mkdtempSync(join(tmpdir(), `eval-${manifest.task}-`));
  try {
    cpSync(join(opts.taskDir, "repo"), workspace, { recursive: true });
    const { runAgentLoop, ToolRegistry, tools } = await load(opts.source);
    const started = Date.now();

    // Every tool the loop can reach goes through here, including the navigation tools the loop registers itself.
    const trace: TraceCall[] = [];
    const registry = new ToolRegistry();
    const register = registry.register.bind(registry);
    registry.register = (tool: Tool) =>
      register({
        definition: tool.definition,
        async execute(input: Record<string, unknown>): Promise<ToolResult> {
          const startMs = Date.now() - started;
          const result = await tool.execute(input);
          trace.push({ tool: tool.definition.name, input, isError: result.isError, output: result.content, startMs });
          return result;
        },
      });
    for (const make of tools) registry.register(make(workspace));

    const provider = opts.makeProvider(workspace);
    let llmCalls = 0;
    let total = 0;
    let peak = 0;
    const measured: LLMProvider = {
      ...provider,
      capabilities: provider.capabilities?.bind(provider),
      async generate(messages, defs) {
        const tokens = messages.reduce((n, m) => n + defaultTokenEstimator.estimate(textOf(m)), 0);
        llmCalls++;
        total += tokens;
        peak = Math.max(peak, tokens);
        return provider.generate(messages, defs);
      },
    };

    const result = await runAgentLoop(description, measured, registry, {
      maxIterations: opts.maxIterations,
      ...(opts.source === "current" ? { workspaceRoot: workspace } : {}),
    });
    const wallMs = Date.now() - started;

    // Independent check: outside the agent, in the workspace the agent left behind.
    const verify = spawnSync(manifest.verification.command, { cwd: workspace, shell: true, encoding: "utf8", timeout: 120_000 });
    const verified = verify.status === 0;
    return {
      task: manifest.task,
      source: opts.source,
      run: opts.run,
      agentStatus: result.status,
      agentClaimedSuccess: result.status === "success",
      verificationExitCode: verify.status,
      verified,
      success: verified,
      metrics: computeMetrics(trace, manifest),
      efficiency: { llmCalls, totalContextSentTokens: total, peakContextTokens: peak, wallMs },
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      "max-runs": { type: "string" },
      "max-cost-usd": { type: "string" },
      runs: { type: "string" },
      task: { type: "string", multiple: true },
      out: { type: "string" },
    },
  });
  const maxRuns = Number(values["max-runs"]);
  const maxCost = Number(values["max-cost-usd"]);
  if (!values.provider || !values.model || !Number.isInteger(maxRuns) || maxRuns <= 0 || !(maxCost > 0)) {
    console.error("Refusing to run: a real provider costs money. Pass --provider, --model, --max-runs N and --max-cost-usd X (DECISION-8791b3de).");
    process.exit(2);
  }
  if (values.provider !== "claude") {
    console.error("Refusing to run: the cost meter only reads Anthropic usage, so only --provider claude can be bounded.");
    process.exit(2);
  }
  const taskDirs = (values.task?.length ? values.task : readdirSync(FIXTURES).filter((d) => !d.startsWith("."))).map((d) => join(FIXTURES, d));
  const runs = Number(values.runs ?? 5);
  const sources: Source[] = ["baseline", "current"];
  const planned = taskDirs.length * sources.length * runs;
  if (planned > maxRuns) {
    console.error(`Refusing to run: ${planned} runs planned (${taskDirs.length} tasks x ${sources.length} sources x ${runs}) exceeds --max-runs ${maxRuns}.`);
    process.exit(2);
  }
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.startsWith("#") && !(line.slice(0, eq).trim() in process.env)) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch { /* .env is optional */ }
  if (values.provider === "claude") process.env.CLAUDE_MODEL = values.model;
  else process.env.GEMINI_MODEL = values.model;
  const { ClaudeAdapter } = await import("../../src/providers/claude/index.js");
  const { GeminiAdapter } = await import("../../src/providers/gemini/index.js");
  const makeProvider = () => (values.provider === "claude" ? new ClaudeAdapter() : new GeminiAdapter());

  // The ledger survives restarts, so repeated invocations share one budget. The meter must be installed
  // before any adapter is built (the SDK captures fetch at construction).
  const ledgerFile = join(HERE, "results", "ledger.json");
  mkdirSync(dirname(ledgerFile), { recursive: true });
  const prior = existsSync(ledgerFile) ? (JSON.parse(readFileSync(ledgerFile, "utf8")) as { costUsd: number }).costUsd : 0;
  if (prior >= maxCost) {
    console.error(`Refusing to run: $${prior.toFixed(4)} of $${maxCost} already spent.`);
    process.exit(2);
  }
  const meter = installMeter(values.model, maxCost - prior);
  let worstRunUsd = 0;
  const results: RunResult[] = [];
  for (const taskDir of taskDirs) {
    for (const source of sources) {
      for (let run = 1; run <= runs; run++) {
        // Never start a run that the most expensive run so far could push over the limit; a mid-run guard
        // failure would also be recorded as a failed agent run and contaminate the comparison.
        const before = meter.spentUsd();
        if (prior + before + worstRunUsd > maxCost) {
          console.error(`Stopping: $${(prior + before).toFixed(4)} spent, next run could cost $${worstRunUsd.toFixed(4)}, limit $${maxCost}.`);
          writeResults(results);
          process.exit(3);
        }
        const r = await runOnce({ taskDir, source, run, makeProvider });
        worstRunUsd = Math.max(worstRunUsd, meter.spentUsd() - before);
        writeFileSync(ledgerFile, JSON.stringify({ costUsd: Number((prior + meter.spentUsd()).toFixed(6)) }));
        results.push(r);
        console.log(`${r.task} ${source} #${run}: ${r.success ? "VERIFIED" : "failed"} (agent said ${r.agentStatus})`);
      }
    }
  }
  writeResults(results);
  console.log(`Spent $${(prior + meter.spentUsd()).toFixed(4)} of $${maxCost}.`);

  function writeResults(rs: RunResult[]): void {
    const out = values.out ?? join(HERE, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(rs, null, 2));
    console.log(`Wrote ${rs.length} runs to ${out}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
