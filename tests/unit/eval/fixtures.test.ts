import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "eval/iteration3/fixtures");
const dirs = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const tmp = mkdtempSync(join(tmpdir(), "fixtures-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Manifest {
  task: string;
  repo_type: string;
  relevant_files: string[];
  acceptable_files: string[];
  target_symbols: string[];
  verification: { command: string };
}
const load = (d: string): Manifest => JSON.parse(readFileSync(join(ROOT, d, "manifest.json"), "utf8"));

describe("iteration 3 eval fixtures", () => {
  it("covers repository types A, B, C, D and an unsupported language with six tasks", () => {
    expect(dirs).toHaveLength(6);
    const types = new Set(dirs.map((d) => load(d).repo_type));
    expect([...types].sort()).toEqual(["A", "B", "C", "D", "unsupported-language"]);
  });

  describe.each(dirs)("%s", (d) => {
    const m = load(d);
    const description = readFileSync(join(ROOT, d, "description.txt"), "utf8").toLowerCase();

    it("has a complete manifest whose files exist", () => {
      expect(m.task).toBeTruthy();
      expect(m.relevant_files.length).toBeGreaterThan(0);
      expect(m.target_symbols.length).toBeGreaterThan(0);
      expect(m.verification.command).toBeTruthy();
      for (const f of [...m.relevant_files, ...m.acceptable_files]) {
        expect(existsSync(join(ROOT, d, "repo", f)), f).toBe(true);
      }
    });

    it("description leaks no relevant path, file name or target symbol", () => {
      for (const f of [...m.relevant_files, ...m.acceptable_files]) {
        expect(description, f).not.toContain(f.toLowerCase());
        expect(description, basename(f)).not.toContain(basename(f).toLowerCase());
      }
      for (const s of m.target_symbols) expect(description, s).not.toContain(s.toLowerCase());
    });

    it("verification command fails before the fix", () => {
      const repo = join(tmp, d);
      cpSync(join(ROOT, d, "repo"), repo, { recursive: true });
      const r = spawnSync(m.verification.command, { cwd: repo, shell: true, encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(r.stderr).not.toMatch(/not found|ENOENT|Cannot find module/); // red for the right reason
    });
  });
});
