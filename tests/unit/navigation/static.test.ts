import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../../src/navigation");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

// INVARIANT-5a5b83ad / DECISION-8ecf2c97: navigation stays provider-agnostic.
describe("navigation layer independence", () => {
  const forbidden = [/@anthropic-ai\/sdk/, /@google\/genai/, /\bfrom\s+["']openai["']/, /\.\.\/(\.\.\/)*providers\//, /\.\.\/(\.\.\/)*agent\//];

  it("scans a non-trivial set of files", () => {
    expect(files(ROOT).length).toBeGreaterThanOrEqual(8);
  });

  it("imports no LLM SDK, provider adapter or agent loop", () => {
    for (const f of files(ROOT)) {
      const imports = readFileSync(f, "utf8").split("\n").filter((l) => /^\s*(import|export)\b.*\bfrom\b|^\s*import\s*\(/.test(l));
      for (const line of imports) {
        for (const re of forbidden) expect(re.test(line), `${f}: ${line}`).toBe(false);
      }
    }
  });
});
