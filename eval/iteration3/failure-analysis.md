# Iteration 3 Navigation Failure Analysis (§34)

Source: `results/run-1.json` (60 runs, claude-haiku-5-5, $0.1934), plus the two failures found while building.

## Result of the evaluation

**No run failed.** All 60 runs were independently verified (30/30 baseline, 30/30 Iteration 3), so there is no
evaluation failure to classify. Nothing below is invented to fill the gap. The taxonomy needs an observed failure,
and the six fixture repositories (3 to 13 files each) are small enough that the agent can read most of the repo,
so navigation errors have little room to become task failures.

What the runs do show is weaker than a failure: **inefficiency**. Those cases are listed under "Near misses".

## Failures observed during the build

### 1. CONTEXT_HANDOFF: provider received untruncated tool output (FIX-IT3-TRUNCATION)

| | |
|---|---|
| First incorrect action | `loop.ts` rebuilt provider messages from `messageStore`, which holds the original `Message`, not the truncated context item. |
| Should have done | Send the truncated content for each tool_result block. |
| Why it failed | `ContextManager` truncated the item, but the request was built from a different copy. Per-tool caps bounded only the token accounting. A probe sent about 195 KB against a 4,000-token cap. |
| Cause | Context (handoff between the context manager and the loop). Not a tool bug and not the model. |
| Smallest fix | Truncate each tool_result block by its own tool name where `toolResultContents` is built (item-level truncation cannot work: one tool message holds several results). Applied, with tests that fail without it. |

### 2. CONTEXT_COMPACTION: agent redid its exploration after compaction (IMPL-IT3-18, **undiagnosed**)

| | |
|---|---|
| First incorrect action | With `MAX_RECENT_ITEMS=2`, compaction left only the init message on request 2. |
| Should have done | Keep the compaction summary in the request so earlier reads are not lost. |
| Why it failed | **Not known.** Either the summary item was created and then filtered out by the builder, or it was never created (it lists only `read_file` results that carry `source.filePath`). I have not checked which. |
| Cause | Context, probably. This is a hypothesis, not a diagnosis. |
| Effect | 12 tool calls instead of 6. The run still finished and verified. |
| Smallest fix | None proposed until the cause is found. The default (`MAX_RECENT_ITEMS=8`) did not trigger it. |

## Near misses in the 60 runs

These did not fail a task. They are classified because §34 asks what went wrong, and "did not fail" is not "ideal".

| Observation | Class | Cause | Smallest change |
|---|---|---|---|
| Iteration 3 sent more context on `tax-total-off-by-one-cent` (7,706 vs 5,419 tokens) and `free-shipping-boundary` (4,633 vs 3,839). | EXCESSIVE_EXPLORATION | Model/tool selection: extra `list_directory` and `find_tests` calls (about 1.3 per run) on repos small enough to read directly. | None. Test on repos where listing earns its cost (see Evaluation design). |
| `find_symbol` was called in 5 of 30 runs, mostly on one task. | TOOL_SELECTION | Model chose `search` instead. On a 3 to 13 file repo, text search is enough. | None. |
| 2 of 30 Iteration 3 runs used no navigation tool. | TOOL_SELECTION | The prompt says no tool is required first. | None. This is the intended behaviour. |
| Irrelevant files read: 1.80 per run (Iteration 3) vs 1.57 (baseline). | EXCESSIVE_EXPLORATION | The navigation tools did not reduce irrelevant reads. | None; within noise at n=5. |

## The evaluation design is the main problem

Every run succeeded and the secondary metrics differ by less than the run-to-run spread, so this evaluation
cannot say whether navigation helps. Cause: **evaluation design**. The repos are too small for "where should I
look?" to matter, and the tasks are too easy for Haiku 5.5. The fix is harder tasks on larger repositories
with a symptom-only description, not another navigation feature.

## Not measured

- **`rg` fallback frequency.** Nothing in the metrics or logs records whether `rg` or the built-in scan ran.
- **REPOSITORY_SCOPE, REFERENCE_DISCOVERY, RESULT_RANKING, PROVIDER:** no evidence either way. No run recorded a scope filter event, a reference lookup or a provider error.
