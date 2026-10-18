import type { Node } from "web-tree-sitter";
import { registerSymbolProvider } from "../registry.js";
import { parseSource } from "../tree-sitter.js";
import type { SymbolMatch, SymbolProvider, SymbolQuery } from "../types.js";

type Found = Omit<SymbolMatch, "path">;

const SIGNATURE_MAX = 200;

const kids = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c !== null);

/** `def f(...) -> T` up to the body's colon, on one line. */
function header(source: string, def: Node, body: Node): string {
  const text = source.slice(def.startIndex, body.startIndex).replace(/\s+/g, " ").replace(/:\s*$/, "").trim();
  return text.length > SIGNATURE_MAX ? text.slice(0, SIGNATURE_MAX) + "…" : text;
}

/** The body's leading string statement, dedented. */
function docstring(body: Node): string | undefined {
  const first = kids(body)[0];
  const str = first?.type === "expression_statement" ? first.namedChild(0) : null;
  if (str?.type !== "string") return undefined;
  const text = kids(str).filter((c) => c.type === "string_content").map((c) => c.text).join("");
  const [head = "", ...rest] = text.split("\n");
  const indent = Math.min(...rest.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), Infinity);
  const lines = [head.trim(), ...rest.map((l) => (Number.isFinite(indent) ? l.slice(indent) : l).trimEnd())];
  return lines.join("\n").trim() || undefined;
}

function extract(source: string, root: Node): Found[] {
  const out: Found[] = [];

  // `outer` owns the line range: the decorated_definition wrapper when there is one, so decorators are included.
  function walk(node: Node, inClass: boolean, outer: Node = node) {
    if (node.type === "decorated_definition") {
      const def = node.childForFieldName("definition");
      if (def) walk(def, inClass, node);
      return;
    }
    if (node.type !== "function_definition" && node.type !== "class_definition") {
      for (const c of kids(node)) if (c.type === "block" || c.type.endsWith("_statement") || c.type.endsWith("_clause")) walk(c, inClass);
      return;
    }
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!name || !body) return;
    const isClass = node.type === "class_definition";
    const doc = docstring(body);
    out.push({
      name: name.text,
      kind: isClass ? "class" : inClass ? "method" : "function",
      startLine: outer.startPosition.row + 1,
      endLine: outer.endPosition.row + 1,
      signature: header(source, node, body),
      ...(doc ? { docstring: doc } : {}),
      source: "tree-sitter",
    });
    for (const c of kids(body)) walk(c, isClass);
  }

  for (const c of kids(root)) walk(c, false);
  return out;
}

export const pythonProvider: SymbolProvider = {
  language: "python",
  extensions: [".py"],
  findSymbols(source: string, query: SymbolQuery) {
    const tree = parseSource(".py", source);
    if (!tree) throw new Error("python grammar is not loaded"); // locator turns this into "unavailable"
    return extract(source, tree.rootNode).filter((s) => s.name === query.name && (!query.kind || s.kind === query.kind));
  },
};

/** Call once at startup. Throws if .py is already taken (registry contract). */
export function registerPythonProvider(): void {
  registerSymbolProvider(pythonProvider);
}
