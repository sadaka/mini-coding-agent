import { describe, expect, it } from "vitest";
import { makeLogger, type LogEntry, type LogEvent } from "../../../src/agent/logger.js";
import { summarizeNavigation } from "../../../src/navigation/metrics.js";
import { createNavigationState } from "../../../src/navigation/state.js";

const EVENTS: LogEvent[] = [
  "repository_scan_started", "repository_scan_completed", "directory_listed", "search_started", "search_completed",
  "symbol_search_started", "symbol_search_completed", "test_discovery_started", "test_discovery_completed",
  "navigation_duplicate_detected", "navigation_scope_filtered", "navigation_result_truncated",
];

describe("navigation log events", () => {
  it("emits each event once with the required fields and no key material", () => {
    const out: LogEntry[] = [];
    const log = makeLogger("t1", (e) => out.push(e));
    for (const e of EVENTS) log(e, { iteration: 1, operation: "op", path: "src", durationMs: 3, resultCount: 2, outputSize: 40, source: "tree-sitter" });
    expect(out.map((e) => e.event)).toEqual(EVENTS);
    for (const e of out) {
      expect(e).toMatchObject({ taskId: "t1", iteration: 1, durationMs: 3, resultCount: 2, outputSize: 40, source: "tree-sitter" });
      expect(e.timestamp).toBeTruthy();
    }
    expect(JSON.stringify(out)).not.toMatch(/api[_-]?key|secret|sk-/i);
  });
});

describe("summarizeNavigation", () => {
  it("counts calls by type, repeats, discoveries and symbol matches", () => {
    const s = createNavigationState("/r");
    const ok = (content: string) => ({ content, isError: false }) as never;
    s.record("list_directory", { path: "src" }, ok("src/a.ts\nsrc/b.ts"));
    s.record("list_directory", { path: "src" }, ok("src/a.ts\nsrc/b.ts"));
    s.record("find_symbol", { name: "add" }, ok("src/a.ts:1-3 function add [tree-sitter]\nsrc/c.rb:4: add x [text-search, not a confirmed declaration]"));
    expect(summarizeNavigation(s, ["src/a.ts", "src/a.ts"])).toEqual({
      callsByType: { list_directory: 2, find_symbol: 1 },
      filesDiscovered: 3,
      filesRead: 1,
      repeatedSearches: 1,
      treeSitterSymbolMatches: 1,
      fallbackSymbolMatches: 1,
      symbolMatches: 2,
    });
  });
});
