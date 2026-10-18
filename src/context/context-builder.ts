import type { ContextItem, ImportanceLevel } from "./types.js";
import { defaultTokenEstimator } from "./token-estimator.js";

const PRIORITY_ORDER: Record<ImportanceLevel, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface ContextBuilder {
  build(items: ContextItem[], tokenBudget: number): ContextItem[];
}

export class DefaultContextBuilder implements ContextBuilder {
  build(items: ContextItem[], tokenBudget: number): ContextItem[] {
    // Remove duplicates by content hash (keep first seen per content).
    // Assistant turns and tool results are exempt: two of them can legitimately carry
    // identical text ("Written: index.html" twice), and dropping one half of an
    // assistant/tool_result pair breaks the provider's tool_use/tool_result pairing.
    const seen = new Set<string>();
    const deduped = items.filter((item) => {
      if (item.type === "assistant" || item.type === "tool_result") return true;
      if (seen.has(item.content)) return false;
      seen.add(item.content);
      return true;
    });

    // Sort: priority ascending (critical=0 first), then newest first (createdAt desc)
    const sorted = [...deduped].sort((a, b) => {
      const pDiff = PRIORITY_ORDER[a.importance] - PRIORITY_ORDER[b.importance];
      if (pDiff !== 0) return pDiff;
      return b.createdAt - a.createdAt;
    });

    // Greedy fill within budget
    const result: ContextItem[] = [];
    let used = 0;
    for (const item of sorted) {
      const tokens = item.tokenEstimate ?? defaultTokenEstimator.estimate(item.content);
      if (used + tokens <= tokenBudget) {
        result.push(item);
        used += tokens;
      }
    }
    return result;
  }
}

export const defaultContextBuilder: ContextBuilder = new DefaultContextBuilder();
