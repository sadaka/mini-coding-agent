import type { ContextItem } from "./types.js";
import { defaultTokenEstimator } from "./token-estimator.js";

export interface Truncator {
  truncate(item: ContextItem, maxTokens: number): ContextItem;
}

const TRUNCATION_MARKER = "[result truncated]";
// Ranked or ordered listings: the first lines matter most, so keep the head and say how much was cut.
const NAVIGATION_LISTS = new Set(["list_directory", "find_symbol", "find_tests"]);

export class DefaultTruncator implements Truncator {
  truncate(item: ContextItem, maxTokens: number): ContextItem {
    const est = item.tokenEstimate ?? defaultTokenEstimator.estimate(item.content);
    if (est <= maxTokens) return item;

    const truncated = this.truncateContent(item, maxTokens);
    const finalEst = defaultTokenEstimator.estimate(truncated);

    return {
      ...item,
      content: truncated,
      truncated: true,
      originalTokenEstimate: est,
      tokenEstimate: finalEst,
    };
  }

  private truncateContent(item: ContextItem, maxTokens: number): string {
    const targetChars = maxTokens * 4;

    switch (item.type) {
      case "tool_result":
        return this.truncateBySource(item, targetChars);
      default:
        return this.truncateTail(item.content, targetChars);
    }
  }

  private truncateBySource(item: ContextItem, targetChars: number): string {
    const toolName = item.source?.toolName ?? "";
    if (toolName === "read_file") return this.truncateFileContent(item.content, targetChars);
    if (toolName === "search") return this.truncateSearchResults(item.content, targetChars);
    if (toolName === "run_command") return this.truncateCommandOutput(item.content, targetChars);
    if (NAVIGATION_LISTS.has(toolName)) return this.truncateListing(item.content, targetChars);
    return this.truncateTail(item.content, targetChars);
  }

  // File content: keep beginning (imports/context) + end (requested area)
  private truncateFileContent(content: string, targetChars: number): string {
    if (content.length <= targetChars) return content;
    const lines = content.split("\n");
    const kept: string[] = [];
    let chars = 0;
    // Take from the end (most recently requested area)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] + "\n";
      if (chars + line.length > targetChars - TRUNCATION_MARKER.length - 20) break;
      kept.unshift(line);
      chars += line.length;
    }
    return `${TRUNCATION_MARKER}\n${kept.join("")}`;
  }

  // Search results: keep highest-relevance (first results, which are ranked)
  private truncateSearchResults(content: string, targetChars: number): string {
    if (content.length <= targetChars) return content;
    const available = targetChars - TRUNCATION_MARKER.length - 5;
    return content.slice(0, available) + `\n${TRUNCATION_MARKER}`;
  }

  private truncateListing(content: string, targetChars: number): string {
    if (content.length <= targetChars) return content;
    const lines = content.split("\n");
    const budget = targetChars - TRUNCATION_MARKER.length - 40; // room for the omitted-count note
    let chars = 0;
    let kept = 0;
    while (kept < lines.length && chars + lines[kept].length + 1 <= budget) chars += lines[kept++].length + 1;
    return `${lines.slice(0, kept).join("\n")}\n${TRUNCATION_MARKER} ${lines.length - kept} more lines omitted`;
  }

  // Command output: prefer error lines + last portion
  private truncateCommandOutput(content: string, targetChars: number): string {
    if (content.length <= targetChars) return content;
    const lines = content.split("\n");

    // Collect error lines
    const errorLines = lines.filter((l) =>
      /error|fail|exception|warn/i.test(l)
    );

    const tailBudget = Math.floor(targetChars * 0.6);
    const errorBudget = targetChars - tailBudget - TRUNCATION_MARKER.length - 10;

    const errorPart = errorLines.join("\n").slice(0, errorBudget);
    const tail = content.slice(-tailBudget);

    if (errorPart) {
      return `${TRUNCATION_MARKER}\nErrors:\n${errorPart}\n...\n${tail}`;
    }
    return `${TRUNCATION_MARKER}\n${tail}`;
  }

  private truncateTail(content: string, targetChars: number): string {
    if (content.length <= targetChars) return content;
    const available = targetChars - TRUNCATION_MARKER.length - 5;
    return `${TRUNCATION_MARKER}\n` + content.slice(-available);
  }
}

export const defaultTruncator: Truncator = new DefaultTruncator();
