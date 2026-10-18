# mini-coding-agent

A small, provider-agnostic **engineering agent** for the command line. Give it a task in plain English
("fix the failing test in `src/calculator.ts`") and it searches the codebase, reads and edits files, and runs
allowlisted commands such as `npm test` until the task is done or its iteration budget runs out. It works with
Claude (Anthropic) or Gemini (Google) behind one interface.

## What it does

- **Agent loop**: the model picks a tool, the harness runs it, and the result goes back to the model, repeated up to `--max-iterations`.
- **Tools**: `search`, `read_file`, `edit_file`, `run_command`, plus repository navigation (`list_directory`, `find_symbol`, `find_tests`).
- **Context management**: token estimation, per-tool output truncation and compaction keep long tasks inside the model's window.
- **Navigation**: tree-sitter parses JavaScript/TypeScript and Python declarations; other languages fall back to text search.
- **Evaluation harness**: `eval/` compares iterations on fixture tasks, judged by running each task's verification command.

It was built incrementally in three iterations; the design lives in `SPEC.md` and the `coding-agent-harness-*.md` documents.

## How it works

```
CLI (src/cli) -> agent loop (src/agent) -> provider adapter (src/providers: claude | gemini)
                      |                              ^
                      v                              |
              tool registry (src/tools, src/navigation)      context manager (src/context) builds each prompt
```

Each turn the context manager assembles the message list within budget, the provider returns text or a tool call,
the registry executes the call inside the workspace, and the result is recorded. Details are in the sections below.

## Setup

Requirements: Node.js 18+ and an API key for at least one provider. `ripgrep` is optional (faster search).

```bash
git clone <this-repo-url> && cd mini-coding-agent
npm install
cp .env.example .env     # then edit .env and add your key(s)
npm run build
npm test
```

Use `AGENT_PROVIDER=claude` with `ANTHROPIC_API_KEY`, or `AGENT_PROVIDER=gemini` with `GEMINI_API_KEY`.

## Usage

```bash
npx tsx src/cli/index.ts "Fix the failing test" --workspace ./path/to/project --provider claude
```

Full options are under [CLI options](#cli-options). Start with a small `--max-iterations` and a throwaway workspace.

## Security and safety

This tool lets an LLM modify files and run commands on your machine. Treat it accordingly.

- **Run it only on workspaces you can afford to lose** (a git checkout or a copy). Review the diff afterwards.
- File tools are confined to `--workspace`; paths outside it are rejected.
- `run_command` uses no shell and is allowlisted, but the allowlist includes `python`, `node`, `npx` and `npm run`,
  which can execute arbitrary code from the workspace. **Do not point the agent at untrusted repositories**
  (prompt injection in files it reads can steer it), and use a container or VM if in doubt.
- API keys are read from environment variables or `.env`. `.env` is git-ignored: never commit it.
  If a key is ever exposed, revoke it at the provider immediately.
- Real-provider evaluation runs cost money; the eval runner requires `--max-runs` and `--max-cost-usd`.
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## CLI options

```
engineering-agent "<task>" [options]

  --workspace, -w <path>   Root directory the agent may read/write (default: cwd)
  --provider, -p <name>    LLM provider: gemini | claude (default: $AGENT_PROVIDER)
  --model, -m <model>      Override the provider's default model
  --max-iterations <n>     Stop after n LLM calls (default: 20)
  --debug-context          Print a context summary line before each LLM call
  --debug-navigation       Print each navigation call, repeats, truncations and a summary
```

### --debug-context

When set, prints a one-line summary before each LLM call showing the current
context state:

```
  [context] items=12 tokens=3241 util=45.3% truncated=2 dropped=5 compactions=1
```

Fields:
- `items` — number of messages sent to the provider this call
- `tokens` — estimated input token count
- `util` — percentage of the usable context window consumed
- `truncated` — number of items that have been truncated since the task started
- `dropped` — number of items dropped by compaction since the task started
- `compactions` — number of compaction events since the task started

## Repository navigation

Besides `search`, `read_file`, `edit_file` and `run_command`, the agent has three navigation tools. None is required
before the others; the agent chooses. Every call is recorded, and repeats are recorded but never blocked.

| Tool | Input | Returns |
|---|---|---|
| `list_directory` | `path` (default `.`), `depth` (1 to 5, default 1), `includeHidden` | Files and directories; directories end with `/`. Skips ignored, generated and hidden entries. |
| `find_symbol` | `symbol_name` (exact, case-sensitive), `path` (optional) | Where it is defined, as `path:start-end kind name [source]`. `tree-sitter` means a parsed declaration; `text-search` means a whole-word text match that is **not** a confirmed declaration. |
| `find_tests` | `path` (default `.`) | Likely test files by naming convention only (`*.test.ts`, `test_*.py`, files under `tests/`, ...). No test framework is detected. |

**Scope.** All three skip `.git`, `node_modules`, `dist`, `build`, `coverage`, `.cache`, `.tmp`, `temp`, files ignored by git,
minified files and binaries. `vendor/` is deliberately not excluded because its meaning differs by ecosystem. Paths outside
the workspace are rejected. `rg` is used for line matching when it is on `PATH`; otherwise a built-in scan runs.

**Languages.** Symbol parsing covers JavaScript/TypeScript and Python. Other languages, or a parse that finds nothing,
fall back to text search and say so in the `source` field.

### --debug-navigation

Prints navigation events as the task runs, never raw output:

```
  [nav] scope <exclusions>
  [nav] <operation> <detail> → <n> lines (<tree-sitter|fallback>)
  [nav] repeat #2: <tool> <detail>
  [nav] <operation> output truncated at its ceiling
  [nav] summary: calls search=2 find_symbol=1; files discovered=.. read=..; repeats=0; symbol matches=3 (tree-sitter 2, fallback 1); truncated outputs=0
```

### add-language

```bash
npm run add-language <name> [.ext]     # e.g. npm run add-language java
```

Scaffolds a symbol provider; it does not implement language semantics. It creates
`src/navigation/symbols/languages/<name>.ts`, a fixture under `tests/fixtures/symbols/<name>/`, a test with `it.todo` cases,
and registers the provider in `src/navigation/symbols/languages/index.ts` (created on first use, exporting
`registerAllLanguages()`). It then runs `tsc --noEmit` and the new test, and prints the remaining TODOs: add the grammar to
`GRAMMAR_BY_EXT` in `tree-sitter.ts`, write real fixture content, implement `findSymbols`, and replace the todo tests.

**Known gap:** the CLI registers the JavaScript/TypeScript and Python providers directly and does not call
`registerAllLanguages()`, so a language added this way is not active in the CLI until that call is made at startup.

### Navigation module map

```
src/navigation/
  index.ts          registerNavigationTools(): registers the three tools and records every call
  scope.ts          repository scope: excluded directories, git ignore, workspace confinement
  list-directory.ts list_directory
  find-symbol.ts    find_symbol (parsed declarations, text-search fallback)
  find-tests.ts     find_tests (naming convention)
  rg.ts             optional ripgrep line matching; null on failure so callers fall back to the built-in scan
  state.ts          per-task record of calls, files discovered and read, repeats
  metrics.ts        counts derived from state (feeds the --debug-navigation summary)
  symbols/
    registry.ts     extension -> provider lookup
    locator.ts      finds symbol declarations in a file through a provider
    tree-sitter.ts  grammar loading (GRAMMAR_BY_EXT)
    types.ts        provider interface
    languages/      javascript-typescript.ts, python.ts (+ index.ts once add-language has run)
```

### Evaluating navigation

```bash
npx tsx eval/iteration3/run.ts --provider claude --model claude-haiku-5-5 --max-runs 60 --max-cost-usd 1
npx tsx eval/iteration3/check-results.ts --min-runs 5
```

Runs each fixture task against the frozen Iteration 2 source and the current source. A real provider costs money:
the runner refuses to start without `--max-runs` and `--max-cost-usd`, meters the provider's reported usage, and keeps
`eval/iteration3/results/ledger.json` so repeated invocations share one budget. Only `--provider claude` can be metered.
Success is decided by running the task's verification command, not by the agent's own report. Results and write-ups:
`eval/iteration3/comparison.md`, `failure-analysis.md`, `engineering-note.md`.

## Context management

Iteration 2 introduced a `ContextManager` that sits between the agent loop
and the LLM provider. Its job: keep the message set within the configured
token budget across long tasks without losing critical information.

### How it works

1. **Token estimation** — every message is estimated using a character-count
   heuristic (`chars / 4`). Estimates are advisory; actual provider counts vary.

2. **Per-item truncation** — when a tool result is added, its token estimate
   is compared against a per-tool-type cap. Results that exceed the cap are
   truncated immediately with a `[truncated]` marker. Caps (all configurable):

   | Tool | Env var | Default |
   |---|---|---|
   | `read_file` | `MAX_FILE_READ_TOKENS` | 6000 |
   | `search` | `MAX_SEARCH_RESULT_TOKENS` | 2000 |
   | `run_command` | `MAX_COMMAND_OUTPUT_TOKENS` | 4000 |
   | (other) | `MAX_TOOL_OUTPUT_TOKENS` | 4000 |

3. **Compaction** — when the total estimated input tokens cross
   `COMPACTION_THRESHOLD × (MAX_CONTEXT_TOKENS − RESERVED_OUTPUT_TOKENS)`,
   a compaction runs. It:
   - Always keeps: task description, important facts, non-removable items
   - Always keeps: the most recent `MAX_RECENT_ITEMS` turns
   - Replaces everything else with a structured summary (files accessed,
     commands run, recent test results, recent errors)

4. **Pair-safe ordering** — messages are always sent in strict chronological
   order. After compaction, any (assistant, tool_result) pair split across
   the compaction boundary is detected and dropped atomically to satisfy the
   provider constraint that every tool_use must be immediately followed by
   its tool_result.

### Context-related environment variables

All variables are optional. The defaults are tuned for providers with 32K+
context windows.

| Variable | Default | Description |
|---|---|---|
| `MAX_CONTEXT_TOKENS` | provider's window, else `32000` | Context window used to size compaction. Defaults to the provider's real window from `capabilities()` (200K for Claude); set this only to force a smaller one. |
| `RESERVED_OUTPUT_TOKENS` | `4096` | Tokens reserved for the model's response |
| `COMPACTION_THRESHOLD` | `0.80` | Fraction of usable tokens that triggers compaction |
| `MAX_FILE_READ_TOKENS` | `6000` | Per-item cap for read_file results |
| `MAX_SEARCH_RESULT_TOKENS` | `2000` | Per-item cap for search results |
| `MAX_COMMAND_OUTPUT_TOKENS` | `4000` | Per-item cap for run_command output |
| `MAX_TOOL_OUTPUT_TOKENS` | `4000` | Per-item cap for all other tool results |
| `MAX_RECENT_ITEMS` | `8` | Minimum recent turns kept through compaction |
| `ENABLE_COMPACTION` | `true` | Set to `false` to disable compaction |
| `ENABLE_DUPLICATE_REMOVAL` | `true` | Reserved for future duplicate detection |

## Structured log events

The agent emits structured log events via the `LogSink` callback. Events
relevant to context management:

| Event | When |
|---|---|
| `context_build_started` | Before building the message list for a provider call |
| `context_build_completed` | After building; carries `contextItems` count |
| `context_metrics` | After each build; carries full metrics (see below) |
| `context_item_truncated` | When an item is truncated on add |
| `context_compaction_started` | When compaction begins |
| `context_compaction_completed` | When compaction ends; carries `droppedItems` |
| `context_item_dropped` | Emitted alongside compaction_completed when items were removed |

`context_metrics` fields: `estimatedInputTokens`, `contextItems`, `utilization`,
`truncatedItems`, `droppedItems`, `compactions`.

## Providers

| Provider | Env var | Default model |
|---|---|---|
| `gemini` | `GEMINI_API_KEY` | `gemini-2.0-flash` |
| `claude` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` |

Override the model with `--model` or `GEMINI_MODEL` / `CLAUDE_MODEL`.

`CLAUDE_MAX_OUTPUT_TOKENS` (default `16384`) caps the model's response. Whole-file
writes are the main consumer; if the model is cut off mid-tool-call the adapter
fails fast with a clear error rather than passing truncated arguments to a tool.

Context window size is read from the provider's `capabilities()` method and
used to size the compaction budget. Override with `GEMINI_CONTEXT_WINDOW` or
`CLAUDE_CONTEXT_WINDOW` (tokens).

## Running tests

```bash
npm test              # unit + integration (330+ tests)
npx tsx eval/run_it2_eval.ts   # Iteration 2 evaluation (7 tasks, IT1 vs IT2)
```

## Project structure

```
src/
  agent/       loop.ts (agent loop), logger.ts
  cli/         index.ts (CLI entrypoint)
  context/     context-manager.ts, policies.ts, token-estimator.ts,
               truncator.ts, context-builder.ts, compactor.ts, types.ts
  providers/   claude/, gemini/
  navigation/  list-directory.ts, find-symbol.ts, find-tests.ts, scope.ts, symbols/ (see Repository navigation)
  tools/       search.ts, readfile.ts, editfile.ts, runcommand.ts, registry.ts
  types/       index.ts
tests/
  unit/context/    policies, token-estimator, truncator, context-builder,
                   compactor, context-manager, stress
  integration.test.ts
eval/
  run_it2_eval.ts              Iteration 2 evaluation runner
  iteration2/summary.json      Evaluation results
  iteration2/engineering-note.md  Learning deliverable (§66)
```

## License

MIT, see [LICENSE](LICENSE).
