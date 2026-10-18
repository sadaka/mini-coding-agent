import type { ContextItem, CompactionEvent } from "./types.js";
import type { ContextPolicy } from "./policies.js";
import { defaultTokenEstimator } from "./token-estimator.js";

export interface CompactionResult {
  items: ContextItem[];
  event: CompactionEvent;
}

export interface Compactor {
  compact(items: ContextItem[], policy: ContextPolicy): CompactionResult;
}

export class DefaultCompactor implements Compactor {
  compact(items: ContextItem[], policy: ContextPolicy): CompactionResult {
    const tokensBefore = items.reduce(
      (sum, i) => sum + (i.tokenEstimate ?? defaultTokenEstimator.estimate(i.content)),
      0,
    );

    // Always keep: system, task_state, important_fact, non-removable items
    const keepers = items.filter(
      (i) => !i.removable || i.type === "system" || i.type === "task_state" || i.type === "important_fact",
    );

    // Removable tool results to summarize
    const removable = items.filter(
      (i) => i.removable && i.type !== "system" && i.type !== "task_state" && i.type !== "important_fact",
    );

    // Keep most recent items regardless
    const recentCutoff = items.length - policy.maxRecentItems;
    const recentKept = items.filter((_, idx) => idx >= recentCutoff && !keepers.includes(items[idx]));

    const toSummarize = removable.filter((i) => !recentKept.includes(i));

    const summary = this.buildSummary(toSummarize);
    const summaryItem: ContextItem | null =
      summary.length > 0
        ? {
            id: `compaction-summary-${Date.now()}`,
            type: "summary",
            content: summary,
            importance: "high",
            createdAt: Date.now(),
            tokenEstimate: defaultTokenEstimator.estimate(summary),
            removable: false,
          }
        : null;

    const resultItems = [
      ...keepers,
      ...recentKept,
      ...(summaryItem ? [summaryItem] : []),
    ];

    const tokensAfter = resultItems.reduce(
      (sum, i) => sum + (i.tokenEstimate ?? defaultTokenEstimator.estimate(i.content)),
      0,
    );

    const event: CompactionEvent = {
      timestamp: Date.now(),
      itemsBefore: items.length,
      itemsAfter: resultItems.length,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensAfter,
      itemsRemoved: items.length - resultItems.length,
      summaryCreated: summaryItem !== null,
    };

    return { items: resultItems, event };
  }

  private buildSummary(items: ContextItem[]): string {
    if (items.length === 0) return "";

    const files = new Set<string>();
    const commands: string[] = [];
    const errors: string[] = [];
    const testResults: string[] = [];

    for (const item of items) {
      const tool = item.source?.toolName;
      if (tool === "read_file" && item.source?.filePath) files.add(item.source.filePath);
      if (tool === "run_command" && item.source?.command) commands.push(item.source.command);

      // Extract error lines and test result lines from content
      for (const line of item.content.split("\n")) {
        if (/error|fail|exception/i.test(line) && line.trim()) errors.push(line.trim());
        if (/passed|failed|skipped/i.test(line) && line.trim()) testResults.push(line.trim());
      }
    }

    const parts: string[] = ["[Compaction Summary]"];
    if (files.size) parts.push(`Files accessed: ${[...files].join(", ")}`);
    if (commands.length) parts.push(`Commands run: ${[...new Set(commands)].join("; ")}`);
    if (testResults.length) parts.push(`Test results: ${testResults.slice(-3).join("; ")}`);
    if (errors.length) parts.push(`Errors: ${errors.slice(-5).join("; ")}`);

    return parts.join("\n");
  }
}

export const defaultCompactor: Compactor = new DefaultCompactor();
