import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMResponse } from "../../../src/types/index.js";
import { FIXTURES, computeMetrics, runOnce, type Manifest, type RunResult, type TraceCall } from "../../../eval/iteration3/run.js";
import { checkResults } from "../../../eval/iteration3/check-results.js";

vi.setConfig({ testTimeout: 60_000 });

const TASK = join(FIXTURES, "a-unknown-location");
const manifest: Manifest = {
  task: "t",
  repo_type: "A",
  relevant_files: ["src/billing/money.ts"],
  acceptable_files: ["src/cart/cart.ts"],
  target_symbols: [],
  verification: { command: "true" },
};
const call = (tool: string, input: Record<string, unknown>, startMs: number, output = "", isError = false): TraceCall => ({ tool, input, isError, output, startMs });

describe("computeMetrics (FR-62, AC-38)", () => {
  // Hand-computed from this trace; nothing here comes from the agent's own report.
  const symbolOutput = "src/ui/format.ts:1-3 function dollars [tree-sitter]\nsrc/billing/money.ts:2: x [text-search]";
  const trace = [
    call("list_directory", { path: "." }, 10),
    call("find_symbol", { symbol_name: "x" }, 20, symbolOutput),
    call("read_file", { path: "src/ui/format.ts" }, 30),
    call("read_file", { path: "src/cart/cart.ts" }, 40),
    call("read_file", { path: "./src/billing/money.ts" }, 55),
    call("read_file", { path: "src/ui/format.ts" }, 60),
    call("find_symbol", { symbol_name: "x" }, 70, symbolOutput),
    call("read_file", { path: "missing.ts" }, 80, "ENOENT", true),
  ];

  it("counts reads against the manifest and times the first relevant read", () => {
    const m = computeMetrics(trace, manifest);
    expect(m.filesRead).toBe(3); // format.ts, cart.ts, money.ts; the repeat and the failed read do not count
    expect(m.relevantFilesRead).toBe(1);
    expect(m.acceptableFilesRead).toBe(1);
    expect(m.irrelevantFilesRead).toBe(1);
    expect(m.toolCallsBeforeFirstRelevantRead).toBe(4);
    expect(m.msToFirstRelevantRead).toBe(55); // "./src/billing/money.ts" is the relevant file after normalising
  });

  it("counts navigation, repeats and symbol matches", () => {
    const m = computeMetrics(trace, manifest);
    expect(m.callsByType).toEqual({ list_directory: 1, find_symbol: 2, read_file: 5 });
    expect(m.navigationCalls).toBe(3);
    expect(m.directoryListings).toBe(1);
    expect(m.symbolSearches).toBe(2);
    expect(m.repeatedSearches).toBe(1);
    expect(m.treeSitterSymbolMatches).toBe(2);
    expect(m.fallbackSymbolMatches).toBe(2);
    expect(m.irrelevantSymbolMatches).toBe(2); // the two format.ts declarations
  });

  it("reports null, not zero, when no relevant file was ever read", () => {
    const m = computeMetrics([call("read_file", { path: "src/ui/format.ts" }, 5)], manifest);
    expect(m.toolCallsBeforeFirstRelevantRead).toBeNull();
    expect(m.msToFirstRelevantRead).toBeNull();
    expect(m.relevantFilesRead).toBe(0);
  });
});

function scripted(steps: LLMResponse[]): () => LLMProvider {
  return () => {
    let i = 0;
    return { generate: async () => steps[i++] ?? { type: "text" as const, text: "Done." } };
  };
}
const tc = (id: string, name: string, input: Record<string, unknown>): LLMResponse => ({ type: "tool_calls", toolCalls: [{ id, name, input }] });
const FIX = tc("c3", "edit_file", { path: "src/billing/money.ts", operation: "replace", old_string: "return Math.floor(amount);", new_string: "return Math.round(amount);" });

describe("runOnce", () => {
  const goodRun = [tc("c1", "read_file", { path: "src/ui/format.ts" }), tc("c2", "read_file", { path: "src/billing/money.ts" }), FIX, { type: "text" as const, text: "Fixed." }];

  it.each(["baseline", "current"] as const)("runs the %s source, verifies independently and records the trace metrics", async (source) => {
    const r = await runOnce({ taskDir: TASK, source, run: 1, makeProvider: scripted(goodRun) });
    expect(r.verified).toBe(true);
    expect(r.success).toBe(true);
    expect(r.verificationExitCode).toBe(0);
    expect(r.metrics).toMatchObject({ filesRead: 2, relevantFilesRead: 1, irrelevantFilesRead: 1, toolCallsBeforeFirstRelevantRead: 1 });
    expect(r.efficiency.llmCalls).toBe(4);
    expect(r.efficiency.peakContextTokens).toBeGreaterThan(0);
    expect(r.efficiency.totalContextSentTokens).toBeGreaterThanOrEqual(r.efficiency.peakContextTokens);
  });

  it("gives the baseline the Iteration 2 tools only, and the current source the navigation tools", async () => {
    const probe = [tc("c1", "find_symbol", { symbol_name: "roundCents" }), { type: "text" as const, text: "Done." }];
    const base = await runOnce({ taskDir: TASK, source: "baseline", run: 1, makeProvider: scripted(probe) });
    const cur = await runOnce({ taskDir: TASK, source: "current", run: 1, makeProvider: scripted(probe) });
    expect(base.metrics.symbolSearches).toBe(0); // find_symbol does not exist in baseline-src
    expect(cur.metrics.symbolSearches).toBe(1);
    expect(cur.metrics.treeSitterSymbolMatches).toBeGreaterThan(0);
  });

  it("fails a run whose verification fails, whatever the agent claims", async () => {
    // The agent reads the right file, never fixes it, and announces success.
    const liar = [tc("c1", "read_file", { path: "src/billing/money.ts" }), { type: "text" as const, text: "All fixed, tests pass!" }];
    const r = await runOnce({ taskDir: TASK, source: "current", run: 1, makeProvider: scripted(liar) });
    expect(r.agentClaimedSuccess).toBe(true);
    expect(r.agentStatus).toBe("success");
    expect(r.verified).toBe(false);
    expect(r.verificationExitCode).not.toBe(0);
    expect(r.success).toBe(false);
  });

  it("starts every run from a pristine copy of the fixture", async () => {
    await runOnce({ taskDir: TASK, source: "current", run: 1, makeProvider: scripted(goodRun) });
    const again = await runOnce({ taskDir: TASK, source: "current", run: 2, makeProvider: scripted([{ type: "text", text: "Done." }]) });
    expect(again.verified).toBe(false); // the previous run's fix did not leak into this one
  });
});

describe("checkResults", () => {
  const run = (task: string, source: "baseline" | "current", n: number, over: Partial<RunResult> = {}): RunResult => ({
    task, source, run: n, agentStatus: "success", agentClaimedSuccess: true, verificationExitCode: 0, verified: true, success: true,
    metrics: computeMetrics([], manifest), efficiency: { llmCalls: 1, totalContextSentTokens: 1, peakContextTokens: 1, wallMs: 1 }, ...over,
  });
  const full = (tasks: string[]) => tasks.flatMap((t) => (["baseline", "current"] as const).flatMap((s) => [1, 2].map((n) => run(t, s, n))));

  it("accepts a complete result set", () => {
    expect(checkResults(full(["a", "b"]), ["a", "b"], 2)).toEqual([]);
  });

  it("reports a missing run, a missing task and a success that disagrees with verification", () => {
    const results = full(["a"]).filter((r) => !(r.source === "current" && r.run === 2));
    results[0] = run("a", "baseline", 1, { verified: false, success: true });
    const problems = checkResults(results, ["a", "b"], 2);
    expect(problems.join("\n")).toMatch(/a\/current: expected runs 1,2 but found \[1\]/);
    expect(problems.join("\n")).toMatch(/b\/baseline: expected runs 1,2 but found \[\]/);
    expect(problems.join("\n")).toMatch(/a\/baseline#1: success must equal the independent verification/);
  });
});

describe("CLI cost guard (DECISION-8791b3de)", () => {
  it("refuses to start a real-provider evaluation without a model and a run cap", () => {
    const r = spawnSync("npx", ["tsx", "eval/iteration3/run.ts", "--provider", "claude"], { cwd: process.cwd(), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("costs money");
  });

  it("refuses when the planned runs exceed the cap", () => {
    const r = spawnSync("npx", ["tsx", "eval/iteration3/run.ts", "--provider", "claude", "--model", "m", "--max-runs", "3", "--max-cost-usd", "1"], { cwd: process.cwd(), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("exceeds --max-runs 3");
  });

  it("refuses to start without a dollar cap, or with a provider the meter cannot read", () => {
    const base = ["tsx", "eval/iteration3/run.ts", "--model", "m", "--max-runs", "60"];
    const noCap = spawnSync("npx", [...base, "--provider", "claude"], { cwd: process.cwd(), encoding: "utf8" });
    expect(noCap.status).toBe(2);
    expect(noCap.stderr).toContain("--max-cost-usd");
    const gemini = spawnSync("npx", [...base, "--provider", "gemini", "--max-cost-usd", "1"], { cwd: process.cwd(), encoding: "utf8" });
    expect(gemini.status).toBe(2);
    expect(gemini.stderr).toContain("only --provider claude");
  });
});

describe("check-results CLI accepts the gate's --min-runs form", () => {
  it("reads --min-runs N, so an incomplete file fails instead of exiting with a usage error", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cr-")), "r.json");
    writeFileSync(file, "[]");
    const r = spawnSync("npx", ["tsx", "eval/iteration3/check-results.ts", file, "--min-runs", "2"], { cwd: process.cwd(), encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("expected runs 1,2 but found []");
  });
});
