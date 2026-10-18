import { extname } from "node:path";
import { getProviderForExtension } from "./registry.js";
import { ensureGrammar } from "./tree-sitter.js";
import type { SymbolMatch, SymbolQuery } from "./types.js";

/**
 * Structural lookup in one file. Returns null when there is no provider, no grammar, or the
 * provider fails, so the caller falls back to text search. An empty array means "parsed, none found".
 */
export async function locateSymbols(path: string, source: string, query: SymbolQuery): Promise<SymbolMatch[] | null> {
  const ext = extname(path);
  const provider = getProviderForExtension(ext);
  if (!provider || !(await ensureGrammar(ext))) return null;
  try {
    return provider.findSymbols(source, query).map((m) => ({ ...m, path, source: "tree-sitter" as const }));
  } catch {
    return null;
  }
}
