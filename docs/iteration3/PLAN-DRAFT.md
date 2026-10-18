# Iteration 3 plan (DRAFT — awaiting specification approval)

Status: proposed. Not yet in the Genesis ledger: `genesis task add` is refused until the specification is approved. After approval, run `docs/iteration3/apply-plan.sh`, then `genesis plan check .`; the generated `.genesis/PLAN.md` becomes the canonical plan. Specification: `SPEC.md` → "Iteration 3" (FR-42–FR-66, NFR-14–NFR-20, AC-23–AC-40).

Iteration 1/2 tasks are untouched. Every task keeps the full regression gate (`npx vitest run`, 100 tests today) so Iteration 1 and 2 behavior is protected at every step. Tasks IMPL-IT3-18 and 19 incur paid API usage and stay blocked until you authorize provider, model and run cap.

## Dependency order

- IMPL-IT3-0: Baseline & prerequisites
- IMPL-IT3-1 ← IMPL-IT3-0: RepositoryScope
- IMPL-IT3-2 ← IMPL-IT3-1: list_directory tool
- IMPL-IT3-3 ← IMPL-IT3-1: Unified search
- IMPL-IT3-4 ← IMPL-IT3-1: Focused read_file
- IMPL-IT3-5 ← IMPL-IT3-1: find_tests tool
- IMPL-IT3-6 ← IMPL-IT3-0: Symbol infrastructure and Tree-sitter spike
- IMPL-IT3-7 ← IMPL-IT3-6: TypeScript/JavaScript provider
- IMPL-IT3-8 ← IMPL-IT3-6: Python provider
- IMPL-IT3-9 ← IMPL-IT3-3, IMPL-IT3-7, IMPL-IT3-8: find_symbol with text fallback
- IMPL-IT3-10 ← IMPL-IT3-7, IMPL-IT3-8: add-language scaffolding
- IMPL-IT3-11 ← IMPL-IT3-2, IMPL-IT3-3, IMPL-IT3-4, IMPL-IT3-5, IMPL-IT3-9: NavigationState and tool registration
- IMPL-IT3-12 ← IMPL-IT3-11: Navigation logging and metrics
- IMPL-IT3-13 ← IMPL-IT3-11: Context Manager integration
- IMPL-IT3-14 ← IMPL-IT3-12, IMPL-IT3-13: Agent, prompt and CLI wiring
- IMPL-IT3-15 ← IMPL-IT3-14: End-to-end mocked navigation integration
- IMPL-IT3-16 ← IMPL-IT3-0: Evaluation fixtures and manifests
- IMPL-IT3-17 ← IMPL-IT3-12, IMPL-IT3-16: Evaluation harness and independent verifier
- IMPL-IT3-18 ← IMPL-IT3-13, IMPL-IT3-14, IMPL-IT3-15: Real-provider context test (needs human cost authorization)
- IMPL-IT3-19 ← IMPL-IT3-17, IMPL-IT3-18: Baseline vs Iteration 3 evaluation runs (needs human cost authorization)
- IMPL-IT3-20 ← IMPL-IT3-19: Failure analysis, engineering note and README

## IMPL-IT3-0 — Baseline & prerequisites

- risk: low
- depends on: none
- requirements: FR-66, AC-40, NFR-19
- file scope: `eval/iteration3`
- outcome: Iteration 2 is frozen as the evaluation baseline and its health is on record before any Iteration 3 change: src/ copied to eval/iteration3/baseline-src/, eval/iteration3/baseline-report.md lists the 100 passing tests and tsc status, the Iteration 2 retrospective defects (fixed or documented), the paused IMPL-IT2-1, rejected IMPL-7, the open DECISION-c0d3e4f4 review, compaction never exercised against a real provider, and 'verification not performed' for projects with no test command (affects the static-site task). No product code changes.
- acceptance scenario `baseline-frozen`: Developer · eval/iteration3 · expects baseline-src mirrors current src and the report names every inherited open item
- gates: `typecheck`, `regression`, `report`

## IMPL-IT3-1 — RepositoryScope

- risk: medium (adds independent-review gate)
- depends on: IMPL-IT3-0
- requirements: FR-42, FR-43, FR-44, FR-45, NFR-15, NFR-18, AC-23
- file scope: `src/navigation/scope.ts`, `tests/unit/navigation/scope.test.ts`
- outcome: src/navigation/scope.ts decides what navigation may inspect: default exclusions (configurable), git check-ignore when the workspace is a Git repo, binary detection, *.min.js/css exclusion, and a realpath-based workspace boundary that rejects symlink escape. Pure module with no tool wiring.
- acceptance scenario `scope-filters`: Navigation tool · temp Git repo and temp non-Git dir fixtures · expects ignored, default-excluded, minified and binary paths are filtered; symlink to outside is rejected; non-Git dir falls back to defaults
- gates: `typecheck`, `tests`, `regression`, `independent-review`

## IMPL-IT3-2 — list_directory tool

- risk: low
- depends on: IMPL-IT3-1
- requirements: FR-46, NFR-16, AC-24
- file scope: `src/navigation/list-directory.ts`, `tests/unit/navigation/list-directory.test.ts`
- outcome: src/navigation/list-directory.ts registers list_directory (path, depth, includeHidden): scope-filtered, deterministic order, depth bound, entry ceiling with truncation notice, clear errors for missing dir and workspace escape.
- acceptance scenario `list-bounded`: Agent via tool call · fixture repo with >ceiling entries · expects ordered, bounded listing with notice; error on ../ and nonexistent dir
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-3 — Unified search

- risk: low
- depends on: IMPL-IT3-1
- requirements: FR-47, NFR-16, NFR-18, AC-25
- file scope: `src/tools/search.ts`, `src/navigation/rg.ts`, `tests/unit/navigation/search.test.ts`, `src/tools/tools.test.ts`
- outcome: src/tools/search.ts is extended in place: mode content|filename|both, scope filtering, deterministic order, rg executable when present else built-in bounded scan with identical output format; every existing parameter and the 'No results found.' / truncation messages keep working.
- acceptance scenario `search-rg-parity`: Agent via tool call · fixture repo; run with and without an rg executable on PATH · expects same result set both ways; existing search tests unchanged and green
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-4 — Focused read_file

- risk: medium (adds independent-review gate)
- depends on: IMPL-IT3-1
- requirements: FR-48, NFR-15, AC-26
- file scope: `src/tools/readfile.ts`, `src/tools/workspace.ts`, `tests/unit/navigation/read-file.test.ts`, `src/tools/tools.test.ts`
- outcome: src/tools/readfile.ts keeps its parameters and adds contextLines, numbered output, streamed ranged reads (no whole-file load for a small range), binary notice, invalid-range errors and a truncation marker, using realpath workspace confinement. Calculator edit flow still works with numbered output.
- acceptance scenario `read-range-bounded`: Agent via tool call · multi-MB fixture and tiny fixtures · expects exact numbered lines for a range, bounded memory/read for a huge file, error on bad range, binary notice, symlink escape rejected
- gates: `typecheck`, `tests`, `regression`, `independent-review`

## IMPL-IT3-5 — find_tests tool

- risk: low
- depends on: IMPL-IT3-1
- requirements: FR-49, AC-27
- file scope: `src/navigation/find-tests.ts`, `tests/unit/navigation/find-tests.test.ts`
- outcome: src/navigation/find-tests.ts registers find_tests using the file/directory conventions for TS/JS and Python plus filename heuristics, scope-filtered and bounded.
- acceptance scenario `tests-found`: Agent via tool call · TS, JS and Python fixture trees · expects expected test files returned, non-test files excluded
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-6 — Symbol infrastructure and Tree-sitter spike

- risk: medium (adds independent-review gate)
- depends on: IMPL-IT3-0
- requirements: FR-50, FR-51, NFR-14, NFR-17, AC-28
- file scope: `package.json`, `package-lock.json`, `src/navigation/symbols`, `tests/unit/navigation/registry.test.ts`, `tests/unit/navigation/tree-sitter.test.ts`, `tests/unit/navigation/static.test.ts`
- outcome: Pinned web-tree-sitter and tree-sitter-wasms added; src/navigation/symbols/{types,registry,locator,tree-sitter}.ts exist; a spike test proves TS, JS and Python grammars load and parse on the installed Node; registry rejects duplicates and returns no provider for unknown extensions; a static test proves src/navigation imports no LLM SDK. If the spike fails, stop and ask the human (DECISION-8e437c98).
- acceptance scenario `grammar-spike`: Developer · installed Node 26, offline after install · expects TS/JS/Python sources parse without error; a missing grammar returns a handled failure
- gates: `typecheck`, `tests`, `regression`, `independent-review`

## IMPL-IT3-7 — TypeScript/JavaScript provider

- risk: low
- depends on: IMPL-IT3-6
- requirements: FR-52, AC-29
- file scope: `src/navigation/symbols/languages/javascript-typescript.ts`, `tests/fixtures/symbols/ts`, `tests/unit/navigation/ts-provider.test.ts`
- outcome: src/navigation/symbols/languages/javascript-typescript.ts extracts functions, classes, methods, interfaces, type aliases, variables/constants and exported/default declarations with line ranges, signature and docstring where cheap; comments are ignored; registered for .ts .tsx .js .jsx.
- acceptance scenario `ts-symbols`: find_symbol caller · TS and JS fixtures · expects each declaration kind found with correct start/end line; comment text is not a symbol
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-8 — Python provider

- risk: low
- depends on: IMPL-IT3-6
- requirements: FR-53, AC-30
- file scope: `src/navigation/symbols/languages/python.ts`, `tests/fixtures/symbols/python`, `tests/unit/navigation/python-provider.test.ts`
- outcome: src/navigation/symbols/languages/python.ts extracts functions, classes, methods, nested and module-level definitions with line ranges; comments ignored; registered for .py.
- acceptance scenario `py-symbols`: find_symbol caller · Python fixture · expects def/class/method/nested found with correct lines; comment text is not a symbol
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-9 — find_symbol with text fallback

- risk: low
- depends on: IMPL-IT3-3, IMPL-IT3-7, IMPL-IT3-8
- requirements: FR-54, NFR-18, AC-31
- file scope: `src/navigation/find-symbol.ts`, `src/navigation/symbols/locator.ts`, `tests/unit/navigation/find-symbol.test.ts`
- outcome: src/navigation/find-symbol.ts registers find_symbol (symbol_name, path?): scope-filtered candidates, structural lookup via the registry, word-matched text fallback (rg or built-in) for unsupported languages/no structural hit/grammar failure, correct source labels (tree-sitter | text-search | tree-sitter+text-search), bounded results.
- acceptance scenario `symbol-or-fallback`: Agent via tool call · mixed TS/Python/unsupported-language fixture; grammar load forced to fail · expects right source label per case; not-found message; path restriction honored; text matches not called declarations
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-10 — add-language scaffolding

- risk: low
- depends on: IMPL-IT3-7, IMPL-IT3-8
- requirements: FR-55, AC-32
- file scope: `scripts/add-language.ts`, `package.json`, `tests/unit/navigation/add-language.test.ts`
- outcome: npm run add-language <name> (scripts/add-language.ts) validates the name, scaffolds provider, fixture and test, registers the provider, runs tsc and the new test, and prints TODOs; refuses invalid/existing names; touches no agent, context, provider, CLI or existing navigation file.
- acceptance scenario `add-java`: Developer · temp copy of the repo · expects java scaffold generated, compiles, its test runs; protected directories unchanged; bad name refused
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-11 — NavigationState and tool registration

- risk: low
- depends on: IMPL-IT3-2, IMPL-IT3-3, IMPL-IT3-4, IMPL-IT3-5, IMPL-IT3-9
- requirements: FR-56, FR-57, AC-33
- file scope: `src/navigation/state.ts`, `src/navigation/index.ts`, `tests/unit/navigation/state.test.ts`
- outcome: src/navigation/state.ts holds task-local NavigationState (files, symbols, references, tests, searches), records repeats without blocking, and resets per task; src/navigation/index.ts exposes registerNavigationTools(registry, root, state) for list_directory, find_symbol and find_tests. Nothing persisted.
- acceptance scenario `state-records`: Navigation tools · scripted tool calls incl. identical repeated search · expects state records discoveries, repeat is recorded and still executed, new task starts empty
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-12 — Navigation logging and metrics

- risk: low
- depends on: IMPL-IT3-11
- requirements: FR-61, FR-62
- file scope: `src/agent/logger.ts`, `src/navigation/metrics.ts`, `tests/unit/navigation/metrics.test.ts`
- outcome: Twelve navigation log events added to the logger with the required fields (no secrets) and a per-task metrics summary built from NavigationState; relevance metrics are explicitly left to the evaluation harness.
- acceptance scenario `events-emitted`: Navigation tools · scripted calls with a log sink · expects each event appears once with taskId/timestamp/duration/count/size/source; no key material in output
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-13 — Context Manager integration

- risk: medium (adds independent-review gate)
- depends on: IMPL-IT3-11
- requirements: FR-58, AC-34
- file scope: `src/context/truncator.ts`, `src/context/policies.ts`, `tests/unit/context`, `tests/unit/navigation/context-integration.test.ts`
- outcome: src/context truncator/policies gain type-specific handling for list_directory, find_symbol and find_tests (priority and truncation) with no second budget; tests drive search, read, find_symbol, edit and run_command sequences through forced compaction and assert tool_use/tool_result id pairing (INVARIANT-64d38bc1) and ordering (INVARIANT-30642a03).
- acceptance scenario `compaction-pairing`: Agent loop with scripted LLM · long scripted run forcing compaction · expects every tool result follows its matching call after compaction; new tools truncated by type; no navigation output bypasses the Context Manager
- gates: `typecheck`, `tests`, `regression`, `independent-review`

## IMPL-IT3-14 — Agent, prompt and CLI wiring

- risk: medium (adds independent-review gate)
- depends on: IMPL-IT3-12, IMPL-IT3-13
- requirements: FR-59, FR-60, AC-35
- file scope: `src/cli/index.ts`, `src/agent/loop.ts`, `tests/unit/navigation/debug-navigation.test.ts`, `src/agent/loop.test.ts`
- outcome: CLI and Agent Loop register the navigation tools, own a fresh NavigationState per task, the system prompt describes the tools without a fixed sequence, and --debug-navigation prints scope exclusions, calls and a bounded summary; output without the flag is byte-identical to Iteration 2.
- acceptance scenario `debug-flag`: Developer running the CLI with a scripted provider · fixture repo · expects flag on prints scope, calls, summary; flag off output equals the Iteration 2 snapshot; all tools visible to the provider
- gates: `typecheck`, `tests`, `regression`, `independent-review`

## IMPL-IT3-15 — End-to-end mocked navigation integration

- risk: low
- depends on: IMPL-IT3-14
- requirements: AC-36, NFR-19
- file scope: `tests/integration`, `tests/fixtures/nav-repo`
- outcome: tests/integration/navigation.test.ts runs the full agent on a multi-file fixture repo with a scripted LLM using a navigation sequence different from the requirements example, then asserts final repository state and the verification command, not the sequence; Iteration 1 calculator integration still passes.
- acceptance scenario `unknown-location-fix`: Agent with scripted LLM · multi-file fixture repo copy · expects bug fixed and verification command passes via search, find_symbol, ranged read, edit, test
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-16 — Evaluation fixtures and manifests

- risk: low
- depends on: IMPL-IT3-0
- requirements: FR-63, AC-37
- file scope: `eval/iteration3/fixtures`, `tests/unit/eval/fixtures.test.ts`
- outcome: eval/iteration3/fixtures holds repositories A (TS/JS), B (Python), C (static HTML/CSS/JS), D (noisy) and an unsupported-language case, each with a task description and JSON ground-truth manifest; a test confirms descriptions do not leak relevant paths or target symbol names and each verification command runs red before the fix.
- acceptance scenario `no-leak`: Evaluator · six fixture tasks · expects no description contains a relevant path or target symbol; each verification fails before the fix
- gates: `typecheck`, `tests`, `regression`

## IMPL-IT3-17 — Evaluation harness and independent verifier

- risk: medium (adds independent-review gate)
- depends on: IMPL-IT3-12, IMPL-IT3-16
- requirements: FR-64, AC-38
- file scope: `eval/iteration3/run.ts`, `eval/iteration3/check-results.ts`, `tests/unit/eval/harness.test.ts`
- outcome: eval/iteration3/run.ts runs a task N times against baseline-src or current src, records per-run metrics, computes relevant/irrelevant files read and time to first relevant file from the manifest, and independently re-runs the verification command; check-results.ts validates result completeness. Tested on recorded logs with a scripted provider; no paid provider is called.
- acceptance scenario `verifier-independent`: Evaluator · recorded logs, scripted provider · expects metrics match hand-computed values; a run whose verification fails is marked failed regardless of agent claim
- gates: `typecheck`, `tests`, `regression`, `independent-review`

## IMPL-IT3-18 — Real-provider context test (needs human cost authorization)

- risk: medium (adds independent-review gate)
- depends on: IMPL-IT3-13, IMPL-IT3-14, IMPL-IT3-15
- requirements: FR-58
- file scope: `eval/iteration3/real-context`
- outcome: BLOCKED until the human authorizes provider, model and run cap. One real-provider run that forces compaction over navigation tools completes with valid message pairing; the transcript and metrics are saved under eval/iteration3/real-context/.
- acceptance scenario `real-compaction`: Evaluator with API key · real provider, authorized spend · expects run completes, compactions > 0, pairingValid true
- gates: `result`, `independent-review`

## IMPL-IT3-19 — Baseline vs Iteration 3 evaluation runs (needs human cost authorization)

- risk: medium (adds independent-review gate)
- depends on: IMPL-IT3-17, IMPL-IT3-18
- requirements: AC-39
- file scope: `eval/iteration3/results`
- outcome: BLOCKED until authorized. Six tasks x 5 runs x {Iteration 2 baseline, Iteration 3} recorded under eval/iteration3/results/ and independently verified by the harness; check-results confirms 5 verified runs per cell.
- acceptance scenario `runs-complete`: Evaluator with API key · real provider, authorized spend · expects every task/version cell has >=5 independently verified runs
- gates: `results`, `independent-review`

## IMPL-IT3-20 — Failure analysis, engineering note and README

- risk: low
- depends on: IMPL-IT3-19
- requirements: FR-65, NFR-20
- file scope: `eval/iteration3`, `README.md`
- outcome: eval/iteration3/failure-analysis.md classifies each failure with the section 34 taxonomy, comparison.md compares baseline and Iteration 3, engineering-note.md answers the 14 questions, and README documents the tools, --debug-navigation, add-language and a navigation module map.
- acceptance scenario `note-complete`: Reader · eval/iteration3 and README · expects 14 numbered answers, taxonomy-classified failures, README covers every new tool and flag
- gates: `typecheck`, `regression`, `docs`

