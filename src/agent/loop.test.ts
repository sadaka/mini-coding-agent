import { afterEach, describe, it, expect, vi } from "vitest";
import type { LLMProvider, LLMResponse, ToolDefinition, ToolResult } from "../types/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop } from "./loop.js";
import type { LogEntry } from "./logger.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockProvider(responses: LLMResponse[]): LLMProvider {
  let i = 0;
  return {
    generate: vi.fn(async () => {
      if (i >= responses.length) return { type: "text" as const, text: "done" };
      return responses[i++];
    }),
  };
}

function makeTool(
  name: string,
  result: ToolResult,
  schema: ToolDefinition["inputSchema"] = { type: "object", properties: {} }
) {
  return {
    definition: { name, description: name, inputSchema: schema },
    execute: vi.fn(async () => result),
  };
}

function collectEvents(entries: LogEntry[]) {
  return entries.map((e) => e.event);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("agent loop", () => {
  it("returns success on immediate text response", async () => {
    const provider = makeMockProvider([{ type: "text", text: "All done" }]);
    const registry = new ToolRegistry();
    const result = await runAgentLoop("fix bug", provider, registry);
    expect(result.status).toBe("success");
    expect(result.finalMessage).toBe("All done");
  });

  it("executes a tool call and then completes on text", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool("search", { content: "found foo.ts:1: match", isError: false });
    registry.register(tool);

    const provider = makeMockProvider([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "search", input: { query: "foo" } }] },
      { type: "text", text: "done" },
    ]);

    const result = await runAgentLoop("find foo", provider, registry);
    expect(result.status).toBe("success");
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("records changesMade when edit_file succeeds", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool("edit_file", { content: "Written: fix.ts", isError: false });
    registry.register(tool);

    const provider = makeMockProvider([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "edit_file", input: { path: "fix.ts", operation: "write", content: "x" } }] },
      { type: "text", text: "done" },
    ]);

    const result = await runAgentLoop("edit fix.ts", provider, registry);
    expect(result.changesMade).toContain("fix.ts");
  });

  it("handles unknown tool gracefully and continues", async () => {
    const registry = new ToolRegistry(); // no tools registered
    const provider = makeMockProvider([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "ghost_tool", input: {} }] },
      { type: "text", text: "done" },
    ]);

    const result = await runAgentLoop("task", provider, registry);
    expect(result.status).toBe("success");
  });

  it("stops at iteration limit and returns reason=iteration_limit", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool("search", { content: "found", isError: false });
    registry.register(tool);

    // Always return a tool call — never finishes
    const provider: LLMProvider = {
      generate: vi.fn(async () => ({
        type: "tool_calls" as const,
        toolCalls: [{ id: "c1", name: "search", input: { query: "x" } }],
      })),
    };

    const result = await runAgentLoop("task", provider, registry, { maxIterations: 3 });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("iteration_limit");
  });

  it("stops on repeated identical failed action", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool("run_command", { content: "Command denied", isError: true });
    registry.register(tool);

    const provider: LLMProvider = {
      generate: vi.fn(async () => ({
        type: "tool_calls" as const,
        toolCalls: [{ id: "c1", name: "run_command", input: { command: "rm -rf /" } }],
      })),
    };

    const result = await runAgentLoop("task", provider, registry, {
      maxIterations: 20,
      repeatFailureThreshold: 3,
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/repeated 3 times/);
  });

  it("stops on the same error even when tool input differs each time", async () => {
    // Truncated tool arguments differ by a byte or two every retry, so keying the
    // repeat guard on input let the agent burn all 20 iterations on one broken edit.
    const registry = new ToolRegistry();
    const tool = makeTool("edit_file", { content: "Unknown operation: . Use 'write' or 'replace'.", isError: true });
    registry.register(tool);

    let n = 0;
    const provider: LLMProvider = {
      generate: vi.fn(async () => ({
        type: "tool_calls" as const,
        toolCalls: [{ id: `c${++n}`, name: "edit_file", input: { path: "g.html", content: "x".repeat(n) } }],
      })),
    };

    const result = await runAgentLoop("task", provider, registry, {
      maxIterations: 20,
      repeatFailureThreshold: 3,
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/repeated 3 times/);
    expect(tool.execute).toHaveBeenCalledTimes(3);
  });

  it("does not trip the repeat guard when successful calls happen in between", async () => {
    // Real-world case: the model reached for an unsupported shell pipe a few times,
    // but search/read_file succeeded in between. Counting failures across the whole
    // run killed a task that was still progressing.
    const registry = new ToolRegistry();
    const bad = makeTool("run_command", { content: "Command denied: no shell", isError: true });
    const good = makeTool("search", { content: "hit", isError: false });
    registry.register(bad);
    registry.register(good);

    // fail, fail, succeed, fail, fail, succeed, fail — never 3 consecutive
    const script = ["run_command", "run_command", "search", "run_command", "run_command", "search", "run_command"];
    let n = 0;
    const provider: LLMProvider = {
      generate: vi.fn(async () => {
        if (n >= script.length) return { type: "text" as const, text: "done" };
        const name = script[n];
        return { type: "tool_calls" as const, toolCalls: [{ id: `c${n++}`, name, input: {} }] };
      }),
    };

    const result = await runAgentLoop("task", provider, registry, {
      maxIterations: 20,
      repeatFailureThreshold: 3,
    });
    expect(result.status).toBe("success");
    expect(bad.execute).toHaveBeenCalledTimes(5);
  });

  it("marks verificationPerformed and verificationPassed from npm test success", async () => {
    const registry = new ToolRegistry();
    const runTool = makeTool("run_command", {
      content: JSON.stringify({ exitCode: 0, stdout: "PASS", stderr: "", timedOut: false }),
      isError: false,
    });
    registry.register(runTool);

    const provider = makeMockProvider([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", input: { command: "npm test" } }] },
      { type: "text", text: "done" },
    ]);

    const result = await runAgentLoop("run tests", provider, registry);
    expect(result.verificationPerformed).toBe(true);
    expect(result.verificationPassed).toBe(true);
  });

  it("marks verificationPassed=false when npm test fails", async () => {
    const registry = new ToolRegistry();
    const runTool = makeTool("run_command", {
      content: JSON.stringify({ exitCode: 1, stdout: "", stderr: "FAIL", timedOut: false }),
      isError: true,
    });
    registry.register(runTool);

    const provider = makeMockProvider([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", input: { command: "npm test" } }] },
      { type: "text", text: "done" },
    ]);

    const result = await runAgentLoop("run tests", provider, registry);
    expect(result.verificationPerformed).toBe(true);
    expect(result.verificationPassed).toBe(false);
  });

  it("fails task when LLM provider throws", async () => {
    const registry = new ToolRegistry();
    const provider: LLMProvider = {
      generate: vi.fn(async () => { throw Object.assign(new Error("auth failed"), { code: "auth", retryable: false }); }),
    };

    const result = await runAgentLoop("task", provider, registry);
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/auth failed/);
  });

  it("never sends orphaned tool_use or tool_result to provider", async () => {
    // Simulates what happens after compaction drops one half of a pair.
    // The loop must strip the orphan before calling generate().
    const registry = new ToolRegistry();
    const tool = makeTool("search", { content: "result", isError: false });
    registry.register(tool);

    // Run enough iterations that compaction can fire under a tight policy
    process.env.MAX_CONTEXT_TOKENS = "800";
    process.env.RESERVED_OUTPUT_TOKENS = "100";
    process.env.COMPACTION_THRESHOLD = "0.5";
    process.env.ENABLE_COMPACTION = "true";
    process.env.MAX_RECENT_ITEMS = "3";

    const capturedMessages: Array<Array<{ role: string; content: Array<{ type: string }> }>> = [];
    const provider: LLMProvider = {
      generate: vi.fn(async (messages) => {
        capturedMessages.push(messages as typeof capturedMessages[0]);
        if (capturedMessages.length <= 10) {
          return { type: "tool_calls" as const, toolCalls: [{ id: `c${capturedMessages.length}`, name: "search", input: {} }] };
        }
        return { type: "text" as const, text: "done" };
      }),
    };

    await runAgentLoop("task", provider, registry, { maxIterations: 12 });

    delete process.env.MAX_CONTEXT_TOKENS;
    delete process.env.RESERVED_OUTPUT_TOKENS;
    delete process.env.COMPACTION_THRESHOLD;
    delete process.env.ENABLE_COMPACTION;
    delete process.env.MAX_RECENT_ITEMS;

    for (const msgs of capturedMessages) {
      for (let i = 0; i < msgs.length; i++) {
        const hasToolUse = msgs[i].content.some((c) => c.type === "tool_call");
        if (hasToolUse) {
          const next = msgs[i + 1];
          expect(next, `orphaned tool_use at index ${i}`).toBeDefined();
          expect(
            next?.content.some((c) => c.type === "tool_result"),
            `tool_result must follow tool_use at index ${i}`
          ).toBe(true);
        }
        const hasToolResult = msgs[i].content.some((c) => c.type === "tool_result");
        if (hasToolResult) {
          const prev = msgs[i - 1];
          expect(
            prev?.content.some((c) => c.type === "tool_call"),
            `tool_result at index ${i} has no preceding tool_use`
          ).toBe(true);
        }
      }
    }
  });

  it("messages sent to provider are always in chronological order (tool_result follows tool_use)", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool("search", { content: "result", isError: false });
    registry.register(tool);

    const capturedMessages: unknown[] = [];
    const provider: LLMProvider = {
      generate: vi.fn(async (messages) => {
        capturedMessages.push([...messages]);
        const call = capturedMessages.length;
        if (call <= 5) return { type: "tool_calls" as const, toolCalls: [{ id: `c${call}`, name: "search", input: {} }] };
        return { type: "text" as const, text: "done" };
      }),
    };

    await runAgentLoop("task", provider, registry, { maxIterations: 10 });

    // Every call to generate must have tool_result immediately after its tool_use
    for (const msgs of capturedMessages as Array<Array<{ role: string; content: unknown[] }>>) {
      for (let i = 0; i < msgs.length; i++) {
        const hasToolCall = msgs[i].content.some((c: unknown) => (c as { type: string }).type === "tool_call");
        if (hasToolCall) {
          const next = msgs[i + 1];
          expect(next, `tool_use at index ${i} has no following message`).toBeDefined();
          const hasToolResult = next?.content.some((c: unknown) => (c as { type: string }).type === "tool_result");
          expect(hasToolResult, `tool_result must follow tool_use at index ${i}`).toBe(true);
        }
      }
    }
  });

  it("every tool_result's id matches the tool_use in the message before it", async () => {
    // The real failure: a FAILED tool result is stored with importance "high", so the
    // context builder hoists it above its own assistant turn. createdAt used Date.now(),
    // whose millisecond resolution ties an assistant turn with its own tool result, so
    // the loop's chronological re-sort could not undo the hoist. Two consecutive failures
    // then put a tool_result directly after the PREVIOUS iteration's assistant turn —
    // an adjacency a role-only check accepts and the API rejects with
    // "unexpected tool_use_id". 94 of 128 failure patterns triggered it.
    //
    // The clock advances once per LLM call and is constant within an iteration: that is
    // the real-world shape (hundreds of ms between calls, microseconds between storing an
    // assistant turn and its tool result). Making it explicit removes the dependence on
    // machine speed that made this reproduce only intermittently.
    let fakeNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    const registry = new ToolRegistry();
    // Fail the first two iterations — the minimal mismatching pattern.
    let n = 0;
    const flaky = {
      definition: { name: "edit_file", description: "edit", inputSchema: { type: "object" as const, properties: {} } },
      execute: vi.fn(async () => (n++ < 2
        ? { content: "old_string not found in styles.css", isError: true }
        : { content: "Written: gallery.html", isError: false })),
    };
    registry.register(flaky);

    const captured: Array<Array<{ role: string; content: Array<Record<string, unknown>> }>> = [];
    let call = 0;
    const provider: LLMProvider = {
      generate: vi.fn(async (messages) => {
        captured.push(JSON.parse(JSON.stringify(messages)));
        fakeNow += 10;
        call++;
        if (call > 9) return { type: "text" as const, text: "done" };
        return {
          type: "tool_calls" as const,
          toolCalls: [{ id: `toolu_${call}`, name: "edit_file", input: { path: "styles.css", old_string: `a${call}`, new_string: "b" } }],
        };
      }),
    };

    await runAgentLoop("task", provider, registry, { maxIterations: 12, repeatFailureThreshold: 99 });
    nowSpy.mockRestore();

    expect(captured.length).toBeGreaterThan(5);
    for (const [c, msgs] of captured.entries()) {
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role !== "tool") continue;
        const resultIds = msgs[i].content.filter((b) => b.type === "tool_result").map((b) => b.toolCallId);
        const prev = msgs[i - 1];
        expect(prev?.role, `call ${c} msg ${i}: tool_result not preceded by assistant`).toBe("assistant");
        const callIds = prev.content.filter((b) => b.type === "tool_call").map((b) => b.id);
        for (const id of resultIds) {
          expect(callIds, `call ${c} msg ${i}: tool_result ${id} has no matching tool_use in previous message`).toContain(id);
        }
      }
    }
  });

  it("emits all required log event types on a successful run with verification", async () => {
    const registry = new ToolRegistry();
    const runTool = makeTool("run_command", {
      content: JSON.stringify({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false }),
      isError: false,
    });
    registry.register(runTool);

    const provider = makeMockProvider([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", input: { command: "npm test" } }] },
      { type: "text", text: "done" },
    ]);

    const entries: LogEntry[] = [];
    await runAgentLoop("task", provider, registry, {}, (e) => entries.push(e));

    const events = collectEvents(entries);
    for (const required of [
      "task_started", "llm_request", "llm_response",
      "tool_requested", "tool_started", "tool_completed",
      "verification_started", "verification_completed",
      "task_completed",
    ] as const) {
      expect(events, `missing event: ${required}`).toContain(required);
    }
  });

  describe("navigation wiring (config.workspaceRoot)", () => {
    const ROOT = process.cwd();
    const scripted = () => makeMockProvider([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "list_directory", input: { path: "src/navigation" } }] },
      { type: "tool_calls", toolCalls: [{ id: "c2", name: "list_directory", input: { path: "src/navigation" } }] },
      { type: "text", text: "done" },
    ]);

    it("registers no navigation tools and reports no metrics without a workspaceRoot", async () => {
      const registry = new ToolRegistry();
      const result = await runAgentLoop("t", scripted(), registry);
      expect(registry.get("find_symbol")).toBeUndefined();
      expect(result.navigation).toBeUndefined();
    });

    it("registers the tools, logs the FR-61 events with their fields, and reports metrics", async () => {
      const registry = new ToolRegistry();
      const entries: LogEntry[] = [];
      const result = await runAgentLoop("t", scripted(), registry, { workspaceRoot: ROOT }, (e) => entries.push(e));
      for (const n of ["list_directory", "find_symbol", "find_tests"]) expect(registry.get(n)).toBeDefined();
      const events = collectEvents(entries);
      for (const e of ["repository_scan_started", "navigation_scope_filtered", "repository_scan_completed", "directory_listed", "navigation_duplicate_detected"]) {
        expect(events).toContain(e);
      }
      const listed = entries.find((e) => e.event === "directory_listed")!;
      expect(listed).toMatchObject({ operation: "list_directory", path: "src/navigation" });
      expect(listed.resultCount).toBeGreaterThan(0);
      expect(listed.outputSize).toBeGreaterThan(0);
      expect(JSON.stringify(entries)).not.toMatch(/api[_-]?key|secret/i);
      expect(result.navigation?.callsByType).toEqual({ list_directory: 2 });
      expect(result.navigation?.repeatedSearches).toBe(1);
    });

    it("owns a fresh NavigationState per task", async () => {
      const first = await runAgentLoop("t", scripted(), new ToolRegistry(), { workspaceRoot: ROOT });
      const second = await runAgentLoop("t", scripted(), new ToolRegistry(), { workspaceRoot: ROOT });
      expect(second.navigation).toEqual(first.navigation);
    });
  });

  describe("tool result caps bound what the provider receives", () => {
    const big = (n: number) => Array.from({ length: n }, (_, i) => `src/file-${String(i).padStart(4, "0")}.ts:${i}: match`).join("\n");
    afterEach(() => {
      delete process.env.MAX_TOOL_OUTPUT_TOKENS;
      delete process.env.MAX_COMMAND_OUTPUT_TOKENS;
    });

    it("truncates each result block by its own tool, and still reads the exit code from the full output", async () => {
      process.env.MAX_TOOL_OUTPUT_TOKENS = "400";
      process.env.MAX_COMMAND_OUTPUT_TOKENS = "150";
      const registry = new ToolRegistry();
      registry.register(makeTool("find_symbol", { content: big(5000), isError: false }));
      registry.register(makeTool("run_command", {
        content: JSON.stringify({ exitCode: 0, stdout: big(5000), stderr: "", timedOut: false }),
        isError: false,
      }));

      const sent: Array<Array<{ role: string; content: Array<Record<string, unknown>> }>> = [];
      let call = 0;
      const provider: LLMProvider = {
        generate: vi.fn(async (messages) => {
          sent.push(JSON.parse(JSON.stringify(messages)));
          if (++call > 1) return { type: "text" as const, text: "done" };
          // One turn, two results: run_command first, so an item-level cap would apply its small limit to find_symbol too.
          return { type: "tool_calls" as const, toolCalls: [
            { id: "c1", name: "run_command", input: { command: "npm test" } },
            { id: "c2", name: "find_symbol", input: { symbol_name: "x" } },
          ] };
        }),
      };

      const result = await runAgentLoop("task", provider, registry);

      const blocks = sent[1].flatMap((m) => m.content).filter((b) => b.type === "tool_result") as Array<{ toolName: string; content: string }>;
      const sym = blocks.find((b) => b.toolName === "find_symbol")!;
      const cmd = blocks.find((b) => b.toolName === "run_command")!;
      expect(sym.content.length).toBeLessThanOrEqual(400 * 4);
      expect(sym.content.length).toBeGreaterThan(150 * 4); // kept its own, larger cap
      expect(sym.content.startsWith("src/file-0000.ts:0: match")).toBe(true);
      expect(sym.content).toMatch(/\[result truncated\] \d+ more lines omitted/);
      expect(cmd.content.length).toBeLessThanOrEqual(150 * 4);
      expect(result.verificationPerformed).toBe(true);
      expect(result.verificationPassed).toBe(true);
    });
  });
});
