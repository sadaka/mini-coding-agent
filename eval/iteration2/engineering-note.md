# Iteration 2 Engineering Note

Answers to the nine learning questions from §66 of the Iteration 2 spec,
based on the evaluation results in `eval/iteration2/summary.json`.

---

## Q1 — What information did the agent generate during a long task?

During the Long Task evaluation (14 search + read cycles), the agent accumulated:
- The initial task message (~50 tokens)
- 14 assistant messages containing tool calls
- 14 search tool results (~200 tokens each)
- 14 read_file tool results (~200 tokens each)

By iteration 14 the raw message stream totalled ~4,600 tokens (IT1 baseline).
With IT2 context management active, the working set was kept to ~1,600 tokens
through two compactions.

---

## Q2 — What information was actually sent to the model?

After compaction, each LLM call received a sandwich-ordered message set:

1. **Pinned first** — the task description (critical, non-removable), any
   important facts, and the compaction summary item
2. **Older removable turns in the middle** — the turns that survived the
   most recent compaction (kept as recent items or summary)
3. **Most recent N turns last** — the last `MAX_RECENT_ITEMS` (default 8)
   turns, placed at the end where recall is highest

The context_metrics log showed ~1,600 estimated input tokens sent per call
after compaction, versus the IT1 baseline accumulating 4,600+ tokens with
no reduction.

---

## Q3 — What information was removed?

The compactor removed older, removable tool results — specifically:

- Intermediate search results from earlier cycles that were no longer the
  most recent
- Intermediate read_file results that had already been acted on
- Assistant tool-call messages corresponding to those results

Non-removable items (task description, important facts, system prompt) were
never removed. The most recent `MAX_RECENT_ITEMS` turns were also always kept.

---

## Q4 — Why was it removed?

Removal was triggered deterministically when estimated input tokens crossed
`COMPACTION_THRESHOLD × usableInputTokens`. The compactor's logic:

1. Always keep: system, task_state, important_fact, non-removable items
2. Always keep: the most recent N items (recency bias for model recall)
3. Summarise and drop: everything else — replaced with a structured
   compaction summary listing files accessed, commands run, test results,
   and recent errors

The goal is not to minimise tokens unconditionally, but to keep the context
within the provider's effective working window while preserving critical state.

---

## Q5 — What information was most important to preserve?

In priority order:

1. **The task description** — the agent's goal; losing this causes complete
   derailment. Stored as `importance: "critical"`, `removable: false`.
2. **Test results and error messages** — the compaction summary explicitly
   extracts lines matching `error|fail|exception` and `passed|failed|skipped`.
3. **Modified file paths** — tracked in `AgentState.modifiedFiles`, not in
   the message context, so never subject to compaction.
4. **Important facts** — items added with `type: "important_fact"` survive
   compaction unconditionally (tested in Task 7).
5. **Most recent tool results** — the last N turns, because the model's next
   decision depends on the most recent action's outcome.

---

## Q6 — How much context was saved?

From the evaluation table:

| Task | IT1 tokens | IT2 tokens | Reduction |
|---|---|---|---|
| Simple Bug Fix | 379 | 492 | −30% (IT2 overhead from context tracking) |
| Multi-file Change | 540 | 653 | −17% (same) |
| Large Search | 755 | 637 | **+16% saved** (truncation fired) |
| Large File | 1037 | 834 | **+20% saved** (truncation fired) |
| Long Task | 4604 | 1608 | **+65% saved** (two compactions fired) |
| Repeated Search | 1193 | 1306 | −9% (no compaction triggered) |
| Important Early Discovery | 1871 | 1984 | −6% (no compaction triggered) |

For short tasks, IT2 adds a small overhead (~100 tokens) from context tracking
bookkeeping. For long tasks with large tool outputs, savings are significant
and prevent provider token-limit failures entirely.

---

## Q7 — Did context reduction affect task success?

Yes — in one decisive case. The Long Task:

- **IT2**: succeeded at iteration 29 (2 compactions kept context in budget)
- **IT1**: failed at iteration 25 (hit `MAX_AGENT_ITERATIONS` before the
  scripted provider could complete; token accumulation was the root cause)

For all other tasks, both versions succeeded. IT2's truncation of large
search/file results (Tasks 3 & 4) did not cause failures — the truncated
content retained enough information for the scripted agent to proceed.

---

## Q8 — What failures were caused by context management?

No failures were caused by IT2's context management in this evaluation.

The one failure observed was an IT1 failure caused by the *absence* of context
management: unbounded token accumulation meant the agent ran out of iterations
before completing the scripted task sequence.

One design risk identified during review: the compaction summary may lose
fine-grained detail (e.g. exact line numbers from an error) when it extracts
only the last 5 error lines. This was not observed to cause a failure in the
current evaluation tasks but remains a latent risk for tasks requiring precise
error context across compaction boundaries.

---

## Q9 — What should be improved in Iteration 3?

**Context management (carry forward):**
- The compaction threshold and token limits are currently configured only via
  environment variables. A config file or structured profile would make
  tuning more accessible.
- The compaction summary is deterministic but shallow — it does not understand
  code semantics. An LLM-generated summary (Option B from §23) would produce
  higher-fidelity summaries for code-heavy contexts.
- `droppedCount` grows monotonically but there is no per-item provenance.
  When a task fails after compaction, it is hard to identify which dropped
  item caused the regression.

**Iteration 3 focus (repository navigation):**
- The agent currently searches by keyword pattern. It has no model of the
  repository structure — it cannot answer "which file is most likely to
  contain the bug?" before reading anything.
- Adding a lightweight repository index (symbol graph, import graph) would
  let the agent target reads rather than scanning broadly, reducing the
  context pressure that Iteration 2 manages reactively.
- The core question for Iteration 3: *where should the agent look*, not just
  *what should it keep*.
