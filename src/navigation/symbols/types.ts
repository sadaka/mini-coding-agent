export type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "constant"
  | "module"
  | "unknown";

export interface SymbolQuery {
  name: string;
  kind?: SymbolKind;
}

export interface SymbolMatch {
  name: string;
  kind: SymbolKind;
  path: string;
  startLine: number; // 1-indexed, inclusive
  endLine: number;
  signature?: string;
  docstring?: string;
  // Text matches are never declarations (FR-54); the third value is for merged results.
  source: "tree-sitter" | "text-search" | "tree-sitter+text-search";
}

export interface SymbolProvider {
  language: string;
  /** Lowercase, with the leading dot: ".ts". */
  extensions: string[];
  /** Synchronous: the locator makes sure the grammar is loaded first. `path` is filled in by the caller. */
  findSymbols(source: string, query: SymbolQuery): Omit<SymbolMatch, "path">[];
}
