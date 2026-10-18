import { describe, it, expect } from "vitest";
import { DefaultCompactor } from "../../../src/context/compactor.js";
import { ContextManager, BudgetImpossibleError } from "../../../src/context/context-manager.js";
import type { ContextItem } from "../../../src/context/types.js";
import { loadContextPolicy } from "../../../src/context/policies.js";

function makeItem(
  id: string,
  opts: Partial<ContextItem> & { content?: string } = {},
): ContextItem {
  return {
    id,
    type: "tool_result",
    content: opts.content ?? `content-${id}`,
    importance: "normal",
    createdAt: Date.now(),
    tokenEstimate: opts.tokenEstimate ?? 10,
    removable: true,
    ...opts,
  };
}

const policy = loadContextPolicy({
  MAX_CONTEXT_TOKENS: "1000",
  RESERVED_OUTPUT_TOKENS: "100",
  COMPACTION_THRESHOLD: "0.80",
  MAX_TOOL_OUTPUT_TOKENS: "400",
  MAX_FILE_READ_TOKENS: "600",
  MAX_SEARCH_RESULT_TOKENS: "200",
  MAX_COMMAND_OUTPUT_TOKENS: "400",
  MAX_RECENT_ITEMS: "3",
  ENABLE_DUPLICATE_REMOVAL: "true",
  ENABLE_COMPACTION: "true",
});

describe("DefaultCompactor", () => {
  const compactor = new DefaultCompactor();

  it("before-tokens > after-tokens after compaction (AC-17)", () => {
    const items = [
      makeItem("sys", { type: "system", removable: false, tokenEstimate: 20 }),
      makeItem("task", { type: "task_state", removable: false, tokenEstimate: 20 }),
      ...Array.from({ length: 10 }, (_, i) =>
        makeItem(`tool-${i}`, { removable: true, tokenEstimate: 50, content: `tool result ${i}` }),
      ),
    ];
    const { event } = compactor.compact(items, policy);
    expect(event.estimatedTokensBefore).toBeGreaterThan(event.estimatedTokensAfter);
    expect(event.itemsRemoved).toBeGreaterThan(0);
  });

  it("user task + important facts survive compaction (AC-17)", () => {
    const items = [
      makeItem("task", { type: "task_state", removable: false, tokenEstimate: 20, content: "task content" }),
      makeItem("fact", { type: "important_fact", removable: false, tokenEstimate: 20, content: "important fact" }),
      ...Array.from({ length: 8 }, (_, i) =>
        makeItem(`noise-${i}`, { removable: true, tokenEstimate: 50, content: `noise ${i}` }),
      ),
    ];
    const { items: result } = compactor.compact(items, policy);
    const ids = result.map((i) => i.id);
    expect(ids).toContain("task");
    expect(ids).toContain("fact");
  });

  it("summary is created when removable items exist", () => {
    const items = [
      makeItem("r1", { removable: true, content: "noise 1" }),
      makeItem("r2", { removable: true, content: "noise 2" }),
      makeItem("r3", { removable: true, content: "noise 3" }),
      makeItem("r4", { removable: true, content: "noise 4" }),
    ];
    const { event } = compactor.compact(items, policy);
    expect(event.summaryCreated).toBe(true);
  });
});

describe("ContextManager", () => {
  it("buildContext returns items within budget", () => {
    const mgr = new ContextManager(policy);
    for (let i = 0; i < 5; i++) {
      mgr.addItem(makeItem(`item-${i}`, { tokenEstimate: 50, removable: false }));
    }
    const result = mgr.buildContext(200);
    const total = result.reduce((s, i) => s + (i.tokenEstimate ?? 0), 0);
    expect(total).toBeLessThanOrEqual(200);
  });

  it("throws BudgetImpossibleError on budget-impossible path (AC-18)", () => {
    const mgr = new ContextManager(policy);
    // Add critical non-removable items totaling more than budget
    mgr.addItem(makeItem("crit1", { importance: "critical", removable: false, tokenEstimate: 100 }));
    mgr.addItem(makeItem("crit2", { importance: "critical", removable: false, tokenEstimate: 100 }));
    expect(() => mgr.buildContext(50)).toThrow(BudgetImpossibleError);
  });

  it("getState reflects added items", () => {
    const mgr = new ContextManager(policy);
    mgr.addItem(makeItem("a", { tokenEstimate: 20 }));
    mgr.addItem(makeItem("b", { tokenEstimate: 30 }));
    const state = mgr.getState();
    expect(state.estimatedInputTokens).toBeGreaterThanOrEqual(50);
  });
});
