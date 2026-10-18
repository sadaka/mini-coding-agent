# Iteration 3 Engineering Note

Answers to the 14 questions in §42 of the Iteration 3 spec. Evidence: `results/run-1.json` (60 verified runs,
claude-haiku-5-5), `comparison.md`, `failure-analysis.md`, and the IT3-18 real-context run.

Read this first: **the evaluation is a ceiling.** Both versions solved 30 of 30 tasks, the fixture repos have 3 to 13
files, and n=5 per cell. It can show that Iteration 3 did not break anything. It cannot show that navigation helps.
Where a question needs more than that, the answer says "not measured" or "cannot tell".

1. **Does repository structure discovery improve agent performance?**
   Not shown. Success was 30/30 in both versions. `list_directory` was used in 26 of 30 Iteration 3 runs (0.97 calls
   per run), and tool calls before the first relevant read were 3.40 against 3.27 for the baseline. On repos this
   small the agent finds the file with `search` alone.

2. **Does ignoring generated/vendor/noisy content materially help?**
   Cannot tell. The noisy fixture (`week-starts-on-monday`, 13 files) read 1.4 irrelevant files per run against 1.2 for
   the baseline. The scope filter works in unit and integration tests, but the runs did not record
   `navigation_scope_filtered` events, so how much was filtered is not known.

3. **Does focused reading reduce context usage?**
   Not shown. Context sent per run was 4,386 tokens against 4,147 for the baseline (+6 percent). It fell on three
   tasks, by up to 29 percent, and rose on `tax-total` (+42 percent) and `free-shipping` (+21 percent). These are the
   harness's estimates and the gaps are within what five runs can show.

4. **Does Tree-sitter symbol discovery outperform ordinary text search for relevant tasks?**
   Cannot tell. `find_symbol` ran 5 times in 30 runs: 0.17 tree-sitter matches and 0.33 text-search fallback matches
   per run, no irrelevant ones. No run compared the two methods on the same question.

5. **When does the agent choose symbol discovery?**
   Rarely: 5 runs of 30, one call each, four of them on `tax-total-off-by-one-cent` and one on
   `week-starts-on-monday`. The pattern fits a task that names something like a function. I did not read the model's
   reasoning, so this is an inference from which tasks they were.

6. **When does it choose normal search?**
   Almost always. `search` was 2.40 calls per run for Iteration 3 and 3.33 for the baseline. It is the first tool
   for most tasks, and it replaced about one call per run with `list_directory` rather than being displaced by
   `find_symbol`.

7. **How often is `rg` fallback required?**
   Not measured. Nothing in the metrics or logs records whether `rg` or the built-in scan ran. If `rg` is on
   `PATH` it is used and the fallback is silent. Adding a counter is the smallest change; I have not added one.

8. **Does language-specific structural information improve task success?**
   Cannot tell, for the reason in question 1. The unsupported-language task (`empty-the-account`) succeeded 5/5 in
   both versions, so lacking a parser did not cost success here either.

9. **How much irrelevant repository information does the agent consume?**
   About 1.8 irrelevant files per run in Iteration 3 against 1.57 for the baseline, out of 3.77 and 3.57 files read
   (roughly half). Iteration 3 did not reduce this. Irrelevant symbol matches were 0.

10. **Does the current navigation interface make tool selection easier or harder?**
    Neither effect is visible. Two of 30 runs used no navigation tool, which the prompt allows. There were no repeated
    searches in either version. Whether any tool call returned an error is not summarised in the results, so
    I cannot say if the interface caused wasted calls.

11. **Does the Context Manager preserve useful navigation information?**
    Partly checked. In the 60 runs peak context was about 950 tokens, so compaction almost certainly never ran. In the
    separate IT3-18 real run (window 6,000 tokens, `MAX_RECENT_ITEMS=2`, 5 compactions) the tool-call pairing stayed
    valid and the run verified, but the agent repeated its exploration (12 tool calls instead of 6) because the
    compaction summary was not in the request. The cause is undiagnosed (`failure-analysis.md`, failure 2). So
    preservation of working state under compaction is unproven.

12. **What navigation failures actually occur in real tasks?**
    None in the 60 evaluation runs. Two while building: provider requests ignored the per-tool truncation caps
    (fixed, FIX-IT3-TRUNCATION), and state lost across compaction (undiagnosed). The main weakness the
    runs exposed is inefficiency, not failure.

13. **Are the failures caused by tools, context, or the model?**
    Both observed failures are context handling. Neither was a search, symbol or listing tool defect, and neither was
    the model's reasoning. With no failed runs in the evaluation, this says nothing about tool or model failures on
    harder tasks.

14. **Is there evidence that we need something more sophisticated?**
    No evidence, and no evidence against. §43 requires an observed limitation before building indexing, embeddings
    or memory, and there is none: keyword search was sufficient on every task. But the tasks cannot reveal one.
    The decision is to build nothing new from this data and to run the same comparison on larger repositories with
    symptom-only descriptions before deciding. The compaction finding should be diagnosed first.

## What I would do next

1. Diagnose the compaction summary loss.
2. Save the per-call trace and billed tokens per run, so "what was searched and what it found" can be read, not inferred.
3. Add harder tasks: real repositories of hundreds of files, a failing test as verification, a description that
   doesn't name the file. Repeat with enough runs to report variance.
4. Add an `rg`-versus-fallback counter if question 7 still matters.
