import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const REPO = process.cwd();
let workspace: string;
let server: Server;
let baseUrl: string;
let requests: Array<{ tools: Array<{ name: string }>; first: string }>;
let turn: number;

// A scripted Anthropic Messages endpoint: list, find a symbol, repeat the same search, then finish.
const script = [
  { name: "list_directory", input: { path: "." } },
  { name: "find_symbol", input: { symbol_name: "roundCents" } },
  { name: "find_symbol", input: { symbol_name: "roundCents" } },
];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "debugnav-"));
  cpSync(join(REPO, "eval/iteration3/fixtures/a-unknown-location/repo"), workspace, { recursive: true });
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ tools: parsed.tools ?? [], first: JSON.stringify(parsed.messages[0]) });
      const step = script[turn++];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `msg_${turn}`, type: "message", role: "assistant", model: "test",
        content: step ? [{ type: "tool_use", id: `toolu_${turn}`, name: step.name, input: step.input }] : [{ type: "text", text: "done" }],
        stop_reason: step ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(workspace, { recursive: true, force: true });
});

function runCli(extra: string[]): Promise<string> {
  requests = [];
  turn = 0;
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", join(REPO, "src/cli/index.ts"), "fix the rounding", "--workspace", workspace, "--provider", "claude", ...extra], {
      cwd: workspace,
      env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "test-key", AGENT_PROVIDER: "claude" },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolve(out));
  });
}

const stripTimings = (s: string) => s.replace(/\(\d+ms\)/g, "(Nms)");

describe("--debug-navigation (AC-35)", () => {
  it("prints scope exclusions, each navigation call, the repeat and a bounded summary", async () => {
    const out = await runCli(["--debug-navigation"]);
    expect(out).toMatch(/\[nav\] scope excluded: .*node_modules/);
    expect(out).toContain('[nav] list_directory {"path":"."}');
    expect(out).toMatch(/\[nav\] find_symbol \{"symbol_name":"roundCents"\} → \d+ lines \(tree-sitter\)/);
    expect(out).toContain('[nav] repeat #2: find_symbol {"symbol_name":"roundCents"}');
    expect(out).toMatch(/\[nav\] summary: calls list_directory=1 find_symbol=2; files discovered=\d+ read=0; repeats=1;/);
    expect(out).not.toContain("export function roundCents"); // raw outputs are never dumped
  });

  it("without the flag prints no navigation lines, and nothing else differs", async () => {
    const off = await runCli([]);
    const on = await runCli(["--debug-navigation"]);
    expect(off).not.toContain("[nav]");
    expect(stripTimings(on).split("\n").filter((l) => !l.includes("[nav]")).join("\n")).toBe(stripTimings(off));
  });

  it("offers all navigation tools to the provider and describes them without a fixed sequence", async () => {
    await runCli([]);
    const names = requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search", "read_file", "edit_file", "run_command", "list_directory", "find_symbol", "find_tests"]));
    expect(requests[0].first).toContain("none is required first");
    expect(requests[0].first).not.toMatch(/step \d|first,? (call|use) list_directory/i);
  });
});
