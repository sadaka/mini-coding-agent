# Product specification — Engineering Agent (Iteration 1)

> Iteration 1 status: approved and implemented (2026-09-28).
> Iteration 2 status: draft, pending human approval. No Iteration 2 product implementation code is written until this specification is approved through Genesis.

## Problem

Coding agents (Claude Code, Copilot, Pi, etc.) are widely used but poorly understood by their users. This project builds a small, independent, provider-agnostic coding agent from scratch — not to compete with existing products, but to understand how the core agent loop (LLM ⇄ tools ⇄ verification) actually works, through incremental implementation, repeatable testing, and evidence-based failure analysis.

Iteration 1 builds the minimum working version of this agent: a CLI that accepts a coding task, hands it to an LLM with a small set of tools (search, read, edit, run command), executes the resulting tool calls against a real local repository, feeds results back to the LLM, and verifies the outcome before reporting success — all through a provider-independent interface so the LLM backend is swappable.

## Users

- **Primary user / operator**: the developer building and evaluating this agent (learning-driven use), running it against small local repositories from a CLI.
- **Secondary/future user**: a developer using the agent to assist with real small coding tasks, once reliability is established (explicitly a secondary, not primary, goal for Iteration 1).
- **No end users beyond the CLI operator** in Iteration 1 — there is no team, multi-user, or hosted deployment context.

## Functional requirements

### Iteration 1 (in scope)

- FR-1: The system provides a CLI that accepts a coding task as a natural-language argument (e.g. `engineering-agent "Fix the failing test in calculator.ts"`).
- FR-2: The CLI accepts an optional `--workspace <path>` flag; when omitted, the workspace root defaults to the current working directory at invocation.
- FR-3: The CLI accepts an optional `--model <model>` (and provider configuration via environment) to select the LLM model without code changes.
- FR-4: The system sends the user task, system instructions, and available tool definitions to an LLM through a provider-independent LLM Interface, and receives either a text response or a structured tool call.
- FR-5: A Gemini provider adapter implements the LLM Interface: authenticates via `GEMINI_API_KEY`/`GEMINI_MODEL` environment variables, translates internal messages/tools to Gemini's API format, parses Gemini responses (text and tool calls) into internal `LLMResponse` structures, and normalizes Gemini errors into a provider-independent `ProviderError` shape.
- FR-6: The Agent Loop, Tools, CLI, and Context Manager contain no direct references to any provider SDK (Gemini or otherwise); all provider-specific code is isolated inside the provider adapter.
- FR-7: A Tool Registry allows tools to be registered and looked up by name; the Agent Loop obtains tools only through the registry, never by direct instantiation.
- FR-8: A **Search** tool locates files/code within the workspace by query (optional path, file pattern, case sensitivity, max results), returning file path, line number, and matching text per result, with clear truncation and no-results handling. Workspace-only.
- FR-9: A **Read File** tool reads a file or a line range from it within the workspace, returns a clear error for missing files, and truncates oversized output with an explicit `[Output truncated...]` notice.
- FR-10: An **Edit/Write File** tool supports exactly two operations: `write` (create or overwrite full file content) and `replace` (find an exact `old_string` in the target file and substitute `new_string`; fails if `old_string` does not match exactly once). Both operations are restricted to the workspace, reject unsafe/outside paths, and record which files were modified.
- FR-11: A **Run Command** tool executes a command in the workspace (or a specified subdirectory of it), subject to the command safety policy (FR-13), with a configurable timeout (default 30s) and combined stdout+stderr output cap (default 100KB, truncated with notice beyond that), returning exit code, stdout, stderr, and a `timedOut` flag.
- FR-12: The Agent Loop implements: receive request → build context → send to LLM → on tool call: validate input, apply safety policy, execute tool, record result, append to context, increment iteration, continue; on text response: check completion, run verification, return result. The loop stops on success, failure, cancellation, or a configured limit.
- FR-13: A command safety policy classifies every Run Command invocation as `ALLOW` or `DENY` (no `CONFIRM` tier in Iteration 1). Default `ALLOW`: `npm test`, `npm run build`, `npm run lint`, `npm run <script>` where `<script>` is defined in the workspace's `package.json`, and `node <file>` where `<file>` resolves inside the workspace. Everything else — including `npm install`/`npm ci`, `rm`, `git push`, `sudo`, `curl`, `chmod`, and any non-matching command — is `DENY` by default. The policy is a single, easily extensible module.
- FR-14: The Agent Loop enforces `MAX_AGENT_ITERATIONS` (default 20, configurable). On reaching the limit, task status becomes `failed` with reason `iteration_limit`, and the final report clearly states the agent stopped due to the iteration limit.
- FR-15: The Agent Loop detects repeated identical or substantially identical failed actions (e.g. the same command producing the same failure) and stops after a configurable threshold, reporting that the same failing action was repeated, rather than continuing indefinitely.
- FR-16: Before reporting a task complete, the system runs a verification step (e.g. the relevant test/build command) and the final report explicitly distinguishes: changes made, verification performed, verification passed/failed, verification not performed, and remaining uncertainty. The agent never reports success based solely on the LLM's own confident text.
- FR-17: All file tool access is restricted to the configured workspace root; paths that resolve outside the workspace are rejected (`../../outside-workspace`-style traversal denied).
- FR-18: The CLI displays real-time progress (task description, tool invocations with names/targets, verification outcome) and a final clear success/failure status with an appropriate process exit code.
- FR-19: The system emits structured log events for at least: `task_started`, `llm_request`, `llm_response`, `tool_requested`, `tool_started`, `tool_completed`, `tool_failed`, `verification_started`, `verification_completed`, `task_completed`, `task_failed` — each including task ID, timestamp, iteration number, tool name (where applicable), success/failure, and duration. API keys and secrets are never logged.
- FR-20: A minimal system prompt instructs the model that it is a coding agent with the provided tools, to inspect before modifying, prefer minimal changes, search before reading large amounts of code, run relevant verification after changes, never claim success without verification, never invoke unavailable tools, and stop when the task is complete.

### Future iterations (out of scope for Iteration 1 — recorded for context only)

- **FR-F1**: Additional provider adapters (OpenAI, Claude, Groq, local models).
- **FR-F2**: Context budgeting, relevance-based selection, token measurement, compaction, resume support (Iteration 2).
- **FR-F3**: File discovery, symbol navigation, improved repository structure awareness (Iteration 3).
- **FR-F4**: Retry/replanning verification policies beyond basic pass/fail (Iteration 4).
- **FR-F5**: Explicit task planning with step status and plan revision (Iteration 5).
- **FR-F6**: Reusable skills / task-specific behavior modules (Iteration 6).
- **FR-F7**: Configurable tool extensions loaded without core changes (Iteration 7).
- **FR-F8**: Git tools — status, diff, commit, push — as *agent-invocable* capabilities, with safety rules preventing automatic/unsafe commits or pushes (Iteration 8). Note: manual developer `git init/add/commit` for the project's own source is in scope now (see Constraints), but is not an agent tool.
- **FR-F9**: Sub-agent delegation with isolated contexts and result aggregation (Iteration 9).
- **FR-F10**: RAG/retrieval, evaluated against a no-RAG baseline, adopted only on measurable improvement (Iteration 10).
- **FR-F11**: Persistent memory distinct from active context, with resume and correction support (Iteration 11).
- **FR-F12**: Formal permissions model, stronger evaluation, risk-based controls (Iteration 12).

## Non-functional requirements

- NFR-1: The Agent Loop, Tool Registry, Context Manager, and CLI must contain zero direct imports of any provider SDK — verifiable by static inspection (e.g. no `@google/genai`-style import outside the Gemini adapter module).
- NFR-2: File tool operations must not read, write, or execute outside the resolved workspace root under any input, including symlink or `..`-traversal attempts — verified by dedicated unit tests.
- NFR-3: The Run Command tool must never allow a command to run longer than its configured timeout (default 30s) or return more than its configured output cap (default 100KB) without explicit truncation notice.
- NFR-4: The Agent Loop must terminate within `MAX_AGENT_ITERATIONS` (default 20) on every run, with no code path that can loop indefinitely.
- NFR-5: No API key, token, or credential is ever written to logs, error messages, or committed configuration files; secrets are sourced only from environment variables / a gitignored `.env`.
- NFR-6: Every Iteration 1 tool (Search, Read File, Edit/Write, Run Command) and the Agent Loop must have unit tests covering at least the success path, the primary failure path, and the workspace/safety-boundary path (see AC-8..AC-11).
- NFR-7: The full Iteration 1 flow (search → read → edit → run command → verify) must be demonstrated against a real local repository fixture, not only against mocked components (integration test, AC-12).
- NFR-8: Switching the LLM provider must require touching only the provider adapter and its registration point — not the Agent Loop, tools, CLI, or Context Manager (structural NFR, validated by NFR-1's static check plus code review).

## Constraints

- **Technology**: TypeScript + Node.js (18+) + npm. `tsx` for dev execution, `vitest` for tests, `zod` for input validation, Gemini's official JS/TS SDK for the Gemini adapter only. No agent framework (e.g. LangChain) — the runtime is implemented directly.
- **Provider for Iteration 1**: Gemini is the only LLM provider implemented; the human has a `GEMINI_API_KEY` available and will supply it via environment variable outside of chat/version control.
- **Process governance**: This project is developed under the Genesis harness (specification → plan → task-by-task implementation with gates and approvals). Genesis's own task/plan/state tracking (`PLAN.md`, `project.json`, `genesis brief/status/context`) is the sole source of truth for progress and resumability; a separate hand-maintained `IMPLEMENTATION_PROGRESS.md` checklist, as literally described in the Iteration 1 document, is **not** maintained as a duplicate mechanism (see Decision, interview round 1 Q1).
- **Git for the project's own source**: the developer manually runs `git init`/`add`/`commit` (and later, manually, `git remote`/`push`) for the Engineering Agent's own codebase. This is ordinary source control hygiene, not an agent capability, and is out of scope for automated agent tooling in Iteration 1.
- **No secrets committed**: `.env` is gitignored; `.env.example` documents required variables without values.
- **Workspace scope**: the agent operates against one local workspace directory per invocation; no multi-repo or remote-repo support.

## Non-goals

- Not a general-purpose or commercial coding-agent product; not a clone of Claude Code, Copilot, or Pi.
- No dependency lock-in to a single LLM provider (architecture must support future adapters even though only Gemini ships now).
- No default full-repository ingestion — the agent must search/read selectively.
- No automatic execution of unsafe, destructive, or network-mutating operations.
- No RAG, vector databases, embeddings, persistent memory, sub-agent delegation, or complex multi-step planning in Iteration 1.
- No web UI — CLI only.
- No automatic git commit or git push performed by the agent itself.
- No `CONFIRM` command-policy tier in Iteration 1 — only `ALLOW`/`DENY`.
- No line-number-based or fuzzy/patch-style file editing in Iteration 1 — only whole-file `write` and exact-match `replace`.
- Full 5-task × multi-round evaluation suite and the complete cross-task failure-analysis framework are explicitly **deferred** past the first vertical slice (see AC boundary below) — not abandoned, but not required for the first Genesis plan to be accepted as complete.

## Trust boundaries

- **Human ⇄ CLI**: the human-provided task string and `--workspace`/`--model` flags are the only external inputs; they are not trusted to be safe paths or commands and must pass through the safety policy (FR-13, FR-17) before use.
- **LLM ⇄ Agent Loop**: the LLM's tool-call arguments are untrusted input from the agent's own perspective — every tool call is validated (schema + workspace/command policy) before execution, regardless of what the model "intends."
- **Agent ⇄ Filesystem**: all file operations are confined to the resolved workspace root; the boundary is enforced by path resolution + prefix check in the tool layer, not by convention.
- **Agent ⇄ Shell**: all command execution is confined to the ALLOW list in FR-13; the shell is never given arbitrary agent- or LLM-authored strings without policy evaluation.
- **Agent ⇄ Provider API**: the Gemini adapter is the only component that holds/transmits the API key; it is not exposed to the Agent Loop, tools, or logs.

## Safety requirements

- Workspace boundary enforcement on every file read/write/search (FR-17, NFR-2).
- Command allowlist/denylist enforcement on every Run Command invocation, deny-by-default (FR-13).
- Command timeout and output-size caps enforced unconditionally (FR-11, NFR-3).
- Iteration limit and repeated-failure detection to guarantee termination (FR-14, FR-15, NFR-4).
- No automatic git push/commit; no destructive command execution by default (Constraints, Non-goals).
- Verification-gated success reporting — no false-success declarations (FR-16).
- Secrets never logged or committed (FR-19, NFR-5, Constraints).

## Provider independence

- LLM Interface (`LLMProvider.generate(messages, tools, options) -> LLMResponse`) is the only contract the Agent Loop depends on.
- Internal types (`Message`, `ToolCall`, `ToolResult`, `LLMResponse`, `ProviderError`) are provider-neutral; the Gemini adapter is solely responsible for translating to/from them.
- NFR-1 and NFR-8 make this structurally verifiable, not just aspirational.

## Testing expectations

- **Unit tests** (vitest) for: LLM response/tool-call parsing and provider-error normalization (mocked provider API), each of the 4 tools (success, failure, and workspace/policy-boundary cases per NFR-6), and Agent Loop mechanics (tool round-trip, tool failure, provider failure, iteration limit, repeated-failure detection, verification-gated completion) using a mocked LLM.
- **Integration test**: a small fixture repository (`tests/fixtures/test-project` or equivalent) with a deliberate small bug, driven end-to-end through the real (or minimally mocked) loop: search → read → edit → run command → verify → finish (NFR-7).
- **Live agent evaluation**: exactly one real coding task (calculator bug fix) run against the live Gemini provider across multiple repeated runs, with **independent verification** (never trusting the agent's own final message) and a recorded success rate — this is the Iteration 1 acceptance bar. The remaining 4 tasks from the Iteration 1 document's suggested set, and the full UNDERSTANDING/SEARCH/.../PROVIDER failure-classification framework, are valuable and pre-specified but are fast-follow work, not required for Iteration 1 acceptance (see AC boundary).

## Success criteria

Iteration 1 is successful when:
- The full flow in AC-12 works against a real local repository through the Gemini provider adapter.
- Workspace and command safety policies are demonstrably enforced (tests + evidence).
- Iteration and repeated-failure limits are demonstrably enforced (tests + evidence).
- Unit and integration tests pass; at least one live evaluation run set (multiple repeated runs of one real task) exists with independently verified results.
- No secrets are present in logs, git history, or committed files.
- The system can answer, from its own implementation, the learning questions listed in the Iteration 1 document §35 (what is an agent loop, how does a tool round-trip work, how do we prevent infinite loops, etc.) — this is a qualitative review at acceptance, not a separate automated check.

## Acceptance criteria

- AC-1: Running `engineering-agent "<task>"` against a workspace with no `--workspace` flag operates on `process.cwd()`.
- AC-2: A task that requires finding a symbol succeeds using Search before any Read File call in the same run (search-before-read behavior is observable in the tool-call log, not separately enforced by the loop).
- AC-3: Read File on a nonexistent path returns a clear, structured error and does not throw an unhandled exception; reading a file larger than the output cap returns a truncation notice.
- AC-4: Edit/Write `replace` with an `old_string` that does not match exactly once fails with a clear error and makes no change to the file; `write` creates or fully overwrites the target file inside the workspace only.
- AC-5: Any file path resolving outside the workspace root (via absolute path or `../` traversal) is rejected by Read File, Edit/Write, and Search, with a clear error, and no filesystem access outside the workspace occurs.
- AC-6: A Run Command call for `npm test` (or another allowlisted command) executes and returns exit code, stdout, stderr, and `timedOut`; a call for a non-allowlisted command (e.g. `rm -rf /`, `git push`, `curl ...`) is denied before execution, with no side effect.
- AC-7: A command exceeding the configured timeout is terminated and reported with `timedOut: true`; output exceeding the configured cap is truncated with an explicit notice.
- AC-8: An agent run that would exceed `MAX_AGENT_ITERATIONS` stops with `status = failed`, `reason = iteration_limit`, and the CLI's final output explicitly states the iteration limit was reached.
- AC-9: An agent run in which the same command fails identically past the configured repeat threshold stops with a clear message that the same failing action was repeated, rather than continuing.
- AC-10: A completed task's final CLI report distinguishes, in plain language, whether verification was performed and whether it passed, failed, or was skipped; the agent never reports "success" when the configured verification command failed or was not run.
- AC-11: Every one of `task_started`, `llm_request`, `llm_response`, `tool_requested`, `tool_started`, `tool_completed`/`tool_failed`, `verification_started`, `verification_completed`, and `task_completed`/`task_failed` appears at least once in the structured log for a full successful run, with no API key ever present in any log line.
- AC-12: Given the fixture repository with a deliberately broken `calculator.ts` and the task "Fix the failing calculator test," the agent — through the real Gemini adapter — searches, reads, edits (via `replace` or `write`), runs the test command, observes the result, and reports a verified pass, reproducibly across multiple independent runs (success rate recorded, not assumed to be 100%). (end-to-end acceptance criterion)
- AC-13: A static/code-review check confirms no import of `@google/genai` (or equivalent Gemini SDK symbol) exists outside the Gemini adapter module (NFR-1, NFR-8).

## Risks

- **Live-LLM non-determinism**: Gemini may not reliably solve even the single chosen evaluation task on every run. *Mitigation*: AC-12 requires a recorded success rate across repeated runs, not 100% success; failure analysis on any failed run is expected, not a blocker to accepting Iteration 1, as long as the loop/tools/safety mechanics themselves are proven.
- **API cost/rate limits during repeated live evaluation runs**: *Mitigation*: mocked-LLM unit/integration tests cover the mechanics cheaply; live runs are reserved for the single AC-12 evaluation task.
- **Command allowlist too narrow to unblock realistic tasks** (e.g. agent needs a dependency not yet installed): *Mitigation*: accepted narrow-by-default trade-off per interview decision; can be revisited with evidence after Iteration 1.
- **Exact-match `replace` may fail often if the LLM's `old_string` doesn't match whitespace-for-whitespace**: *Mitigation*: known limitation of the chosen simple contract; tracked as an open question for Iteration 2 context work, not blocking Iteration 1.
- **Scope creep back toward the full Iteration 1 document** (5 tasks, full failure taxonomy) during implementation: *Mitigation*: the vertical-slice boundary (one live eval task) is a recorded Genesis decision; expanding it requires a new explicit decision, not silent inclusion.

## Open questions

- Should the deferred 4 evaluation tasks and full failure-analysis framework become their own Genesis task within this same Iteration 1 plan (fast-follow), or a distinct Iteration 1.1 initiated after review? (Recorded as a decision to make when planning the fast-follow task, not blocking the current plan.)
- What exact repeated-failure "substantially identical" comparison should use (e.g. same command string + same exit code + same stderr prefix) — left as an implementation-time decision within FR-15, to be recorded via `genesis record decision` when the Agent Loop task is implemented.
- None of the above block specification approval.

---

## Iteration 2 — Context Management & Token Efficiency

### Iteration 2 objective

Iteration 1 accumulated the full conversation history as a plain `Message[]` array and sent it to the LLM on every request. Iteration 2 introduces a dedicated **Context Manager** subsystem that explicitly controls what information is sent to the LLM, estimates token usage, truncates oversized outputs, and compacts older interaction history — all without breaking any existing Iteration 1 behavior.

**Explicitly not in Iteration 2**: RAG, embeddings, vector databases, semantic retrieval, persistent long-term memory, sub-agents, model routing, MCP, automatic model switching, sophisticated repository indexing, multi-agent communication, or distributed context storage. (See §2 of `coding-agent-harness-ietration2.md`.)

### New functional requirements (Iteration 2)

- FR-21: The system provides a `src/context/` subsystem containing: `types.ts`, `token-estimator.ts`, `truncator.ts`, `policies.ts`, `context-builder.ts`, `compactor.ts`, `context-metrics.ts`, and `context-manager.ts`. No Iteration 1 file is deleted or rewritten without a technical reason.
- FR-22: A `ContextItem` type exists with: `id`, `type` (`system` | `user` | `assistant` | `tool_call` | `tool_result` | `task_state` | `important_fact` | `summary`), `content`, `importance` (`critical` | `high` | `normal` | `low`), `createdAt`, `tokenEstimate`, `source` (optional: `toolName`, `filePath`, `command`), `removable`.
- FR-23: A `ContextState` type exists tracking: `items: ContextItem[]`, `maxContextTokens`, `reservedOutputTokens`, `estimatedInputTokens`, `compactionCount`, `truncatedItemCount`.
- FR-24: A `TokenEstimator` interface exists with `estimate(text: string): number`. The first implementation uses `Math.ceil(text.length / 4)` (characters-per-4 approximation). It is deterministic, fast, and provider-independent. The core Context Manager never depends on a Gemini tokenizer.
- FR-25: A context budget is configurable via environment variables without code changes: `MAX_CONTEXT_TOKENS` (default 32000), `RESERVED_OUTPUT_TOKENS` (default 4096), `MAX_TOOL_OUTPUT_TOKENS` (default 4000), `MAX_FILE_READ_TOKENS` (default 6000), `COMPACTION_THRESHOLD` (default 0.80). A `ContextPolicy` interface centralizes all these values; hardcoded numbers scattered across multiple files are not acceptable.
- FR-26: A `Truncator` interface exists with `truncate(item: ContextItem, maxTokens: number): ContextItem`. Truncated items preserve an explicit marker (`[result truncated]`), and metadata: `truncated: true`, `originalTokenEstimate`, `finalTokenEstimate`. Truncation strategies are type-specific: file content prefers requested line range + surroundings over first-N; search results prefer highest-relevance; command output prefers error lines + tail. Content is never silently discarded.
- FR-27: A priority system (`CRITICAL` > `HIGH` > `NORMAL` > `LOW`) is implemented as a policy module. Priority examples: CRITICAL = user task, current failing test, important constraints; HIGH = relevant source file, recent code change; NORMAL = recent search result, normal command output; LOW = repeated searches, old intermediate output.
- FR-28: A `ContextBuilder` interface exists with `build(input: BuildContextInput): BuildContextResult`. It selects context items by applying: always include CRITICAL → include HIGH → add recent NORMAL → add LOW only if budget remains → if budget exceeded: truncate oversized → remove LOW → remove older NORMAL → compact if still over. Context ordering: system instructions → current user task → task state/important facts → relevant recent tool results → recent assistant/tool interaction → older useful context → summaries. Selection policy is centralized in `policies.ts`, not scattered through the Agent Loop.
- FR-29: Simple duplicate detection: when a tool result is added whose normalized content hash matches an already-included item, the duplicate is not re-sent. No semantic similarity or embeddings.
- FR-30: A deterministic `Compactor` replaces older detailed interaction history with a structured summary preserving: original user goal, current status, modified files, important discovered facts, constraints, failed approaches, successful approaches, current errors, verification results. Items that may be removed: repeated searches, verbose command output, intermediate reasoning, redundant tool results. LLM-based summarization is not implemented in Iteration 2.
- FR-31: Compaction triggers when context utilization reaches `COMPACTION_THRESHOLD` (default 80%). The escalation is: utilization < threshold → continue normally; ≥ threshold → try truncation/removal; still ≥ threshold → compact older context (everything before the most recent 8 interaction turns); still too large → apply stronger reduction; still impossible → fail safely with message "Unable to fit required context within configured context budget."
- FR-32: A `CompactionEvent` type records: `timestamp`, `itemsBefore`, `itemsAfter`, `estimatedTokensBefore`, `estimatedTokensAfter`, `itemsRemoved`, `summaryCreated`.
- FR-33: The Agent Loop is refactored to use `ContextManager.build(agentState)` instead of direct message accumulation. The pattern changes from `messages.push(toolResult); llm.generate(messages)` to `agentState.addContext(toolResult); context = contextManager.build(agentState); llm.generate(context.messages)`. Context logic is not embedded throughout the Agent Loop.
- FR-34: An `ImportantFact` store exists per task run (not persistent): `{ id, content, importance: 'critical'|'high'|'normal', source? }`. The Agent Loop can record important facts that the Context Manager will always preserve.
- FR-35: A `ContextStats` structure exists in agent state: `{ totalItems, estimatedTokens, utilization, truncations, compactions, droppedItems }`. Agent state also tracks: `importantFacts`, `modifiedFiles`, `executedCommands`, `testResults`, `currentTaskStatus`.
- FR-36: The provider interface exposes a `ModelCapabilities` interface: `{ contextWindowTokens: number; maxOutputTokens?: number }`. The Gemini and Claude adapters supply their model's capabilities. The Context Manager reads these values; it does not hardcode provider-specific limits.
- FR-37: Every LLM request logs a `context_metrics` event containing: `iteration`, `estimatedInputTokens`, `contextItems`, `contextBudget`, `utilization`, `truncatedItems`, `droppedItems`, `compactions`.
- FR-38: Six new structured log events are emitted by the Context Manager: `context_build_started`, `context_build_completed`, `context_item_truncated`, `context_item_dropped`, `context_compaction_started`, `context_compaction_completed`.
- FR-39: A `--debug-context` CLI flag enables a human-readable context summary before each LLM request showing: items count, estimated tokens, budget, utilization, compaction status, and dropped items. This flag is opt-in; normal operation is unchanged.
- FR-40: The README is updated with: context management explanation, `--debug-context` documentation, and all context-related env/config options.
- FR-41: At the end of Iteration 2, a short engineering note is produced in `eval/iteration2/engineering-note.md` answering the 9 questions in §66 of `coding-agent-harness-ietration2.md`.

### Updated/extended functional requirements (Iteration 2 changes to Iteration 1)

- **FR-12** (extended): The Agent Loop is extended as described in FR-33. All existing external behavior (AgentResult shape, log events, CLI commands) is preserved. The refactor is internal only.
- **FR-19** (extended): The existing log events remain. FR-38 adds six new context-management events.

### New non-functional requirements (Iteration 2)

- NFR-9: The `src/context/` modules contain zero imports of any provider SDK — verifiable by the same static check used for NFR-1.
- NFR-10: Token estimation is deterministic: `estimate(t)` always returns the same number for the same input, and `estimate(longer) >= estimate(shorter)` when `longer` strictly contains `shorter`.
- NFR-11: The Context Manager never allows a context to grow indefinitely. When the budget cannot be satisfied even after compaction, it fails safely with a clear error message rather than crashing or silently dropping CRITICAL items.
- NFR-12: CRITICAL-priority items (user task, current constraints, current failing test) must survive compaction unless the budget is physically impossible to satisfy.
- NFR-13: All 43 Iteration 1 tests must continue to pass after the Iteration 2 agent loop integration.

### New acceptance criteria (Iteration 2)

- AC-14: `tokenEstimator.estimate("")` returns 0; `estimate("hello")` < `estimate("hello world this is a longer sentence")`; same input always returns same number.
- AC-15: Truncating an item above its `maxTokens` limit produces an item where `content` contains `[result truncated]`, `truncated === true`, and `originalTokenEstimate > finalTokenEstimate`.
- AC-16: Given 20 context items with varying priorities and a forced small budget, CRITICAL items are always present in the built context, LOW items are dropped first, and HIGH items are preferred over NORMAL when budget forces a choice.
- AC-17: After a compaction event, the built context contains: the original user task, any recorded important facts (importance=critical or high), and the most recent interaction turns. Items that were compacted away do not appear as full items.
- AC-18: When a context cannot fit within the budget even after compaction, the agent returns `status: "failed"` with a message containing "Unable to fit required context within configured context budget" rather than crashing.
- AC-19: For every LLM request in a full agent run, the structured log contains a `context_metrics` event with `estimatedInputTokens`, `utilization`, and `contextItems`.
- AC-20: Running `engineering-agent --debug-context "Fix the failing test"` prints a context summary (items, tokens, budget, utilization) before each LLM call; running without `--debug-context` produces no additional output compared to Iteration 1.
- AC-21: All Iteration 1 acceptance criteria (AC-1 through AC-13) still pass after Iteration 2 integration.
- AC-22: `eval/iteration2/engineering-note.md` exists and answers all 9 questions from §66 of `coding-agent-harness-ietration2.md`.

### Conflicts with existing specification

1. **IMPLEMENTATION_PROGRESS.md** (§62 of iteration2.md): Resolved by Decision DECISION-0bdf962d. Genesis is the source of truth; the hand-maintained progress file is not adopted.
2. **LLM-based compaction** (§23 Option B): Explicitly deferred per Decision DECISION-8948c5e9. Deterministic only in Iteration 2.
3. **Evaluation task blocking**: Resolved by Assumption ASSUMPTION-c52062ad. Live evaluation is best-effort and analyzed, not a blocking gate in the plan.

### Iteration 2 open questions

- Should `ModelCapabilities` be added to the existing `LLMProvider` interface or as a separate `getCapabilities(): ModelCapabilities` method? (Decision deferred to implementation time for IMPL-IT2-5; must be recorded via `genesis record decision` at that point.)
- What exact "substantially identical" threshold should duplicate detection use — exact string hash or normalized whitespace hash? (Implementation-time decision per FR-29, consistent with how Iteration 1 treated FR-15's similar question.)

## Iteration 3 — Repository Navigation & Information Discovery

### Iteration 3 objective

Iterations 1 and 2 give the agent a loop, four tools and a Context Manager, but its only navigation aids are a naive text `search` and a whole-file `read_file`. Iteration 3 is a **repository navigation experiment**: given a coding task whose implementation location is unknown, can the agent discover the relevant files, code, symbols and tests without reading the whole repository? Scope: repository scope/ignore handling, directory listing, unified search, focused reads, test discovery, Tree-sitter symbol discovery (TypeScript/JavaScript and Python) with a text-search fallback, task-local navigation state, bounded results, metrics, Context Manager integration, and a real-model evaluation across four repository types. Source: `coding-agent-harness-iteration3.md` (sections 1–44).

**Explicitly not in Iteration 3**: RAG, embeddings, vector databases, similarity or semantic search, persistent repository or long-term memory, repository knowledge graphs, autonomous or background indexing, LSP clients, compiler/type-checker integration, semantic reference resolution, universal AST/code intelligence, sub-agents, model routing or switching, MCP, IDE integration, plugin marketplaces, and any agent-invocable Git operation.

### New functional requirements (Iteration 3)

- FR-42: A `RepositoryScope` module (`src/navigation/scope.ts`) decides which workspace content navigation tools may inspect. Default exclusions: `.git/`, `node_modules/`, `dist/`, `build/`, `coverage/`, `.cache/`, `.tmp/`, `temp/`; the list is configurable via an environment variable. `vendor/` is not excluded by default.
- FR-43: When the workspace is a Git repository, scope honors `.gitignore` by calling read-only `git check-ignore` internally (never exposed to the model). When it is not a Git repository, or `git` is unavailable, only the default exclusions apply. No custom ignore-pattern engine is written.
- FR-44: Obvious binary files (NUL byte in the first 8 KB) are never returned to the model: search and symbol discovery skip them, and `read_file` returns exactly `binary file - content not displayed`.
- FR-45: `*.min.js`, `*.min.css` and the default generated-output directories are excluded from search, listing and symbol discovery. No further generated-code detection is attempted.
- FR-46: A `list_directory` tool (`path?`, `depth?`, `includeHidden?`) returns entries `{ path, type: "file" | "directory" }` for the workspace, respecting scope, in deterministic order, with a bounded depth and a bounded entry count; excess is reported with an explicit truncation notice, never an unbounded dump.
- FR-47: The existing `search` tool becomes the single unified search: it keeps every existing parameter and adds `mode: "content" | "filename" | "both"` (default `content`). It uses an `rg` executable when one is available and a built-in bounded scan otherwise, with identical results format, scope rules, workspace boundary, result limit and output limit. No separate model-facing `grep`/`find`/`rg` tools.
- FR-48: `read_file` keeps its current parameters and adds `contextLines`. Ranged reads read only the needed lines (a huge file is not loaded whole), output carries line numbers, an out-of-range or inverted range returns a clear error, and truncation carries an explicit marker. Search, `find_symbol` and `list_directory` output paths and line numbers can be passed directly to `read_file`.
- FR-49: A `find_tests` tool returns likely test files by convention: `*.test.ts|js`, `*.spec.ts|js`, `tests/`, `test/`, `__tests__/`, and for Python `test_*.py`, `*_test.py`, `tests/`; other languages use filename/directory heuristics. No test-framework detection.
- FR-50: `src/navigation/symbols/` contains `types.ts` (`SymbolProvider`, `SymbolQuery`, `SymbolMatch`, `SymbolKind` = class | function | method | interface | type | variable | constant | module | unknown), `registry.ts` (`registerSymbolProvider`, `getProviderForExtension`; unsupported extension returns no provider; duplicate registration of an extension is rejected) and `locator.ts`.
- FR-51: `src/navigation/symbols/tree-sitter.ts` parses a source file with the Node Tree-sitter ecosystem (no Python), choosing the grammar from the file extension. A missing grammar, a load failure or a parse failure degrades to the text fallback and never crashes the agent.
- FR-52: A TypeScript/JavaScript provider (`.ts`, `.tsx`, `.js`, `.jsx`) extracts functions, classes, methods, interfaces, type aliases, variables/constants where straightforward, and exported/default-exported declarations, each with name, kind, start/end line and optional signature/docstring. Symbol-like text in comments or strings is not a declaration.
- FR-53: A Python provider (`.py`) extracts functions, classes, methods, nested declarations and module-level definitions with the same fields. No runtime resolution or type inference.
- FR-54: A `find_symbol` tool (`symbol_name`, `path?`) selects candidate files within scope, parses those with a registered provider, returns structured `SymbolMatch` results, and falls back to word-matched text search for unsupported languages or when structural lookup finds nothing. Match `source` is `tree-sitter`, `text-search` or `tree-sitter+text-search`; text matches are never presented as declarations. The model never needs to call `search` itself for this fallback.
- FR-55: `npm run add-language <name>` validates the name, creates the provider file, a fixture and a test, registers the provider, runs the TypeScript build and the new tests, and prints remaining TODOs. It scaffolds only; it does not invent language semantics, refuses an existing or invalid name, and requires no change to the Agent Loop, Context Manager, LLM provider, CLI core or existing navigation tools.
- FR-56: Task-local `NavigationState` (repository root, explored directories, discovered files, symbols, references, tests, search records) lives in agent state, is reset for every task, and is never persisted.
- FR-57: Repeated navigation is never hard-blocked. Repeats are recorded for metrics and logged (`navigation_duplicate_detected`). The existing repeated-failed-action protection (FR-15) and iteration limit (FR-14) still apply unchanged.
- FR-58: Every navigation result reaches the model only through the existing Context Manager. The navigation layer applies only a raw safety ceiling and creates no second token budget. The Context Manager gains type-specific truncation and priority handling for `list_directory`, `find_symbol` and `find_tests` results. Compaction and truncation keep each tool call and its result together, verified for the sequences search→result, read→result, find_symbol→result, edit→result and test→result.
- FR-59: The system prompt (FR-20) describes the navigation tools and when each is useful, and does not prescribe a fixed navigation sequence.
- FR-60: `--debug-navigation` prints repository-scope exclusions, each navigation call with arguments, and a results summary (relevant files, truncations) without dumping raw outputs. Without the flag, CLI output is unchanged.
- FR-61: Structured log events `repository_scan_started`, `repository_scan_completed`, `directory_listed`, `search_started`, `search_completed`, `symbol_search_started`, `symbol_search_completed`, `test_discovery_started`, `test_discovery_completed`, `navigation_duplicate_detected`, `navigation_scope_filtered`, `navigation_result_truncated` are emitted with task ID, timestamp, iteration, operation, path where relevant, duration, result count, output size and Tree-sitter-vs-fallback. API keys and secrets are never logged.
- FR-62: Per-task navigation metrics are produced: navigation tool calls by type, files discovered, files read, repeated searches, Tree-sitter vs fallback symbol searches, symbol matches. Relevance-dependent metrics (relevant/irrelevant files read, time and tool calls before first relevant file) are computed by the evaluation harness from the ground-truth manifest, never inferred from agent behavior.
- FR-63: Evaluation fixtures exist for four repository types: A TypeScript/JavaScript, B Python, C static HTML/CSS/JS site, D noisy repository (irrelevant files, ignored directories, generated and minified files, repeated identifiers, distractors), plus an unsupported-language task. Each evaluation task has a JSON ground-truth manifest (`task`, `relevant_files`, `acceptable_files`, `verification.command`). Task wording describes behavior and never names the implementation location. The six required tasks are: unknown-location bug, cross-file behavior, symbol discovery, static site, noisy repository, unsupported language.
- FR-64: An evaluation harness runs each task against the Iteration 2 baseline (original tools from the snapshot) and Iteration 3, five runs each, records success, navigation, efficiency and symbol metrics per run, and independently verifies each outcome by running the manifest's verification command outside the agent. Real-provider execution requires the human authorization described in DECISION-8791b3de.
- FR-65: Every evaluation failure is classified with the section 34 taxonomy (first incorrect action, what should have happened, cause category, smallest fix). An Iteration 2 vs Iteration 3 comparison and an engineering note answering the 14 questions of section 42 are written to `eval/iteration3/`. The README documents the navigation tools, `--debug-navigation` and `add-language`.
- FR-66: Before any evaluation, a baseline report in `eval/iteration3/` records: all Iteration 1 and 2 tests passing, the known Iteration 2 context/compaction defects as fixed or explicitly documented, a copy of the Iteration 2 source for the baseline runs, and the open items inherited from earlier iterations.

### Updated/extended requirements (Iteration 3 changes to earlier iterations)

- **FR-8** (extended): `search` gains `mode`, scope filtering, deterministic ordering and an `rg`-or-built-in implementation as FR-47; existing parameters and the "No results found." / truncation behavior are preserved.
- **FR-9** (extended): `read_file` gains `contextLines`, line-numbered output and binary handling as FR-48; whole-file and `startLine`/`endLine` behavior is preserved.
- **FR-17** (extended): workspace confinement for navigation tools also rejects symlinks that resolve outside the workspace (NFR-15).
- **FR-19** (extended): FR-61 adds twelve navigation log events.
- **FR-20** (extended): FR-59.
- **FR-26/FR-27** (extended): FR-58 adds truncation and priority rules for the new tools.

### New non-functional requirements (Iteration 3)

- NFR-14: `src/navigation/` contains no import of any LLM provider SDK, verifiable by the static check used for NFR-1 and NFR-9.
- NFR-15: Every navigation tool resolves real paths and rejects any path, including via symlink, that lies outside the workspace root.
- NFR-16: Every navigation tool has a raw safety ceiling (entries, matches, bytes) and deterministic ordering for identical repository state.
- NFR-17: New runtime dependencies are limited to the Tree-sitter runtime and its grammar bundle, version-pinned; no database, persistent index, background process or Python runtime is introduced.
- NFR-18: A missing `rg`, missing `git`, absent grammar or unparsable file degrades to a documented fallback with a correct result format, never a crash or silent empty result.
- NFR-19: All 100 existing tests, all Iteration 1 acceptance criteria (AC-1 to AC-13) and all Iteration 2 acceptance criteria (AC-14 to AC-22) still pass after every task.
- NFR-20: The navigation system is small enough to understand end to end: the README includes a module map, and each module has a single stated responsibility.

### New acceptance criteria (Iteration 3)

- AC-23: In a Git workspace, a path matched by `.gitignore`, `node_modules/`, `dist/` or a `*.min.js` file never appears in `list_directory`, `search` or `find_symbol` output; in a non-Git workspace the default exclusions still apply; a binary file is skipped by search and `read_file` returns `binary file - content not displayed`.
- AC-24: `list_directory` on a fixture returns identical ordered output on repeated calls, honors `depth` and `includeHidden`, truncates with a notice beyond the entry ceiling, and returns an error for a nonexistent directory and for `../` or symlink escape.
- AC-25: `search` in `content`, `filename` and `both` modes returns correct results for a fixture, honors `path`, `filePattern` and `maxResults`, reports no-match cleanly, produces the same result set with and without an `rg` executable, and all pre-existing search tests still pass.
- AC-26: `read_file` with `startLine`/`endLine`/`contextLines` returns exactly the requested numbered lines, errors on an invalid range or missing file, never loads a multi-megabyte file whole for a small range (verified by a bounded-read test), and all pre-existing read_file tests still pass.
- AC-27: `find_tests` returns the expected test files for TypeScript, JavaScript and Python fixtures and nothing outside the conventions.
- AC-28: The registry returns the right provider per extension, none for an unsupported one, and rejects duplicate registration.
- AC-29: The TypeScript/JavaScript provider returns correct name, kind and line range for function, class, method, interface, type alias, variable and exported declarations in a fixture, and ignores declaration-like text in comments.
- AC-30: The Python provider returns correct name, kind and line range for function, class, method and nested declarations in a fixture, and ignores declaration-like text in comments.
- AC-31: `find_symbol` returns a `tree-sitter` match for a supported language, a `text-search` match for an unsupported language, `tree-sitter+text-search` when both contribute, a clear not-found result, multiple matches, and honors `path`; it still returns text matches when the grammar fails to load.
- AC-32: `npm run add-language <name>` on a clean copy of the repository creates the provider, fixture and test files, registers the provider, passes `tsc` and the new test, reports TODOs, and a static check shows no file in `src/agent/`, `src/context/`, `src/providers/`, `src/cli/` or existing navigation tools was modified by it; invalid or duplicate names are refused.
- AC-33: `NavigationState` records discovered files, symbols, tests and searches, records a repeated search without blocking it, and is empty at the start of each new task.
- AC-34: A long scripted run forcing compaction over search, read_file, find_symbol, edit_file and run_command calls produces provider-valid messages: every tool result directly follows its tool call with matching ids (INVARIANT-64d38bc1), and no navigation output reaches the provider except via the Context Manager.
- AC-35: With `--debug-navigation` the CLI prints scope exclusions, each navigation call and a bounded summary; without it the output is byte-identical to Iteration 2; the twelve navigation log events appear with the required fields and no secrets.
- AC-36: A mocked-LLM integration test on a multi-file fixture solves an unknown-location task with search, find_symbol, ranged read_file, edit and test, using a sequence different from the one in the requirements document, and the final repository state and verification command pass.
- AC-37: Fixtures A–D and the unsupported-language fixture, six task descriptions and their JSON manifests exist; a static check confirms no task description contains a relevant file path or the target symbol name.
- AC-38: The evaluation harness, given recorded run logs, computes the section 33 metrics, relevant/irrelevant files read and time to first relevant file from the manifest, and its independent verifier fails a run whose verification command fails regardless of the agent's own claim.
- AC-39: With human authorization, at least one real-provider run exercising compaction completes with valid message pairing, and 5 baseline plus 5 Iteration 3 runs per important task are recorded with classified failures, the comparison and the engineering note answering the 14 questions (FR-65).
- AC-40: A baseline report exists in `eval/iteration3/` satisfying FR-66 before any Iteration 3 evaluation run is recorded.

### Conflicts with existing specification and approvals

1. **IMPLEMENTATION_PROGRESS.md** (section 38; also Phase 1 step 2): not adopted; resolved by DECISION-3db50846 following DECISION-0bdf962d.
2. **Not a Git repository**: section 5.1 assumes Git; resolved by ASSUMPTION-cddae5fb (git used only when present).
3. **No `rg` binary** on this machine: sections 7 and 17 assume `rg`; resolved by ASSUMPTION-76abab08.
4. **`SymbolMatch.source` union** inconsistent between sections 12 and 17: DECISION-89eb4ff3.
5. **YAML manifests** vs no YAML parser: DECISION-3d4dd6d1.
6. **Run Command allowlist** (DECISION-c0d3e4f4, still awaiting human review) already permits `find`, `grep`, `cat`, `python`, `npx`, overlapping the new tools. Iteration 3 does not change it; the review is an inherited open item (FR-66) and the system prompt (FR-59) directs the model to the navigation tools.
7. **Section 3 prerequisite "run all Iteration 1 and 2 tests"**: the suite is now 100 tests (not the 43 of NFR-13); NFR-19 uses the current count.
8. **Paid evaluation** (sections 23, 31, 32): see DECISION-8791b3de; implementation tasks never call a paid provider.
9. **Parameter naming**: `symbol_name` is snake_case unlike other tools; kept as specified (DECISION-c9dfd5cb).
10. **Section 36 flag** is `--debug-navigation` on the existing `engineering-agent` binary, consistent with `--debug-context`.

### Iteration 3 open questions

- Confirm the Tree-sitter choice (web-tree-sitter + tree-sitter-wasms, DECISION-8e437c98). Default if unanswered: proceed with the spike gate in the first symbol task.
- Which provider/model and what run/cost cap should the real-provider evaluation use (Gemini per the requirements, or Claude, which Iteration 2 evaluation actually ran)? Default if unanswered: IMPL-IT3-18 and IMPL-IT3-19 stay blocked.
- Should `git init` be performed on this repository by the developer? Not required by this plan; tests create temporary Git repositories.
- Does `read_file` always number lines (assumed) or only on ranged reads? Always numbering risks the model copying prefixes into `edit_file`; AC-36 and the Iteration 1 calculator flow guard this.

---

---

## Provenance index

All Iteration 1 functional/non-functional requirements are derived from `coding-agent-harness-implementation-iteration1.md` (sections 1–34), cross-checked against the architectural intent in `coding-agent-harness-design-document.md` (sections 1–20). Where the two documents overlap, the Iteration 1 document's more specific detail takes precedence, consistent with the design document's own framing of itself as the long-term intent and the Iteration 1 document as the current implementation scope. Human interview answers (2026-09-27) resolved every point the documents left ambiguous or delegated to the implementer; each is recorded individually via `genesis record decision` with a `--source` tag of the form "human answer, interview round N, QM (2026-09-27)". Full record IDs are retrievable via `genesis context . --id <ID>`.

All Iteration 2 functional/non-functional requirements are derived from `coding-agent-harness-ietration2.md` (sections 1–69). Conflicts and ambiguities are resolved through Genesis records (DECISION-0bdf962d, DECISION-0fa985d8, DECISION-8948c5e9, ASSUMPTION-c52062ad, ASSUMPTION-ddc5c4fa). No implementation code is written until this specification is approved.

All Iteration 3 functional/non-functional requirements are derived from `coding-agent-harness-iteration3.md` (sections 1–44). Conflicts and ambiguities are resolved through Genesis records (ASSUMPTION-656f78ee, ASSUMPTION-cddae5fb, ASSUMPTION-76abab08, DECISION-8e437c98, DECISION-7baf4685, DECISION-89eb4ff3, DECISION-3d4dd6d1, DECISION-3db50846, DECISION-8791b3de, DECISION-c9dfd5cb, KNOWLEDGE-ce06a8eb). No Iteration 3 implementation code is written until this specification is approved.
