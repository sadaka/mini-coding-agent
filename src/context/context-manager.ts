import type { ContextItem, ContextState, CompactionEvent } from "./types.js";
import type { ContextPolicy } from "./policies.js";
import { usableInputTokens } from "./policies.js";
import { defaultTokenEstimator } from "./token-estimator.js";
import { defaultTruncator } from "./truncator.js";
import { defaultContextBuilder } from "./context-builder.js";
import { defaultCompactor } from "./compactor.js";

export class BudgetImpossibleError extends Error {
  constructor(required: number, available: number) {
    super(`Context budget impossible: need ${required} tokens but only ${available} available after compaction`);
    this.name = "BudgetImpossibleError";
  }
}

export type ContextManagerEvent =
  | { type: "truncated"; itemId: string }
  | { type: "compaction_started" }
  | { type: "compaction_completed"; droppedItems: number };

export class ContextManager {
  private items: ContextItem[] = [];
  private compactionEvents: CompactionEvent[] = [];
  private droppedCount = 0;

  constructor(
    private readonly policy: ContextPolicy,
    private readonly onEvent?: (e: ContextManagerEvent) => void,
  ) {}

  addItem(item: ContextItem): void {
    const estimated = item.tokenEstimate ?? defaultTokenEstimator.estimate(item.content);
    const maxForType = this.maxTokensForType(item);

    const stored =
      estimated > maxForType
        ? defaultTruncator.truncate({ ...item, tokenEstimate: estimated }, maxForType)
        : { ...item, tokenEstimate: estimated };

    if (stored.truncated) this.onEvent?.({ type: "truncated", itemId: item.id });
    this.items.push(stored);
    this.maybeCompact();
  }

  /**
   * Caps one tool result by its own tool's limit. The loop calls this per result block before the
   * message is stored, because one tool message can hold several results and an item-level cap
   * only knows the first call's tool (and never reached what the provider is actually sent).
   */
  truncateToolResult(toolName: string, content: string): string {
    const item: ContextItem = {
      id: `result-${toolName}`,
      type: "tool_result",
      content,
      importance: "normal",
      createdAt: 0,
      source: { toolName },
    };
    const max = this.maxTokensForType(item);
    if (defaultTokenEstimator.estimate(content) <= max) return content;
    const out = defaultTruncator.truncate(item, max);
    this.onEvent?.({ type: "truncated", itemId: item.id });
    return out.content;
  }

  buildContext(tokenBudget: number): ContextItem[] {
    const result = defaultContextBuilder.build(this.items, tokenBudget);

    // Check if critical items alone exceed the budget
    const criticalItems = this.items.filter((i) => i.importance === "critical");
    const criticalTokens = criticalItems.reduce(
      (sum, i) => sum + (i.tokenEstimate ?? defaultTokenEstimator.estimate(i.content)),
      0,
    );

    if (criticalTokens > tokenBudget) {
      throw new BudgetImpossibleError(criticalTokens, tokenBudget);
    }

    return result;
  }

  getState(): ContextState {
    const estimatedInputTokens = this.items.reduce(
      (sum, i) => sum + (i.tokenEstimate ?? defaultTokenEstimator.estimate(i.content)),
      0,
    );
    return {
      items: [...this.items],
      maxContextTokens: this.policy.maxContextTokens,
      reservedOutputTokens: this.policy.reservedOutputTokens,
      estimatedInputTokens,
      compactionCount: this.compactionEvents.length,
      truncatedItemCount: this.items.filter((i) => i.truncated).length,
      droppedCount: this.droppedCount,
    };
  }

  getItems(): ContextItem[] {
    return [...this.items];
  }

  private maybeCompact(): void {
    if (!this.policy.enableCompaction) return;
    const usable = usableInputTokens(this.policy);
    const state = this.getState();
    if (state.estimatedInputTokens / usable < this.policy.compactionThreshold) return;

    this.onEvent?.({ type: "compaction_started" });
    const { items, event } = defaultCompactor.compact(this.items, this.policy);
    this.droppedCount += event.itemsRemoved;
    this.items = items;
    this.compactionEvents.push(event);
    this.onEvent?.({ type: "compaction_completed", droppedItems: event.itemsRemoved });
  }

  private maxTokensForType(item: ContextItem): number {
    const tool = item.source?.toolName;
    if (tool === "read_file") return this.policy.maxFileReadTokens;
    if (tool === "search") return this.policy.maxSearchResultTokens;
    if (tool === "run_command") return this.policy.maxCommandOutputTokens;
    if (item.type === "tool_result") return this.policy.maxToolResultTokens;
    return usableInputTokens(this.policy);
  }
}
