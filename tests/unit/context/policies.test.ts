import { describe, it, expect } from "vitest";
import { loadContextPolicy, usableInputTokens } from "../../../src/context/policies.js";

describe("provider context window drives compaction", () => {
  it("uses the provider's window when MAX_CONTEXT_TOKENS is unset", () => {
    const p = loadContextPolicy({}, { maxContextTokens: 200_000 });
    expect(p.maxContextTokens).toBe(200_000);
    // Compaction must not fire while most of a 200K window is still free.
    expect(usableInputTokens(p) * p.compactionThreshold).toBeGreaterThan(100_000);
  });

  it("lets an explicit MAX_CONTEXT_TOKENS override the provider's window", () => {
    const p = loadContextPolicy({ MAX_CONTEXT_TOKENS: "8000" }, { maxContextTokens: 200_000 });
    expect(p.maxContextTokens).toBe(8000);
  });

  it("falls back to 32000 when neither env nor provider gives a window", () => {
    expect(loadContextPolicy({}).maxContextTokens).toBe(32_000);
  });
});

describe("loadContextPolicy", () => {
  it("returns defaults when env is empty", () => {
    const p = loadContextPolicy({});
    expect(p.maxContextTokens).toBe(32000);
    expect(p.reservedOutputTokens).toBe(4096);
    expect(p.compactionThreshold).toBe(0.80);
    expect(p.maxToolResultTokens).toBe(4000);
    expect(p.maxFileReadTokens).toBe(6000);
    expect(p.maxSearchResultTokens).toBe(2000);
    expect(p.maxCommandOutputTokens).toBe(4000);
    expect(p.maxRecentItems).toBe(8);
    expect(p.enableDuplicateRemoval).toBe(true);
    expect(p.enableCompaction).toBe(true);
  });

  it("overrides every field from env vars", () => {
    const p = loadContextPolicy({
      MAX_CONTEXT_TOKENS: "8000",
      RESERVED_OUTPUT_TOKENS: "1000",
      COMPACTION_THRESHOLD: "0.70",
      MAX_TOOL_OUTPUT_TOKENS: "500",
      MAX_FILE_READ_TOKENS: "700",
      MAX_SEARCH_RESULT_TOKENS: "300",
      MAX_COMMAND_OUTPUT_TOKENS: "600",
      MAX_RECENT_ITEMS: "5",
      ENABLE_DUPLICATE_REMOVAL: "false",
      ENABLE_COMPACTION: "false",
    });
    expect(p.maxContextTokens).toBe(8000);
    expect(p.reservedOutputTokens).toBe(1000);
    expect(p.compactionThreshold).toBe(0.70);
    expect(p.maxToolResultTokens).toBe(500);
    expect(p.maxFileReadTokens).toBe(700);
    expect(p.maxSearchResultTokens).toBe(300);
    expect(p.maxCommandOutputTokens).toBe(600);
    expect(p.maxRecentItems).toBe(5);
    expect(p.enableDuplicateRemoval).toBe(false);
    expect(p.enableCompaction).toBe(false);
  });

  it("ENABLE_DUPLICATE_REMOVAL only disables on explicit 'false'", () => {
    expect(loadContextPolicy({ ENABLE_DUPLICATE_REMOVAL: "true" }).enableDuplicateRemoval).toBe(true);
    expect(loadContextPolicy({ ENABLE_DUPLICATE_REMOVAL: "false" }).enableDuplicateRemoval).toBe(false);
    expect(loadContextPolicy({}).enableDuplicateRemoval).toBe(true);
  });

  it("ENABLE_COMPACTION only disables on explicit 'false'", () => {
    expect(loadContextPolicy({ ENABLE_COMPACTION: "true" }).enableCompaction).toBe(true);
    expect(loadContextPolicy({ ENABLE_COMPACTION: "false" }).enableCompaction).toBe(false);
    expect(loadContextPolicy({}).enableCompaction).toBe(true);
  });
});

describe("usableInputTokens", () => {
  it("subtracts reservedOutputTokens from maxContextTokens", () => {
    const p = loadContextPolicy({ MAX_CONTEXT_TOKENS: "10000", RESERVED_OUTPUT_TOKENS: "2000" });
    expect(usableInputTokens(p)).toBe(8000);
  });

  it("returns 0 when reserved equals max", () => {
    const p = loadContextPolicy({ MAX_CONTEXT_TOKENS: "1000", RESERVED_OUTPUT_TOKENS: "1000" });
    expect(usableInputTokens(p)).toBe(0);
  });
});
