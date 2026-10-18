/**
 * IMPL-IT3-18: one real-provider run that forces context compaction over the navigation tools, then checks that
 * every request the provider received kept the tool_use/tool_result pairing contract (INVARIANT-64d38bc1).
 *
 * This spends real money (DECISION-8791b3de). Hard limits, all enforced in code, not by estimate:
 *   - --model and --max-runs are mandatory; a ledger (ledger.json) counts runs and dollars across invocations,
 *     so repeated invocations cannot exceed --max-runs or --max-cost-usd.
 *   - A fetch-level meter adds up the provider's own `usage` figures and refuses the next request once the
 *     remaining budget is spent. (The Claude adapter only reports usage on text replies, so it cannot do this.)
 *   - A small CLAUDE_CONTEXT_WINDOW makes compaction fire after a few thousand tokens, and a small output cap
 *     bounds each reply, which together bound what any single request can cost.
 *
 *   tsx eval/iteration3/real-context/run.ts --model claude-haiku-5-5 --max-runs 3 --max-cost-usd 1
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Message } from "../../../src/types/index.js";
import type { LogEntry } from "../../../src/agent/logger.js";
import { defaultTokenEstimator } from "../../../src/context/token-estimator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

const TASK =
  "Invoice totals are off by a cent: an item priced 1.236 should total 1.24 but the invoice reports 1.23. " +
  "Find where amounts are rounded, fix it, and verify with `node check.js`.";
const VERIFY = "node check.js";

/**
 * A repository big enough that navigation output alone crosses the compaction threshold of a small window
 * (the Iteration 3 fixtures are only a few KB). Many lookalike modules mention "round" and "amount", so searches
 * return long listings; the one real defect is in src/billing/round.js.
 */
export function buildWorkspace(dir: string): void {
  const put = (rel: string, body: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  put("package.json", '{ "name": "invoices", "type": "module", "private": true }\n');
  put("src/billing/round.js", "// Rounds a money amount to whole cents.\nexport function roundCents(amount) {\n  return Math.floor(amount * 100) / 100;\n}\n");
  put("src/billing/invoice.js", 'import { roundCents } from "./round.js";\n\nexport function invoiceTotal(items) {\n  return roundCents(items.reduce((sum, i) => sum + i.price * i.qty, 0));\n}\n');
  put("check.js", 'import { invoiceTotal } from "./src/billing/invoice.js";\nconst got = invoiceTotal([{ price: 1.236, qty: 1 }]);\nif (got !== 1.24) { console.error(`expected 1.24, got ${got}`); process.exit(1); }\nconsole.log("ok");\n');
  for (let n = 1; n <= 24; n++) {
    const id = String(n).padStart(2, "0");
    put(
      `src/modules/m${id}.js`,
      [
        `// Module ${id}: display helpers for amount columns in report ${id}. Does not round money; see src/billing.`,
        `export function formatAmount${id}(amount, currency = "USD") {`,
        `  // amount is already rounded by the caller; round-trip it through a fixed-width string for column ${id}.`,
        "  const text = amount.toFixed(2);",
        "  return `${currency} ${text}`.padStart(16, \" \");",
        "}",
        "",
        `export function describeAmount${id}(label, amount) {`,
        `  // Used by report ${id}: round display only, never the stored amount.`,
        `  return label + ": " + formatAmount${id}(amount);`,
        "}",
        "",
      ].join("\n"),
    );
  }
}

/** USD per million tokens [input, output], from the Claude API model table (Haiku 5.5 is for prompts <= 100K). */
export const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
};

/** Pairing check by ids: every tool_use answered by the very next message, every tool_result answering the one before. */
export function checkPairing(messages: Message[]): string[] {
  const problems: string[] = [];
  const callIds = (m: Message | undefined) =>
    new Set(m?.content.flatMap((c) => (c.type === "tool_call" ? [c.id] : [])) ?? []);
  const resultIds = (m: Message | undefined) =>
    (m?.content ?? []).flatMap((c) => (c.type === "tool_result" ? [c.toolCallId] : []));
  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      const next = messages[i + 1];
      const answered = new Set(next?.role === "tool" ? resultIds(next) : []);
      for (const id of callIds(m)) if (!answered.has(id)) problems.push(`message ${i}: tool_call ${id} is not answered by message ${i + 1}`);
    } else if (m.role === "tool") {
      const expected = callIds(messages[i - 1]);
      for (const id of resultIds(m)) if (!expected.has(id)) problems.push(`message ${i}: tool_result ${id} has no tool_call in message ${i - 1}`);
    }
  });
  return problems;
}

export interface Meter {
  spentUsd: () => number;
  requests: () => number;
  tokens: () => { input: number; output: number };
  restore: () => void;
}

/** Wraps globalThis.fetch (which the Anthropic SDK captures at construction, so install before creating the adapter). */
export function installMeter(model: string, limitUsd: number): Meter {
  const price = PRICES[model];
  if (!price) throw new Error(`No price recorded for ${model}; add it to PRICES from the API model table before spending.`);
  const original = globalThis.fetch;
  let input = 0;
  let output = 0;
  let requests = 0;
  const spent = () => (input * price[0] + output * price[1]) / 1e6;
  globalThis.fetch = async (url, init) => {
    if (spent() >= limitUsd) throw new Error(`cost guard: $${spent().toFixed(4)} spent, limit $${limitUsd.toFixed(2)}`);
    const res = await original(url, init);
    if (String(url).includes("/v1/messages") && res.ok) {
      const body = (await res.clone().json()) as { usage?: Record<string, number> };
      const u = body.usage ?? {};
      requests++;
      input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      output += u.output_tokens ?? 0;
    }
    return res;
  };
  return {
    spentUsd: spent,
    requests: () => requests,
    tokens: () => ({ input, output }),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

interface Ledger {
  runs: number;
  costUsd: number;
}
const readLedger = (dir: string): Ledger =>
  existsSync(join(dir, "ledger.json")) ? (JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as Ledger) : { runs: 0, costUsd: 0 };

export interface RealContextOptions {
  model: string;
  maxRuns: number;
  maxCostUsd: number;
  outDir?: string;
  /** Context window the adapter reports; small, so compaction fires early and requests stay cheap. */
  window?: number;
  maxOutputTokens?: number;
  maxIterations?: number;
  /** The compactor never drops the newest N items (default 8); a short run stays inside that and drops nothing. */
  maxRecentItems?: number;
}

let providersRegistered = false; // the symbol registry throws on a second registration

export async function runRealContext(opts: RealContextOptions): Promise<Record<string, unknown>> {
  const outDir = opts.outDir ?? HERE;
  mkdirSync(outDir, { recursive: true });
  const ledger = readLedger(outDir);
  if (ledger.runs >= opts.maxRuns) throw new Error(`Refusing to run: ${ledger.runs} of ${opts.maxRuns} authorized runs already used.`);
  const remaining = opts.maxCostUsd - ledger.costUsd;
  if (remaining <= 0) throw new Error(`Refusing to run: $${ledger.costUsd.toFixed(4)} of $${opts.maxCostUsd} already spent.`);

  const window = opts.window ?? 6_000;
  const maxIterations = opts.maxIterations ?? 12;
  process.env.CLAUDE_MODEL = opts.model;
  process.env.CLAUDE_CONTEXT_WINDOW = String(window);
  process.env.MAX_RECENT_ITEMS = String(opts.maxRecentItems ?? 2);
  process.env.CLAUDE_MAX_OUTPUT_TOKENS = String(opts.maxOutputTokens ?? 3000);

  const meter = installMeter(opts.model, remaining);
  const workspace = mkdtempSync(join(tmpdir(), "real-context-"));
  try {
    buildWorkspace(workspace);
    const task = TASK;

    const { ClaudeAdapter } = await import("../../../src/providers/claude/index.js");
    const { runAgentLoop } = await import("../../../src/agent/loop.js");
    const { ToolRegistry } = await import("../../../src/tools/registry.js");
    const { createSearchTool } = await import("../../../src/tools/search.js");
    const { createReadFileTool } = await import("../../../src/tools/readfile.js");
    const { createEditFileTool } = await import("../../../src/tools/editfile.js");
    const { createRunCommandTool } = await import("../../../src/tools/runcommand.js");
    if (!providersRegistered) {
      (await import("../../../src/navigation/symbols/languages/javascript-typescript.js")).registerJavaScriptTypeScriptProviders();
      (await import("../../../src/navigation/symbols/languages/python.js")).registerPythonProvider();
      providersRegistered = true;
    }

    const registry = new ToolRegistry();
    for (const make of [createSearchTool, createReadFileTool, createEditFileTool, createRunCommandTool]) registry.register(make(workspace));

    const real = new ClaudeAdapter();
    const requests: Array<{ call: number; messages: number; estimatedTokens: number; pairingProblems: string[] }> = [];
    let lastSent: Message[] = [];
    const provider = {
      capabilities: () => real.capabilities(),
      async generate(messages: Message[], tools: Parameters<typeof real.generate>[1]) {
        lastSent = JSON.parse(JSON.stringify(messages)) as Message[];
        const text = messages.map((m) => JSON.stringify(m.content)).join("\n");
        requests.push({ call: requests.length + 1, messages: messages.length, estimatedTokens: defaultTokenEstimator.estimate(text), pairingProblems: checkPairing(messages) });
        return real.generate(messages, tools);
      },
    };

    const events: LogEntry[] = [];
    const started = Date.now();
    const result = await runAgentLoop(task, provider, registry, { maxIterations, workspaceRoot: workspace }, (e) => events.push(e));
    const verify = spawnSync(VERIFY, { cwd: workspace, shell: true, encoding: "utf8", timeout: 120_000 });

    const compactions = events.filter((e) => e.event === "context_compaction_completed").length;
    const pairingProblems = requests.flatMap((r) => r.pairingProblems.map((p) => `request ${r.call}: ${p}`));
    const spent = meter.spentUsd();
    const res = {
      provider: "claude",
      model: opts.model,
      contextWindow: window,
      pairingValid: requests.length > 0 && pairingProblems.length === 0,
      pairingProblems,
      compactions,
      droppedItems: events.filter((e) => e.event === "context_item_dropped").reduce((n, e) => n + (e.droppedItems ?? 0), 0),
      llmRequests: requests.length,
      billedRequests: meter.requests(),
      tokens: meter.tokens(),
      costUsd: Number(spent.toFixed(6)),
      agentStatus: result.status,
      agentReason: result.reason ?? null,
      verified: verify.status === 0,
      wallMs: Date.now() - started,
      navigation: result.navigation ?? null,
    };
    writeFileSync(join(outDir, "result.json"), JSON.stringify(res, null, 2));
    writeFileSync(join(outDir, "metrics.json"), JSON.stringify({ requests, navigation: result.navigation ?? null, tokens: res.tokens, costUsd: res.costUsd }, null, 2));
    // The full event log plus the last request exactly as the provider received it (after compaction).
    writeFileSync(join(outDir, "transcript.json"), JSON.stringify({ task, events, lastRequestMessages: lastSent, finalMessage: result.finalMessage ?? null }, null, 2));
    writeFileSync(join(outDir, "ledger.json"), JSON.stringify({ runs: ledger.runs + 1, costUsd: Number((ledger.costUsd + spent).toFixed(6)) }));
    return res;
  } finally {
    meter.restore();
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { model: { type: "string" }, "max-runs": { type: "string" }, "max-cost-usd": { type: "string" }, window: { type: "string" } },
  });
  const maxRuns = Number(values["max-runs"]);
  const maxCost = Number(values["max-cost-usd"]);
  if (!values.model || !Number.isInteger(maxRuns) || maxRuns <= 0 || !(maxCost > 0)) {
    console.error("Refusing to run: a real provider costs money. Pass --model, --max-runs N and --max-cost-usd X (DECISION-8791b3de).");
    process.exit(2);
  }
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.startsWith("#") && !(line.slice(0, eq).trim() in process.env)) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch { /* .env is optional */ }
  const r = await runRealContext({ model: values.model, maxRuns, maxCostUsd: maxCost, window: values.window ? Number(values.window) : undefined });
  console.log(JSON.stringify({ pairingValid: r.pairingValid, compactions: r.compactions, costUsd: r.costUsd, llmRequests: r.llmRequests, agentStatus: r.agentStatus, verified: r.verified }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
