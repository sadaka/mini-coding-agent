import { createRequire } from "node:module";
import { Language, Parser, type Tree } from "web-tree-sitter";

const require = createRequire(import.meta.url);

// extension -> tree-sitter-wasms grammar file
const GRAMMAR_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
};

let initPromise: Promise<boolean> | undefined;
const languages = new Map<string, Language>(); // grammar name -> loaded
const failed = new Set<string>();

function init(): Promise<boolean> {
  initPromise ??= Parser.init().then(
    () => true,
    () => false,
  );
  return initPromise;
}

/** Null on any failure (missing file, corrupt wasm, ABI mismatch); never throws (FR-51, NFR-18). */
export async function loadLanguageFromFile(path: string): Promise<Language | null> {
  if (!(await init())) return null;
  try {
    return await Language.load(path);
  } catch {
    return null;
  }
}

export function hasGrammarFor(ext: string): boolean {
  return ext.toLowerCase() in GRAMMAR_BY_EXT;
}

/** Loads (once) the grammar for an extension. False means: use the text fallback. */
export async function ensureGrammar(ext: string): Promise<boolean> {
  const name = GRAMMAR_BY_EXT[ext.toLowerCase()];
  if (!name || failed.has(name)) return false;
  if (languages.has(name)) return true;
  let file: string;
  try {
    file = require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
  } catch {
    failed.add(name);
    return false;
  }
  const lang = await loadLanguageFromFile(file);
  if (!lang) {
    failed.add(name);
    return false;
  }
  languages.set(name, lang);
  return true;
}

/** Sync: the grammar must already be loaded via ensureGrammar. Null if not, or if parsing throws. */
export function parseSource(ext: string, source: string): Tree | null {
  const lang = languages.get(GRAMMAR_BY_EXT[ext.toLowerCase()] ?? "");
  if (!lang) return null;
  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser.parse(source);
  } catch {
    return null;
  }
}
