import type { Node } from "web-tree-sitter";
import { registerSymbolProvider } from "../registry.js";
import { parseSource } from "../tree-sitter.js";
import type { SymbolKind, SymbolMatch, SymbolProvider, SymbolQuery } from "../types.js";

type Found = Omit<SymbolMatch, "path">;

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const SIGNATURE_MAX = 200;

const kids = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c !== null);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Source from the start of `from` up to the start of `body` (or the first line if there is none). */
function header(source: string, from: Node, body: Node | null): string {
  const end = body ? body.startIndex : from.endIndex;
  const text = oneLine(source.slice(from.startIndex, end).split("\n").slice(0, body ? undefined : 1).join(" "));
  return text.length > SIGNATURE_MAX ? text.slice(0, SIGNATURE_MAX) + "…" : text;
}

/** JSDoc block directly above `anchor`, with the comment markers stripped. */
function docstring(anchor: Node): string | undefined {
  const prev = anchor.previousSibling;
  if (!prev || prev.type !== "comment" || !prev.text.startsWith("/**")) return undefined;
  if (prev.endPosition.row < anchor.startPosition.row - 1) return undefined;
  const text = prev.text.replace(/^\/\*\*+/, "").replace(/\*+\/$/, "").split("\n").map((l) => l.replace(/^\s*\*? ?/, "")).join("\n").trim();
  return text || undefined;
}

function extract(source: string, root: Node): Found[] {
  const out: Found[] = [];

  function push(name: string, kind: SymbolKind, range: Node, signature: string, docAnchor: Node = range) {
    const docstringText = docstring(docAnchor);
    out.push({
      name, kind,
      startLine: range.startPosition.row + 1,
      endLine: range.endPosition.row + 1,
      signature,
      ...(docstringText ? { docstring: docstringText } : {}),
      source: "tree-sitter",
    });
  }

  function classMembers(body: Node) {
    for (const m of kids(body)) {
      const name = m.childForFieldName("name");
      if (!name) continue;
      if (m.type === "method_definition" || m.type === "abstract_method_signature") {
        push(name.text, "method", m, header(source, m, m.childForFieldName("body")));
      } else if (m.type === "public_field_definition") {
        const value = m.childForFieldName("value");
        if (value && FUNCTION_VALUES.has(value.type)) push(name.text, "method", m, header(source, m, value.childForFieldName("body")));
      }
    }
  }

  // `outer` is the node that owns the range and doc comment: the export/declare wrapper if any.
  function declaration(node: Node, outer: Node) {
    const field = (f: string) => node.childForFieldName(f);
    const name = field("name");
    switch (node.type) {
      case "export_statement": {
        const decl = node.childForFieldName("declaration");
        if (decl) return declaration(decl, node);
        const value = node.childForFieldName("value"); // export default <function|class expression>
        if (value && (FUNCTION_VALUES.has(value.type) || value.type === "class")) {
          push("default", value.type === "class" ? "class" : "function", node, header(source, node, value.childForFieldName("body")));
        }
        return;
      }
      case "ambient_declaration": {
        const inner = kids(node).find((c) => c.type !== "comment");
        if (inner) declaration(inner, node);
        return;
      }
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature":
        if (name) push(name.text, "function", outer, header(source, outer, field("body")));
        return;
      case "class_declaration":
      case "abstract_class_declaration": {
        const body = field("body");
        if (name) push(name.text, "class", outer, header(source, outer, body));
        if (body) classMembers(body);
        return;
      }
      case "interface_declaration":
        if (name) push(name.text, "interface", outer, header(source, outer, field("body")));
        return;
      case "type_alias_declaration":
      case "enum_declaration":
        if (name) push(name.text, "type", outer, header(source, outer, null));
        return;
      case "internal_module":
      case "module": {
        const body = field("body");
        if (name) push(name.text, "module", outer, header(source, outer, body));
        if (body) for (const c of kids(body)) declaration(c, c);
        return;
      }
      case "expression_statement": // `namespace X {}` parses as an expression statement wrapping internal_module
        for (const c of kids(node)) if (c.type === "internal_module" || c.type === "module") declaration(c, node);
        return;
      case "lexical_declaration":
      case "variable_declaration": {
        const isConst = node.type === "lexical_declaration" && node.child(0)?.text === "const";
        for (const d of kids(node)) {
          const id = d.type === "variable_declarator" ? d.childForFieldName("name") : null;
          if (!id || id.type !== "identifier") continue; // destructuring patterns are not named declarations
          const value = d.childForFieldName("value");
          const isFn = !!value && FUNCTION_VALUES.has(value.type);
          push(id.text, isFn ? "function" : isConst ? "constant" : "variable", d.id === kids(node)[0]?.id ? outer : d,
            header(source, d, isFn ? value!.childForFieldName("body") : null), outer);
        }
        return;
      }
    }
  }

  // Module level only: locals inside function bodies are not indexed.
  for (const child of kids(root)) declaration(child, child);
  return out;
}

/** One provider per grammar: the provider interface carries no file extension to pick TS vs TSX vs JS. */
function createProvider(language: string, extensions: string[], grammarExt: string): SymbolProvider {
  return {
    language,
    extensions,
    findSymbols(source: string, query: SymbolQuery) {
      const tree = parseSource(grammarExt, source);
      if (!tree) throw new Error(`${language} grammar is not loaded`); // locator turns this into "unavailable"
      return extract(source, tree.rootNode).filter((s) => s.name === query.name && (!query.kind || s.kind === query.kind));
    },
  };
}

export const typescriptProvider = createProvider("typescript", [".ts", ".mts", ".cts"], ".ts");
export const tsxProvider = createProvider("tsx", [".tsx"], ".tsx");
export const javascriptProvider = createProvider("javascript", [".js", ".jsx", ".mjs", ".cjs"], ".js");

/** Call once at startup. Throws if an extension is already taken (registry contract). */
export function registerJavaScriptTypeScriptProviders(): void {
  for (const p of [typescriptProvider, tsxProvider, javascriptProvider]) registerSymbolProvider(p);
}
