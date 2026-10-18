import { describe, it, expect } from "vitest";
import { ContextManager } from "../../../src/context/context-manager.js";
import { loadContextPolicy } from "../../../src/context/policies.js";
import type { ContextItem } from "../../../src/context/types.js";

const policy = loadContextPolicy({
  MAX_CONTEXT_TOKENS: "8000",
  RESERVED_OUTPUT_TOKENS: "1000",
  COMPACTION_THRESHOLD: "0.70",
  MAX_TOOL_OUTPUT_TOKENS: "400",
  MAX_FILE_READ_TOKENS: "600",
  MAX_SEARCH_RESULT_TOKENS: "200",
  MAX_COMMAND_OUTPUT_TOKENS: "400",
  MAX_RECENT_ITEMS: "5",
  ENABLE_COMPACTION: "true",
  ENABLE_DUPLICATE_REMOVAL: "true",
});

const BUDGET = 8000 - 1000;

function item(id: string, toolName: string, tokens = 60, opts: Partial<ContextItem> = {}): ContextItem {
  return {
    id,
    type: "tool_result",
    content: "x".repeat(tokens * 4),
    importance: "normal",
    createdAt: Date.now(),
    tokenEstimate: tokens,
    removable: true,
    source: { toolName },
    ...opts,
  };
}

describe("stress: 100+ tool results, 50+ file reads, 20+ test commands", () => {
  it("stays within budget after large volume of items (AC-14, AC-15)", () => {
    const mgr = new ContextManager(policy);

    mgr.addItem({ id: "task", type: "task_state", content: "Fix the calculator bug", importance: "critical", createdAt: Date.now(), tokenEstimate: 20, removable: false });
    mgr.addItem({ id: "fact", type: "important_fact", content: "Bug is in multiply()", importance: "high", createdAt: Date.now(), tokenEstimate: 15, removable: false });

    for (let i = 0; i < 50; i++) mgr.addItem(item(`read-${i}`, "read_file", 50));
    for (let i = 0; i < 100; i++) mgr.addItem(item(`tool-${i}`, "search", 30));
    for (let i = 0; i < 20; i++) mgr.addItem(item(`cmd-${i}`, "run_command", 40));

    let selected: ContextItem[] = [];
    expect(() => { selected = mgr.buildContext(BUDGET); }).not.toThrow();

    const totalTokens = selected.reduce((s, i) => s + (i.tokenEstimate ?? 0), 0);
    expect(totalTokens).toBeLessThanOrEqual(BUDGET);
  });

  it("preserves critical task and important fact through compaction (AC-15)", () => {
    const mgr = new ContextManager(policy);
    mgr.addItem({ id: "task", type: "task_state", content: "Fix the calculator bug", importance: "critical", createdAt: Date.now(), tokenEstimate: 20, removable: false });
    mgr.addItem({ id: "fact", type: "important_fact", content: "Bug is in multiply()", importance: "high", createdAt: Date.now(), tokenEstimate: 15, removable: false });
    for (let i = 0; i < 100; i++) mgr.addItem(item(`noise-${i}`, "search", 60));

    const selected = mgr.buildContext(BUDGET);
    const ids = selected.map((i) => i.id);
    expect(ids).toContain("task");
    expect(ids).toContain("fact");
  });

  it("compaction fires and droppedCount > 0 (AC-17)", () => {
    const mgr = new ContextManager(policy);
    mgr.addItem({ id: "task", type: "task_state", content: "task", importance: "critical", createdAt: Date.now(), tokenEstimate: 10, removable: false });
    for (let i = 0; i < 120; i++) mgr.addItem(item(`t-${i}`, "search", 60));
    const state = mgr.getState();
    expect(state.compactionCount).toBeGreaterThan(0);
    expect(state.droppedCount).toBeGreaterThan(0);
  });

  it("buildContext after compaction returns a non-empty valid array (AC-16)", () => {
    const mgr = new ContextManager(policy);
    mgr.addItem({ id: "task", type: "task_state", content: "task", importance: "critical", createdAt: Date.now(), tokenEstimate: 10, removable: false });
    for (let i = 0; i < 120; i++) mgr.addItem(item(`t-${i}`, "search", 60));
    const result = mgr.buildContext(BUDGET);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    const total = result.reduce((s, i) => s + (i.tokenEstimate ?? 0), 0);
    expect(total).toBeLessThanOrEqual(BUDGET);
  });
});
