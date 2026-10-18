/**
 * Validates that an evaluation results file is complete: every task x source cell has exactly `runs` runs,
 * numbered 1..runs, with every metric present. A missing run is a hole in the comparison, not a pass.
 *
 *   tsx eval/iteration3/check-results.ts RESULTS.json [--runs 5]
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FIXTURES, loadManifest, type RunResult, type Source } from "./run.js";

const SOURCES: Source[] = ["baseline", "current"];

export function checkResults(results: RunResult[], tasks: string[], runs = 5): string[] {
  const problems: string[] = [];
  for (const task of tasks) {
    for (const source of SOURCES) {
      const cell = results.filter((r) => r.task === task && r.source === source);
      const numbers = cell.map((r) => r.run).sort((a, b) => a - b);
      const expected = Array.from({ length: runs }, (_, i) => i + 1);
      if (JSON.stringify(numbers) !== JSON.stringify(expected)) {
        problems.push(`${task}/${source}: expected runs ${expected.join(",")} but found [${numbers.join(",")}]`);
      }
    }
  }
  for (const r of results) {
    const where = `${r.task}/${r.source}#${r.run}`;
    if (!tasks.includes(r.task)) problems.push(`${where}: unknown task`);
    if (typeof r.verified !== "boolean" || r.success !== r.verified) problems.push(`${where}: success must equal the independent verification`);
    for (const [group, obj] of [["metrics", r.metrics], ["efficiency", r.efficiency]] as const) {
      for (const [k, v] of Object.entries(obj ?? {})) if (v === undefined) problems.push(`${where}: ${group}.${k} is missing`);
      if (!obj) problems.push(`${where}: ${group} is missing`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The genesis gate calls this as `--min-runs 5` with no file: check every run file under results/.
  const runsFlag = Math.max(process.argv.indexOf("--runs"), process.argv.indexOf("--min-runs"));
  const file = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
  const dir = join(dirname(fileURLToPath(import.meta.url)), "results");
  const files = file ? [file] : readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "ledger.json").map((f) => join(dir, f));
  if (!files.length) {
    console.error("Usage: check-results.ts [RESULTS.json] [--runs N|--min-runs N]; no result files found");
    process.exit(2);
  }
  const tasks = readdirSync(FIXTURES).filter((d) => !d.startsWith(".")).map((d) => loadManifest(join(FIXTURES, d)).task);
  const problems = checkResults(files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as RunResult[]), tasks, runsFlag > 0 ? Number(process.argv[runsFlag + 1]) : 5);
  for (const p of problems) console.error(p);
  console.log(problems.length ? `${problems.length} problem(s)` : "Results complete");
  process.exit(problems.length ? 1 : 0);
}
