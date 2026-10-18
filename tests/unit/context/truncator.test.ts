import { describe, it, expect } from "vitest";
import { DefaultTruncator } from "../../../src/context/truncator.js";
import type { ContextItem } from "../../../src/context/types.js";
import { defaultTokenEstimator } from "../../../src/context/token-estimator.js";

function makeItem(content: string, toolName?: string): ContextItem {
  return {
    id: "test-1",
    type: "tool_result",
    content,
    importance: "normal",
    createdAt: Date.now(),
    tokenEstimate: defaultTokenEstimator.estimate(content),
    source: toolName ? { toolName } : undefined,
  };
}

describe("DefaultTruncator", () => {
  const t = new DefaultTruncator();

  it("returns item unchanged when below limit", () => {
    const item = makeItem("short content");
    const result = t.truncate(item, 1000);
    expect(result.content).toBe(item.content);
    expect(result.truncated).toBeUndefined();
  });

  it("truncates item when above limit", () => {
    const content = "x".repeat(400); // ~100 tokens
    const item = makeItem(content);
    const result = t.truncate(item, 10);
    expect(result.tokenEstimate!).toBeLessThanOrEqual(10);
  });

  it("truncated result contains marker", () => {
    const content = "y".repeat(400);
    const item = makeItem(content);
    const result = t.truncate(item, 10);
    expect(result.content).toContain("[result truncated]");
  });

  it("preserves truncation metadata", () => {
    const content = "z".repeat(400);
    const item = makeItem(content);
    const result = t.truncate(item, 10);
    expect(result.truncated).toBe(true);
    expect(result.originalTokenEstimate).toBeGreaterThan(result.tokenEstimate!);
  });

  it("truncates command output preferring error lines", () => {
    const lines = [
      "starting server...",
      "loading config...",
      "ERROR: connection refused",
      "lots of noise ".repeat(50),
      "FAIL: test timed out",
    ];
    const item = makeItem(lines.join("\n"), "run_command");
    const result = t.truncate(item, 20);
    expect(result.content).toContain("[result truncated]");
  });

  it("truncates file content with marker", () => {
    const content = "line " + "x".repeat(50) + "\n".repeat(100) + "end";
    const item = makeItem(content, "read_file");
    const result = t.truncate(item, 5);
    expect(result.content).toContain("[result truncated]");
    expect(result.truncated).toBe(true);
  });
});

describe("DefaultTruncator navigation listings", () => {
  const t = new DefaultTruncator();
  const listing = Array.from({ length: 200 }, (_, i) => `src/file-${String(i).padStart(3, "0")}.ts:${i}: match`).join("\n");

  it.each(["list_directory", "find_symbol", "find_tests"])("%s keeps the head and states how many lines were omitted", (tool) => {
    const result = t.truncate(makeItem(listing, tool), 200);
    expect(result.truncated).toBe(true);
    expect(result.content.startsWith("src/file-000.ts:0: match\n")).toBe(true);
    expect(result.content).not.toContain("file-199");
    const kept = result.content.split("\n").filter((l) => l.startsWith("src/file-")).length;
    expect(result.content).toContain(`[result truncated] ${200 - kept} more lines omitted`);
    expect(result.tokenEstimate).toBeLessThanOrEqual(200);
  });

  it("leaves a listing under the cap untouched", () => {
    const item = makeItem("a\nb", "find_tests");
    expect(t.truncate(item, 200)).toBe(item);
  });
});
