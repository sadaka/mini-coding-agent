# Iteration 3 baseline report

Recorded 2026-10-08 by IMPL-IT3-0, before any Iteration 3 product change. Satisfies FR-66 / AC-40.

## Health at baseline

- `npx vitest run`: **100 tests** pass in 12 files (Iteration 1 + Iteration 2, mocked LLM).
- `npx tsc --noEmit`: clean.
- Frozen copy of the Iteration 2 source: `eval/iteration3/baseline-src/` (identical to `src/`, `.DS_Store` aside). The repository has no Git history, so this copy is the only way to run the original `search` / `read_file` for baseline evaluation runs.

## Iteration 2 retrospective defects (`eval/iteration2/real-world-retrospective.md`)

Nine bugs found in real-world runs; all nine are fixed in the baseline source and recorded as invariants or decisions:

| # | Defect | Status |
|---|---|---|
| 1, 2, 8 | tool_use / tool_result pairing broken (reorder, partial drop, timestamp ties) | fixed; INVARIANT-64d38bc1, INVARIANT-30642a03 |
| 3 | `max_tokens` truncated tool calls mid-generation | fixed |
| 4, 6 | repeat-failure guard keyed on input / never reset | fixed |
| 5 | shell metacharacters reached `find` | fixed (DECISION-c0d3e4f4 widened the allowlist, see below) |
| 7 | `edit_file` demanded an `operation` field | fixed; DECISION-750f3967 |
| 9 | compaction trigger and build budget derived separately | fixed; INVARIANT-bd1f755c, DECISION-ebd3d4ac |

## Documented, not fixed (carried into Iteration 3)

1. **Compaction never exercised against a real provider.** No real run has crossed the 156,723-token threshold, and bug 9's fix was not exercised by the successful run (retrospective section 6). Iteration 3 closes this in IMPL-IT3-13 (scripted) and IMPL-IT3-18 (real provider, needs cost authorization).
2. **`Verification: not performed` for projects with no test command.** For the static HTML/CSS/JS fixture there is no test suite; INVARIANT-0143a4f3 is only weakly satisfied. The evaluation manifests carry an explicit `verification.command` so the harness verifies independently (FR-63, FR-64); what the agent itself should do is a question for the Iteration 3 engineering note.
3. **DECISION-c0d3e4f4 still NEEDS HUMAN REVIEW.** The `run_command` allowlist was widened (find, grep, ls, cat, wc, head, tail, echo, python, python3, npx), contradicting DECISION-811bfc29. `cat` is not workspace-confined and `python` / `npx` permit arbitrary execution. Iteration 3 does not change it.
4. **`assertInWorkspace` is string-prefix based and does not resolve symlinks.** Navigation tools get realpath confinement (NFR-15); the existing edit and run tools are unchanged.

## Genesis ledger items inherited

- **IMPL-IT2-1** is still `paused`. Its deliverables (`src/context/types.ts`, token estimator, policies) exist and are exercised by IMPL-IT2-2 to IMPL-IT2-7, which are done with proof. It was not reactivated or rewritten.
- **IMPL-7** is `rejected` (live Gemini evaluation); superseded by the completed IMPL-9 (live Claude evaluation).
- Completed Iteration 1 and 2 tasks, evidence and approvals are untouched.

## Retrospective rules carried forward

Test must fail without its fix; contract-checking fake provider; fuzz state space; one source of truth for derived config; use instrumentation before theorising; read the whole subsystem before patching; treat tool contracts as a model-facing API; one green run proves little (hence 5 runs per cell).
