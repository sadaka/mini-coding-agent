import { describe, it, expect } from "vitest";
import { ContextManager, BudgetImpossibleError, type ContextManagerEvent } from "../../../src/context/context-manager.js";
import { loadContextPolicy } from "../../../src/context/policies.js";
import type { ContextItem } from "../../../src/context/types.js";

function makeItem(id: string, opts: Partial<ContextItem> = {}): ContextItem {
  return {
    id,
    type: "tool_result",
    content: "x".repeat(100),
    importance: "normal",
    createdAt: Date.now(),
    tokenEstimate: 25,
    removable: true,
    ...opts,
  };
}

const tightPolicy = loadContextPolicy({
  MAX_CONTEXT_TOKENS: "500",
  RESERVED_OUTPUT_TOKENS: "50",
  COMPACTION_THRESHOLD: "0.60",
  MAX_TOOL_OUTPUT_TOKENS: "200",
  MAX_FILE_READ_TOKENS: "200",
  MAX_SEARCH_RESULT_TOKENS: "100",
  MAX_COMMAND_OUTPUT_TOKENS: "200",
  MAX_RECENT_ITEMS: "2",
  ENABLE_COMPACTION: "true",
  ENABLE_DUPLICATE_REMOVAL: "true",
});

describe("ContextManager onEvent — truncation", () => {
  it("fires 'truncated' when item exceeds max tokens for its type", () => {
    const events: ContextManagerEvent[] = [];
    const mgr = new ContextManager(tightPolicy, (e) => events.push(e));
    // run_command is capped at MAX_COMMAND_OUTPUT_TOKENS (200); tokenEstimate 300 exceeds it
    mgr.addItem(makeItem("big", { tokenEstimate: 300, source: { toolName: "run_command" }, content: "x".repeat(1200) }));
    expect(events.some((e) => e.type === "truncated")).toBe(true);
  });

  it("does not fire 'truncated' when item fits within limit", () => {
    const events: ContextManagerEvent[] = [];
    const mgr = new ContextManager(tightPolicy, (e) => events.push(e));
    mgr.addItem(makeItem("small", { tokenEstimate: 10, content: "short" }));
    expect(events.some((e) => e.type === "truncated")).toBe(false);
  });

  it("truncated event carries the item id", () => {
    const events: ContextManagerEvent[] = [];
    const mgr = new ContextManager(tightPolicy, (e) => events.push(e));
    mgr.addItem(makeItem("my-id", { tokenEstimate: 300, source: { toolName: "run_command" }, content: "x".repeat(1200) }));
    const ev = events.find((e) => e.type === "truncated") as Extract<ContextManagerEvent, { type: "truncated" }> | undefined;
    expect(ev?.itemId).toBe("my-id");
  });
});

describe("ContextManager onEvent — compaction", () => {
  it("fires 'compaction_started' and 'compaction_completed' when threshold exceeded", () => {
    const events: ContextManagerEvent[] = [];
    const mgr = new ContextManager(tightPolicy, (e) => events.push(e));
    // usable = 450, threshold = 0.60 → triggers at 270 tokens; add 15 × 25 = 375
    for (let i = 0; i < 15; i++) mgr.addItem(makeItem(`item-${i}`, { tokenEstimate: 25 }));
    expect(events.some((e) => e.type === "compaction_started")).toBe(true);
    expect(events.some((e) => e.type === "compaction_completed")).toBe(true);
  });

  it("compaction_completed carries positive droppedItems when items are removed", () => {
    const events: ContextManagerEvent[] = [];
    const mgr = new ContextManager(tightPolicy, (e) => events.push(e));
    for (let i = 0; i < 15; i++) mgr.addItem(makeItem(`item-${i}`, { tokenEstimate: 25 }));
    const ev = events.find((e) => e.type === "compaction_completed") as Extract<ContextManagerEvent, { type: "compaction_completed" }> | undefined;
    expect(ev).toBeDefined();
    expect(ev!.droppedItems).toBeGreaterThan(0);
  });

  it("no compaction events when ENABLE_COMPACTION is false", () => {
    const noCompact = loadContextPolicy({ MAX_CONTEXT_TOKENS: "500", RESERVED_OUTPUT_TOKENS: "50", ENABLE_COMPACTION: "false" });
    const events: ContextManagerEvent[] = [];
    const mgr = new ContextManager(noCompact, (e) => events.push(e));
    for (let i = 0; i < 15; i++) mgr.addItem(makeItem(`item-${i}`, { tokenEstimate: 25 }));
    expect(events.some((e) => e.type === "compaction_started")).toBe(false);
  });
});

describe("ContextManager getState — droppedCount", () => {
  it("droppedCount increases after compaction removes items", () => {
    const mgr = new ContextManager(tightPolicy);
    for (let i = 0; i < 15; i++) mgr.addItem(makeItem(`item-${i}`, { tokenEstimate: 25 }));
    expect(mgr.getState().droppedCount).toBeGreaterThan(0);
  });

  it("droppedCount is 0 when compaction is disabled", () => {
    const noCompact = loadContextPolicy({ MAX_CONTEXT_TOKENS: "500", RESERVED_OUTPUT_TOKENS: "50", ENABLE_COMPACTION: "false" });
    const mgr = new ContextManager(noCompact);
    for (let i = 0; i < 10; i++) mgr.addItem(makeItem(`item-${i}`, { tokenEstimate: 25 }));
    expect(mgr.getState().droppedCount).toBe(0);
  });

  it("droppedCount matches sum of compaction_completed events", () => {
    let totalDropped = 0;
    const mgr = new ContextManager(tightPolicy, (e) => {
      if (e.type === "compaction_completed") totalDropped += e.droppedItems;
    });
    for (let i = 0; i < 30; i++) mgr.addItem(makeItem(`item-${i}`, { tokenEstimate: 25 }));
    expect(mgr.getState().droppedCount).toBe(totalDropped);
  });
});
