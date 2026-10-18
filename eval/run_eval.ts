/**
 * Live evaluation runner for AC-12.
 * Runs the calculator bug-fix task N times against a real LLM provider.
 * Provider selected by AGENT_PROVIDER env var (gemini|claude, default: claude).
 * Independently verifies each run by checking the actual file content — never
 * trusting the agent's own final message.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = resolve(ROOT, "tests/fixtures/test-project");
const CALC_FILE = resolve(FIXTURE, "src/calculator.ts");
const LOG_DIR = resolve(ROOT, "eval");

// Load .env
try {
  const env = readFileSync(resolve(ROOT, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0 || line.startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch { /* .env optional */ }

// Import after env is loaded
const { GeminiAdapter } = await import("../src/providers/gemini/index.js");
const { ClaudeAdapter } = await import("../src/providers/claude/index.js");
const { ToolRegistry } = await import("../src/tools/registry.js");
const { createSearchTool } = await import("../src/tools/search.js");
const { createReadFileTool } = await import("../src/tools/readfile.js");
const { createEditFileTool } = await import("../src/tools/editfile.js");
const { createRunCommandTool } = await import("../src/tools/runcommand.js");
const { runAgentLoop } = await import("../src/agent/loop.js");
import type { LogEntry } from "../src/agent/logger.js";

const ORIGINAL_CALC = readFileSync(CALC_FILE, "utf8");

function resetFixture() {
  writeFileSync(CALC_FILE, ORIGINAL_CALC, "utf8");
}

function verifyIndependently(): { passed: boolean; reason: string } {
  // 1. Check file content — multiply must use * not just +
  const content = readFileSync(CALC_FILE, "utf8");
  const multiplyFn = content.match(/function multiply[\s\S]*?(?=\nexport function|\n$)/)?.[0] ?? "";
  if (!multiplyFn.includes("return a * b")) {
    return { passed: false, reason: `multiply still uses wrong operator. Body: ${multiplyFn.trim()}` };
  }

  // 2. Run the actual tests in the fixture
  try {
    execSync("npm test", { cwd: FIXTURE, stdio: "pipe" });
    return { passed: true, reason: "file fixed + npm test passed" };
  } catch (err: unknown) {
    const out = (err as { stdout?: Buffer; stderr?: Buffer });
    return {
      passed: false,
      reason: `file fixed but npm test failed: ${out.stdout?.toString().slice(0, 500) ?? ""}`,
    };
  }
}

const RUNS = 3;
const results: Array<{ run: number; agentStatus: string; verified: boolean; reason: string; logFile: string }> = [];

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

for (let run = 1; run <= RUNS; run++) {
  console.log(`\n${"=".repeat(60)}\nRun ${run}/${RUNS}\n${"=".repeat(60)}`);
  resetFixture();

  const registry = new ToolRegistry();
  registry.register(createSearchTool(FIXTURE));
  registry.register(createReadFileTool(FIXTURE));
  registry.register(createEditFileTool(FIXTURE));
  registry.register(createRunCommandTool(FIXTURE));

  const providerName = process.env.AGENT_PROVIDER ?? "claude";
  const provider = providerName === "gemini" ? new GeminiAdapter() : new ClaudeAdapter();
  const entries: LogEntry[] = [];

  const result = await runAgentLoop(
    "Fix the failing calculator test. The multiply function has a bug.",
    provider,
    registry,
    { maxIterations: 20 },
    (e) => {
      entries.push(e);
      if (["tool_started", "tool_completed", "tool_failed", "verification_completed"].includes(e.event)) {
        console.log(`  [${e.event}] ${e.toolName ?? ""} ${e.detail ?? ""}`);
      }
    }
  );

  // Independent verification — never trust agent's own message
  const verification = verifyIndependently();

  const logFile = resolve(LOG_DIR, `run${run}.log`);
  writeFileSync(logFile, JSON.stringify(entries, null, 2), "utf8");

  console.log(`\nAgent status : ${result.status}`);
  console.log(`Agent said   : ${result.finalMessage?.slice(0, 120) ?? "(none)"}`);
  console.log(`Independent  : ${verification.passed ? "PASS" : "FAIL"} — ${verification.reason}`);
  console.log(`Log          : eval/run${run}.log`);

  results.push({
    run,
    agentStatus: result.status,
    verified: verification.passed,
    reason: verification.reason,
    logFile: `eval/run${run}.log`,
  });

  resetFixture(); // restore for next run
}

console.log(`\n${"=".repeat(60)}\nSUMMARY\n${"=".repeat(60)}`);
const passed = results.filter((r) => r.verified).length;
console.log(`Success rate: ${passed}/${RUNS} (${Math.round((passed / RUNS) * 100)}%)`);
for (const r of results) {
  console.log(`  Run ${r.run}: agent=${r.agentStatus}, verified=${r.verified ? "PASS" : "FAIL"} — ${r.reason}`);
}

writeFileSync(
  resolve(LOG_DIR, "summary.json"),
  JSON.stringify({ runs: RUNS, passed, successRate: passed / RUNS, results }, null, 2),
  "utf8"
);
console.log("\nResults saved to eval/summary.json");
