import type { NavigationState } from "./state.js";

export interface NavigationMetrics {
  callsByType: Record<string, number>;
  filesDiscovered: number;
  filesRead: number;
  repeatedSearches: number;
  /** Parsed declarations vs whole-word text matches; relevance metrics belong to the eval harness (FR-62). */
  treeSitterSymbolMatches: number;
  fallbackSymbolMatches: number;
  symbolMatches: number;
}

/** `filesRead` is not tracked by NavigationState; the caller passes the paths read_file touched. */
export function summarizeNavigation(state: NavigationState, filesRead: Iterable<string> = []): NavigationMetrics {
  const callsByType: Record<string, number> = {};
  let repeatedSearches = 0;
  for (const s of state.searches.values()) {
    callsByType[s.tool] = (callsByType[s.tool] ?? 0) + s.count;
    repeatedSearches += s.count - 1;
  }
  return {
    callsByType,
    filesDiscovered: state.files.size,
    filesRead: new Set(filesRead).size,
    repeatedSearches,
    treeSitterSymbolMatches: state.symbols.size,
    fallbackSymbolMatches: state.references.size,
    symbolMatches: state.symbols.size + state.references.size,
  };
}
