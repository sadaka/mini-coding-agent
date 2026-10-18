# Iteration 2 — Real-World Retrospective

Record of what broke when the agent was first run against a real project, why it
took eight rounds to fix, and the constraints Iteration 3 must not relitigate.

The test suite was green (86 passing) before, during and after every bug below.

---

## 1. Outcome

A static HTML website, task: add a responsive image-carousel gallery page, link it
in the nav, remove the previous gallery. Eight consecutive failed runs, then success.

Final successful run: 13 LLM calls, 22 tool calls, peak context 13,647 tokens
(7.0% of the usable window), 1 truncation, 0 compactions, 0 drops.

---

## 2. The nine bugs

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | API 400 `unexpected tool_use_id` | "Sandwich ordering" reordered messages, separating a `tool_use` from its `tool_result` | Deleted sandwich ordering (already dead code after a downstream re-sort) |
| 2 | API 400 `tool_use ids ... without tool_result` | Compaction kept "recent N by index", slicing between an assistant call and its result | Pair validation in `buildMessagesForProvider` |
| 3 | `edit_file: Unknown operation: .` ×11 | `max_tokens: 8192` cut generation off mid-`tool_use`; SDK returned partially-parsed args with fields missing | Reject `stop_reason === "max_tokens"` when a tool call is present; cap → 16384 |
| 4 | Same failure ×11, all 20 iterations burned | Repeat-guard keyed on `JSON.stringify(input)`; truncation differed by a byte each retry so every retry looked new | Key on tool name + error message |
| 5 | `find: \|: unknown primary or operator` | `spawn` uses `shell: false`; the pipe reached `find` as a literal argument | Reject shell metacharacters; state the constraint and the allowlist in the tool description |
| 6 | Task died "No files modified" while progressing | Failure counts accumulated across the whole run — "three strikes ever", not "stuck" | Clear counters on any successful tool call |
| 7 | `edit_file: Unknown operation: .` ×3 | Tool demanded an `operation` discriminator no mainstream editing API uses; the model omits it and ignores the corrective error | Infer the operation from which fields are present |
| 8 | API 400 `unexpected tool_use_id` (again) | Failed tool results get `importance: "high"` → builder hoists them above their own assistant turn; `Date.now()` ties made the chronological re-sort unable to undo it; role-based validation accepted the mismatch | Monotonic timestamps + validate matching tool ids, not roles |
| 9 | Iteration limit, repeated re-reads of the same files | Compaction fired at 22,323 tokens while the build budget was 195,904 — two components each derived the same quantity independently | Provider's real window drives the policy; one source of truth |

Bug 8 additionally exposed unconditional content-hash dedup in the context builder,
which could silently drop one half of a pair. Assistant turns and tool results are
now exempt.

---

## 3. Why it took eight rounds

**The bugs were layered.** Each fix was a precondition for observing the next. The
repeat-guard's over-firing (6) killed runs before they reached the iteration counts
where the ordering bug (8) appears; the ordering bug crashed runs before the
compaction divergence (9) could show up as an iteration limit. This part was mostly
unavoidable — but it means "one green run" never implied "no more bugs", and should
not have been treated as progress toward done.

**I diagnosed from stack traces instead of instrumenting.** `--debug-context` was
built in this very iteration (IMPL-IT2-6) and went unused until round eight. The
first run with it produced the number that settled the argument (peak 7.0%
utilisation, 0 compactions) in one line. Seven rounds of reasoning substituted for
one run with the instrument already in the box.

**I shipped plausible theories as fixes.** Rounds 3 and 5 asserted a cause without
reproducing it. Both were wrong. The `max_tokens` diagnosis in round 4 was real but
incomplete, and because it explained the symptom it masked bug 7, which produced the
identical error string for an unrelated reason.

**I patched the output layer three times before reading the selection logic.** Bugs
1, 2 and 8 were all "fix the message list in `loop.ts`". Bugs 8 and 9 and the dedup
bug all lived in `context-builder.ts` / `policies.ts`, which I did not read until
round seven. Three rounds were spent downstream of the code that was actually wrong.

**What finally worked was a search, not an argument.** A brute-force sweep of all
128 failure patterns over seven iterations found the precondition for bug 8 in
seconds — 94 of 128 patterns mismatched — after six rounds of reasoning had failed
to locate it.

---

## 4. Why the tests kept passing

The mock provider encoded the same assumptions as the code under test:

```ts
generate: vi.fn(async () => ({
  type: "tool_calls",
  toolCalls: [{ id: "c1", name: "search", input: { query: "x" } }],
}))
```

- It never set `stop_reason`, so truncated tool arguments were unrepresentable (3).
- It always returned well-formed `input`, so input-keyed stuck detection was never
  stressed (4).
- It asserted nothing about message order or id pairing (1, 2, 8).
- Every `edit_file` test passed `operation` explicitly, so the shape the model
  actually sends was never exercised (7).
- Timestamps were never tied, so the ordering bug could not appear (8).
- No test compared the compaction trigger against the build budget (9).

The deeper problem: **the tests were written from the same mental model as the
code**, so they verified "the code does what I think it does" rather than "the code
satisfies the external contract". Every constraint that actually broke — pair
adjacency, id matching, `stop_reason` semantics, the model's real tool-call shape —
lived in the provider's API and was absent from the double.

**The sharpest evidence:** while actively trying to catch a *known* bug, three
successive regression tests passed against known-broken code before one reproduced
it. Two were wrong about the precondition; one froze the clock entirely, which makes
*every* item tie — a case that degrades safely. The breaking condition is distinct
timestamps per iteration with ties *within* one. Writing a test that "looks like"
the scenario proves nothing.

---

## 5. Rules for Iteration 3

1. **A fix is unverified until its test fails without it.** Revert the fix, run the
   test, see it fail for the right reason, restore. Report the before/after. A
   passing suite is not evidence that the new test exercises the bug.
2. **Build a contract-checking fake provider.** It should assert, on every call,
   what the real API enforces: each `tool_result` immediately follows its
   `tool_use`, ids match, roles alternate as required. This one artifact would have
   caught bugs 1, 2 and 8 before any of them reached a real run.
3. **Fuzz the state space instead of reasoning about it.** Failure patterns,
   tied timestamps, interleavings. The sweep that found bug 8 took minutes to write
   and seconds to run.
4. **Derived config needs one source of truth.** Bug 9 was two components each
   choosing a defensible value for the same quantity with nothing asserting they
   agree. Prefer deriving over duplicating a default.
5. **Use the instrumentation before theorising.** If a diagnostic flag exists, the
   first response to an unexplained failure is to run with it on.
6. **Read the whole subsystem before patching its edge.** Trace selection and
   ordering end to end before touching the message list.
7. **Treat a tool's contract as a model-facing API.** Three of nine bugs were the
   harness knowing something it never told the model. If the model repeatedly
   ignores a corrective error message, the contract is wrong, not the model's
   reading.
8. **One green run proves little.** Tool-call sequences vary between runs; the
   successful run did not exercise bug 9's fix at all (see below).

---

## 6. Honest limitations of the successful run

- **Bug 9's fix was not exercised.** Peak context was 13,647 tokens = 48.9% of the
  *old* usable window, below the 0.80 threshold. Compaction would not have fired
  under the old configuration either. The threshold divergence is a real defect, but
  its causal role in the earlier iteration-limit failure is **unproven** — that run
  predated `--debug-context`, so there is no record of whether compaction fired.
- **Compaction is therefore still largely untested against a real provider.** No
  real-world run has yet crossed the new 156,723-token threshold.
- **`Verification: not performed`.** The agent completed without running a
  verification command. For a static HTML site there is no test command, so
  INVARIANT-0143a4f3 (never claim success on the model's confidence alone) is
  satisfied only in the weak sense that the report says verification did not run.
  Iteration 3 should decide what verification means for projects with no test suite.
- **Success may be partly nondeterministic.** The task text was unchanged across all
  nine runs while tool-call sequences differed substantially.

---

## 7. Decisions changed by this work

Recorded via `genesis record`; listed here for narrative context.

| Recorded decision | What changed |
|---|---|
| DECISION-0fa985d8 (context token defaults) | `MAX_CONTEXT_TOKENS=32000` is now a last-resort fallback; the provider's `capabilities()` window drives compaction. Explicit env still wins. |
| DECISION-811bfc29 (command safety policy) | Allowlist widened beyond npm/node to read-only shell utilities (`find`, `grep`, `ls`, `cat`, `wc`, `head`, `tail`, `echo`) plus `python`, `python3`, `npx`. **This widens a deny-by-default safety boundary and deserves explicit human review.** |
| DECISION-42507f50 (edit/write tool contract) | Still exactly two operations, but `operation` is now optional and inferred from the payload; it is no longer in the schema's `required` list. |
| INVARIANT-836fbff6 (repeated failure protection) | Threshold now counts *consecutive* identical failures; any successful tool call resets it. A thrashing-but-progressing agent is bounded by `maxIterations` instead. |
