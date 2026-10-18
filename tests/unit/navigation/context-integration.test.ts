import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../../../src/agent/loop.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import type { LLMProvider, ToolResult } from "../../../src/types/index.js";
import type { LogEntry } from "../../../src/agent/logger.js";

type Block = Record<string, unknown>;
type Msg = { role: string; content: Block[] };

const ENV = { MAX_CONTEXT_TOKENS: "2000", RESERVED_OUTPUT_TOKENS: "200", COMPACTION_THRESHOLD: "0.5", MAX_RECENT_ITEMS: "3" };
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  vi.restoreAllMocks();
});

const listing = (n: number) => Array.from({ length: n }, (_, i) => `src/mod${i}/index.ts:${i}: function handler${i}`).join("\n");
const tool = (name: string, content: string, isError = false) => ({
  definition: { name, description: name, inputSchema: { type: "object" as const, properties: {} } },
  execute: vi.fn(async (): Promise<ToolResult> => ({ content, isError })),
});

describe("navigation tools through forced compaction (AC-34)", () => {
  it("keeps tool_use/tool_result ids paired and ordered across search, read, find_symbol, edit and run_command", async () => {
    Object.assign(process.env, ENV);
    // Millisecond ties are what broke ordering before (INVARIANT-30642a03): advance once per LLM call.
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const registry = new ToolRegistry();
    registry.register(tool("search", listing(60)));
    registry.register(tool("read_file", listing(80)));
    registry.register(tool("find_symbol", listing(60)));
    registry.register(tool("list_directory", listing(60)));
    registry.register(tool("edit_file", "old_string not found", true));
    registry.register(tool("run_command", JSON.stringify({ exitCode: 1, stdout: listing(40), stderr: "FAIL", timedOut: false })));

    const sequence = ["search", "read_file", "find_symbol", "edit_file", "list_directory", "run_command"];
    const captured: Msg[][] = [];
    const log: LogEntry[] = [];
    const provider: LLMProvider = {
      generate: vi.fn(async (messages) => {
        captured.push(JSON.parse(JSON.stringify(messages)));
        now += 10;
        const n = captured.length;
        if (n > 24) return { type: "text" as const, text: "done" };
        return { type: "tool_calls" as const, toolCalls: [{ id: `toolu_${n}`, name: sequence[(n - 1) % sequence.length], input: { n } }] };
      }),
    };

    await runAgentLoop("find and fix the bug", provider, registry, { maxIterations: 30, repeatFailureThreshold: 99 }, (e) => log.push(e));

    expect(log.some((e) => e.event === "context_compaction_completed")).toBe(true);
    for (const [c, msgs] of captured.entries()) {
      for (let i = 0; i < msgs.length; i++) {
        const results = msgs[i].content.filter((b) => b.type === "tool_result").map((b) => b.toolCallId);
        if (!results.length) continue;
        const callIds = (msgs[i - 1]?.content ?? []).filter((b) => b.type === "tool_call").map((b) => b.id);
        for (const id of results) expect(callIds, `call ${c} msg ${i}: ${id} unpaired`).toContain(id);
      }
    }
  });
});
