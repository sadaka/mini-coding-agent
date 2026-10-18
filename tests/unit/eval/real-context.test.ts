import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "../../../src/types/index.js";
import { checkPairing, installMeter, runRealContext } from "../../../eval/iteration3/real-context/run.js";

const call = (id: string): Message => ({ role: "assistant", content: [{ type: "tool_call", id, name: "x", input: {} }] });
const result = (id: string): Message => ({ role: "tool", content: [{ type: "tool_result", toolCallId: id, toolName: "x", content: "ok", isError: false }] });

describe("checkPairing", () => {
  it("accepts a well-formed history", () => {
    expect(checkPairing([call("a"), result("a"), call("b"), result("b")])).toEqual([]);
  });
  it("flags a tool_result that answers a different iteration's call", () => {
    expect(checkPairing([call("a"), result("a"), call("b"), result("a")]).length).toBeGreaterThan(0);
  });
  it("flags an unanswered tool_call", () => {
    expect(checkPairing([call("a"), call("b"), result("b")]).length).toBeGreaterThan(0);
  });
});

// A scripted Anthropic Messages endpoint: list, search for "round", read the real defect, then the lookalikes, then finish.
// `usage` is what gets billed.
const STEPS: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: "list_directory", input: { path: "src/modules" } },
  { name: "search", input: { query: "round" } },
  { name: "find_symbol", input: { symbol_name: "roundCents" } },
  { name: "read_file", input: { path: "src/billing/round.js" } },
  ...Array.from({ length: 24 }, (_, i) => ({ name: "read_file", input: { path: `src/modules/m${String(i + 1).padStart(2, "0")}.js` } })),
];
let server: Server;
let turn = 0;
let usage = { input_tokens: 1000, output_tokens: 100 };
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const step = STEPS[turn++];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `msg_${turn}`, type: "message", role: "assistant", model: "test",
        content: step ? [{ type: "tool_use", id: `toolu_${turn}`, name: step.name, input: step.input }] : [{ type: "text", text: "done" }],
        stop_reason: step ? "tool_use" : "end_turn",
        usage,
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  process.env.ANTHROPIC_API_KEY = "test-key";
});
afterAll(() => {
  server.close();
  delete process.env.ANTHROPIC_BASE_URL;
});
afterEach(() => {
  turn = 0;
  usage = { input_tokens: 1000, output_tokens: 100 };
});

describe("installMeter", () => {
  it("refuses the next request once the budget is spent", async () => {
    usage = { input_tokens: 1_000_000, output_tokens: 0 }; // $0.10 at Haiku 5.5
    const meter = installMeter("claude-haiku-5-5", 0.05);
    try {
      const post = () => fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
      expect((await post()).ok).toBe(true);
      expect(meter.spentUsd()).toBeCloseTo(0.1, 6);
      await expect(post()).rejects.toThrow(/cost guard/);
    } finally {
      meter.restore();
    }
  });
  it("refuses a model with no recorded price", () => {
    expect(() => installMeter("claude-unknown", 1)).toThrow(/No price/);
  });
});

describe("runRealContext (fake endpoint, no spend)", () => {
  let out: string;
  afterEach(() => out && rmSync(out, { recursive: true, force: true }));

  it("forces compaction, keeps pairing valid, and writes the artifacts and ledger", async () => {
    out = mkdtempSync(join(tmpdir(), "rc-out-"));
    const r = await runRealContext({ model: "claude-haiku-5-5", maxRuns: 1, maxCostUsd: 1, outDir: out, maxIterations: 12 });
    // Context grows about 200 tokens per scripted call, so the 6,000-token window (threshold ~1,500) must compact inside 12 iterations.
    expect(r.compactions).toBeGreaterThan(0);
    // Compaction events alone proved nothing: the first paid runs fired them with 0 items dropped (history <= MAX_RECENT_ITEMS).
    expect(r.droppedItems).toBeGreaterThan(0);
    expect(r.pairingValid).toBe(true);
    expect(r.costUsd).toBeGreaterThan(0);
    const saved = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    expect(saved.pairingValid).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "ledger.json"), "utf8")).runs).toBe(1);
    for (const f of ["metrics.json", "transcript.json"]) expect(readFileSync(join(out, f), "utf8").length).toBeGreaterThan(2);
  });

  // The shape of the first paid runs: 4 requests, a history of at most 7 items. With the compactor's default of protecting the
  // newest 8, compaction fired five times and dropped nothing. The runner must shrink that window so a short run drops history.
  it("drops history even in a short run (4 requests)", async () => {
    out = mkdtempSync(join(tmpdir(), "rc-out-"));
    const r = await runRealContext({ model: "claude-haiku-5-5", maxRuns: 1, maxCostUsd: 1, outDir: out, maxIterations: 4 });
    expect(r.llmRequests).toBe(4);
    expect(r.droppedItems).toBeGreaterThan(0);
    expect(r.pairingValid).toBe(true);
  });

  it("refuses a second run beyond --max-runs, and a run when the dollars are spent", async () => {
    out = mkdtempSync(join(tmpdir(), "rc-out-"));
    await runRealContext({ model: "claude-haiku-5-5", maxRuns: 1, maxCostUsd: 1, outDir: out });
    await expect(runRealContext({ model: "claude-haiku-5-5", maxRuns: 1, maxCostUsd: 1, outDir: out })).rejects.toThrow(/authorized runs already used/);
    await expect(runRealContext({ model: "claude-haiku-5-5", maxRuns: 5, maxCostUsd: 0.0000001, outDir: out })).rejects.toThrow(/already spent/);
  });
});
