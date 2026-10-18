import { describe, it, expect } from "vitest";
import { DefaultContextBuilder } from "../../../src/context/context-builder.js";
import type { ContextItem } from "../../../src/context/types.js";

function makeItem(
  id: string,
  importance: ContextItem["importance"],
  createdAt: number,
  content = `content-${id}`,
  tokenEstimate = 10,
): ContextItem {
  return { id, type: "user", content, importance, createdAt, tokenEstimate, removable: true };
}

describe("DefaultContextBuilder", () => {
  const builder = new DefaultContextBuilder();

  it("keeps CRITICAL items and drops LOW first when budget is tight (AC-16)", () => {
    const items = [
      makeItem("low1", "low", 1),
      makeItem("crit1", "critical", 2),
      makeItem("norm1", "normal", 3),
    ];
    // budget fits only 2 items (20 tokens, each costs 10)
    const result = builder.build(items, 20);
    const ids = result.map((i) => i.id);
    expect(ids).toContain("crit1");
    expect(ids).not.toContain("low1");
  });

  it("HIGH-recent beats HIGH-old within same priority", () => {
    const items = [
      makeItem("high-old", "high", 100),
      makeItem("high-new", "high", 200),
    ];
    // budget fits only 1
    const result = builder.build(items, 10);
    expect(result[0].id).toBe("high-new");
  });

  it("removes duplicate content items", () => {
    const items = [
      makeItem("a", "normal", 1, "same-content"),
      makeItem("b", "normal", 2, "same-content"),
    ];
    const result = builder.build(items, 1000);
    expect(result).toHaveLength(1);
  });

  it("CRITICAL-old beats NORMAL-recent (priority dominates recency)", () => {
    const items = [
      makeItem("norm-new", "normal", 999),
      makeItem("crit-old", "critical", 1),
    ];
    // budget fits only 1
    const result = builder.build(items, 10);
    expect(result[0].id).toBe("crit-old");
  });

  it("returns all items when budget is sufficient", () => {
    const items = [
      makeItem("a", "low", 1),
      makeItem("b", "high", 2),
      makeItem("c", "critical", 3),
    ];
    const result = builder.build(items, 1000);
    expect(result).toHaveLength(3);
  });
});
