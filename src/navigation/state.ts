import type { ToolResult } from "../types/index.js";
import type { SymbolKind } from "./symbols/types.js";

export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  path: string;
  startLine: number;
  endLine: number;
}

export interface SearchRecord {
  tool: string;
  input: Record<string, unknown>;
  /** 1 = first time; every identical later call increments it. */
  count: number;
}

/**
 * Task-local record of what navigation has shown the model (FR-56). In memory only: nothing here touches the
 * filesystem, and `reset()` is how a new task starts empty. Repeats are recorded, never blocked (FR-57).
 */
export interface NavigationState {
  readonly root: string;
  readonly exploredDirs: Set<string>;
  readonly files: Set<string>;
  readonly tests: Set<string>;
  readonly symbols: Map<string, SymbolRecord>; // key path:startLine:name
  readonly references: Set<string>; // "path:line": text matches, not declarations
  readonly searches: Map<string, SearchRecord>;
  /** Records one completed tool call; returns its search record (count > 1 means a repeat). */
  record(tool: string, input: Record<string, unknown>, result: ToolResult): SearchRecord;
  reset(): void;
}

const noise = /^(\(empty\)$|No test files found\.$|\[(Truncated|Scan stopped))/;
const lines = (content: string) => content.split("\n").filter((l) => l && !noise.test(l));

// Parsers read the output formats of list_directory, find_tests and find_symbol; state.test.ts runs the real tools
// through them so a format change fails a test rather than silently recording nothing.
function discover(state: NavigationState, tool: string, input: Record<string, unknown>, content: string): void {
  if (tool === "list_directory") {
    state.exploredDirs.add(String(input.path ?? ".") || ".");
    for (const l of lines(content)) if (!l.endsWith("/")) state.files.add(l);
  } else if (tool === "find_tests") {
    for (const l of lines(content)) {
      state.tests.add(l);
      state.files.add(l);
    }
  } else if (tool === "find_symbol") {
    let last = "";
    for (const l of content.split("\n")) {
      const decl = /^(.+?):(\d+)-(\d+) (\w+) (\S+) \[tree-sitter/.exec(l);
      const text = /^(.+?):(\d+): .* \[text-search/.exec(l);
      const also = /^\s+also on lines: (.*)$/.exec(l);
      if (decl) {
        const [, path, start, end, kind, name] = decl;
        state.symbols.set(`${path}:${start}:${name}`, { name: name!, kind: kind as SymbolKind, path: path!, startLine: +start!, endLine: +end! });
        state.files.add(path!);
        last = path!;
      } else if (text) {
        state.references.add(`${text[1]}:${text[2]}`);
        state.files.add(text[1]!);
      } else if (also) {
        for (const n of also[1]!.split(",")) if (/^\s*\d+\s*$/.test(n)) state.references.add(`${last}:${n.trim()}`);
      }
    }
  }
}

/** Canonical key: same tool and same arguments, ignoring key order and empty values. */
function keyOf(tool: string, input: Record<string, unknown>): string {
  const kept = Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== "").sort(([a], [b]) => (a < b ? -1 : 1));
  return tool + ":" + JSON.stringify(kept);
}

/** `onDuplicate` is called for each repeated call; the agent wiring turns it into the navigation_duplicate_detected log. */
export function createNavigationState(root: string, onDuplicate?: (record: SearchRecord) => void): NavigationState {
  const state: NavigationState = {
    root,
    exploredDirs: new Set(),
    files: new Set(),
    tests: new Set(),
    symbols: new Map(),
    references: new Set(),
    searches: new Map(),
    record(tool, input, result) {
      const key = keyOf(tool, input);
      const existing = state.searches.get(key);
      const rec = existing ?? { tool, input, count: 0 };
      rec.count++;
      state.searches.set(key, rec);
      if (existing) onDuplicate?.(rec);
      if (!result.isError) discover(state, tool, input, result.content);
      return rec;
    },
    reset() {
      for (const c of [state.exploredDirs, state.files, state.tests, state.symbols, state.references, state.searches]) c.clear();
    },
  };
  return state;
}
