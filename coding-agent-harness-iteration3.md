Below is the finalized Iteration 3 plan. I have intentionally kept the implementation small: **repository navigation + bounded discovery + Tree-sitter-based symbol discovery + `rg` fallback + tests/evaluation**. It does not introduce RAG, embeddings, databases, persistent memory, LSP, or semantic code intelligence.

# Engineering Agent — Iteration 3
## Repository Navigation & Information Discovery

---

## 1. Purpose

Iteration 3 improves the agent's ability to work in an unfamiliar repository.

The primary question is:

> Given a coding task where the agent does not know where the relevant implementation is, can it efficiently discover the relevant files, code, symbols, references, and tests without reading the entire repository?

Iteration 3 is a **repository navigation experiment**, not a general-purpose code intelligence platform.

The implementation must remain simple and understandable because this is a learning project.

---

# 2. Hard Scope Boundary

Iteration 3 WILL implement:

- repository structure discovery
- repository scope and ignore handling
- directory listing
- unified file/content search
- focused line-range file reading
- basic test discovery
- Tree-sitter-based symbol discovery
- language-specific symbol extractors
- `rg` fallback when structural symbol discovery is unavailable
- navigation state
- bounded navigation results
- navigation metrics
- integration with the existing Context Manager
- real-model navigation evaluation
- multiple evaluation runs
- independent verification
- a mechanism for adding another supported language easily

Iteration 3 WILL NOT implement:

- RAG
- embeddings
- vector databases
- similarity search
- semantic search
- persistent repository memory
- long-term agent memory
- repository knowledge graphs
- autonomous repository indexing
- LSP clients
- compiler/type-checker integration
- semantic reference resolution
- universal AST/code intelligence
- sub-agents
- model routing
- automatic model switching
- MCP
- IDE integration
- background indexing
- plugin marketplaces
- automatic Git operations

These are explicitly out of scope.

They may only be considered in a future iteration if Iteration 3 evaluation provides evidence that they are necessary.

---

# 3. Starting Point

Iteration 3 assumes Iterations 1 and 2 are working.

### Iteration 1 provides

- CLI
- Agent Loop
- LLM provider abstraction
- Gemini provider
- tool registry
- search
- read file
- edit/write
- run command
- safety controls
- logging
- task state
- verification
- evaluation framework

### Iteration 2 provides

- Context Manager
- token estimation
- context budgets
- truncation
- priority
- duplicate handling
- compaction
- context metrics

Before starting Iteration 3:

1. Read `IMPLEMENTATION_PROGRESS.md`.
2. Run all Iteration 1 tests.
3. Run all Iteration 2 tests.
4. Run representative real-provider tasks.
5. Confirm known Iteration 2 context/compaction bugs are either fixed or explicitly documented.

Do not start the Iteration 3 evaluation while a known context corruption bug can invalidate the results.

---

# 4. Target Architecture

```text
                         CLI
                          |
                          v
                    Agent Runtime
                          |
                          v
                     Agent Loop
                          |
             +------------+-------------+
             |                          |
             v                          v
      Navigation Layer            Context Manager
             |                          |
     +-------+-------+                  |
     |       |       |                  |
     v       v       v                  |
   List   Search   Read                 |
     |       |       |                  |
     +-------+-------+                  |
             |                          |
             v                          |
      Symbol Discovery                  |
             |                          |
       +-----+------+                   |
       |            |                   |
       v            v                   |
  Tree-sitter      rg                   |
  providers      fallback               |
       |            |                   |
       +-----+------+                   |
             |                          |
             +------------+-------------+
                          |
                          v
                     LLM Provider
```

The Agent Loop remains provider-independent.

The Context Manager remains responsible for the actual LLM context budget.

The Navigation Layer is responsible for discovering repository information.

---

# 5. Repository Scope

Before implementing navigation tools, implement a small `RepositoryScope`.

Its job is to decide what repository content navigation tools are allowed to inspect.

## 5.1 Respect `.gitignore`

Read `.gitignore` from the repository root.

Where practical, use Git's own ignore semantics rather than implementing a complete `.gitignore` parser ourselves.

A simple approach is to use:

```bash
git check-ignore
```

for paths when the repository is a Git repository.

For non-Git repositories, use a small default exclusion mechanism.

Do not build a sophisticated ignore engine.

## 5.2 Default exclusions

At minimum exclude:

```text
.git/
node_modules/
dist/
build/
coverage/
.cache/
.tmp/
temp/
```

The exact list can remain configurable.

Do not blindly exclude directories such as `vendor/` because their meaning differs by ecosystem. Prefer repository configuration or `.gitignore`.

## 5.3 Binary files

Navigation tools should avoid returning binary content.

Detect obvious binary files and return:

```text
binary file - content not displayed
```

rather than attempting to send binary data to the model.

## 5.4 Generated/minified files

Avoid unnecessarily searching:

```text
*.min.js
*.min.css
```

and obvious generated output directories.

Do not attempt sophisticated generated-code detection.

---

# 6. Navigation Tool Design

Keep the model-facing navigation API small.

## Core tools

### `list_directory`

Purpose:

> Understand repository structure.

Input:

```ts
interface ListDirectoryInput {
  path?: string;
  depth?: number;
  includeHidden?: boolean;
}
```

Output:

```ts
interface DirectoryEntry {
  path: string;
  type: "file" | "directory";
}
```

Requirements:

- workspace-safe
- respect RepositoryScope
- deterministic ordering
- bounded depth
- bounded result count
- do not recursively dump an entire large repository

---

# 7. Unified Search

Use one primary `search` tool rather than creating multiple overlapping model-facing tools.

It should support both:

- content search
- filename/path search

Example:

```ts
interface SearchInput {
  query: string;
  path?: string;
  filePattern?: string;
  mode?: "content" | "filename" | "both";
  maxResults?: number;
}
```

Examples:

```text
search "PaymentGateway"
search "process_order"
search "calculator" mode=filename
search "mobile-menu" path=src
```

Use `rg` where available because it is fast and handles repository search well.

The tool must still enforce:

- workspace boundaries
- RepositoryScope
- result limits
- output limits

Do not expose `grep`, `find`, or `rg` as separate model-facing navigation concepts.

---

# 8. Focused `read_file`

Update the existing `read_file` tool.

It MUST support:

```ts
interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  contextLines?: number;
}
```

Example:

```text
read_file(
  path="src/payment.py",
  startLine=10,
  endLine=40
)
```

This is important because navigation tools must produce results that can be consumed directly by `read_file`.

Requirements:

- workspace-safe
- file existence validation
- line-range support
- output safety ceiling
- clear line numbers
- useful truncation marker
- preserve encoding where practical
- do not read an entire huge file when only a small range is requested

---

# 9. Test Discovery

Implement a small `find_tests` capability.

It should identify likely tests using simple conventions:

```text
*.test.ts
*.spec.ts
*.test.js
*.spec.js
tests/
test/
__tests__/
```

For Python:

```text
test_*.py
*_test.py
tests/
```

For other languages, use filename/directory heuristics.

Do not build a universal test framework detector.

The purpose is simply:

> Help the agent find likely verification files.

---

# 10. Symbol Discovery

## 10.1 Principle

Symbol discovery is language-aware.

Do not implement symbols using a large collection of regular expressions.

Do not implement an LSP.

Use Tree-sitter to parse supported languages.

Tree-sitter provides the syntax tree.

Our code traverses the tree and extracts declarations we consider symbols.

---

# 11. Initial Language Support

Iteration 3 intentionally supports only:

### TypeScript / JavaScript

Extensions:

```text
.ts
.tsx
.js
.jsx
```

### Python

Extensions:

```text
.py
```

HTML and CSS remain fully usable through:

- directory discovery
- search
- focused reads
- test discovery where applicable

They are not required to have language-aware symbol extraction in Iteration 3.

All other languages use normal file/content search.

---

# 12. Symbol Provider Interface

Create:

```text
src/navigation/symbols/
```

Suggested structure:

```text
src/navigation/symbols/
├── types.ts
├── registry.ts
├── locator.ts
├── tree-sitter.ts
└── languages/
    ├── javascript-typescript.ts
    └── python.ts
```

Common interface:

```ts
interface SymbolProvider {
  language: string;
  extensions: string[];

  findSymbols(
    source: string,
    query: SymbolQuery
  ): SymbolMatch[];
}
```

Example:

```ts
interface SymbolQuery {
  name: string;
  kind?: SymbolKind;
}
```

Result:

```ts
interface SymbolMatch {
  name: string;
  kind: SymbolKind;
  path: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  source: "tree-sitter" | "text-search";
}
```

Keep `SymbolKind` small:

```ts
type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "constant"
  | "module"
  | "unknown";
```

Do not attempt to normalize every language-specific construct.

---

# 13. Tree-sitter Implementation

The agent is a TypeScript/Node.js application.

Do not introduce Python solely to run Tree-sitter.

Use the Node.js/TypeScript Tree-sitter ecosystem.

The implementation should:

1. determine language from file extension
2. select the registered Tree-sitter grammar
3. parse the source
4. traverse relevant syntax nodes
5. identify declaration nodes
6. extract symbol name
7. extract symbol kind
8. extract start/end line
9. optionally extract signature/docstring
10. return `SymbolMatch`

Tree-sitter itself is the parser.

The language-specific provider is responsible for deciding which syntax-tree nodes represent symbols.

---

# 14. Initial TypeScript/JavaScript Symbols

Support a practical subset:

- functions
- classes
- methods
- interfaces
- type aliases
- variables/constants where straightforward
- exported declarations

Handle:

```text
function foo()
class Foo
interface User
type UserId = ...
const calculate = ...
export function ...
export default ...
```

Do not attempt perfect semantic resolution.

---

# 15. Initial Python Symbols

Support:

- functions
- classes
- methods
- basic declarations where straightforward
- module-level definitions

Handle:

```text
def process_order()
class PaymentGateway
def method()
```

Do not attempt Python runtime resolution, dynamic dispatch analysis, or type inference.

---

# 16. `find_symbol` Tool

Expose one model-facing tool:

```text
find_symbol
```

Example:

```json
{
  "symbol_name": "process_order"
}
```

Optional:

```json
{
  "symbol_name": "PaymentGateway",
  "path": "src"
}
```

The tool:

1. determines candidate files
2. checks registered Tree-sitter provider
3. parses candidate source
4. searches the syntax tree
5. returns structured symbol matches
6. falls back to `rg` if structural lookup is unavailable or insufficient

The model should not need to separately invoke `rg` for this fallback.

---

# 17. `rg` Fallback

Fallback is required because:

- some languages are unsupported
- symbols can be dynamically assigned
- syntax-aware discovery is not always sufficient
- text may contain useful references that are not declarations

Fallback:

```text
rg -n --word-regexp "<symbol>"
```

subject to:

- RepositoryScope
- workspace boundaries
- result limits
- output limits

Return:

```ts
source: "text-search"
```

for fallback matches.

If both methods contribute useful results:

```ts
source: "tree-sitter+text-search"
```

Do not claim that text matches are declarations.

---

# 18. Adding a New Language

The architecture MUST allow a new language without modifying:

- Agent Loop
- Context Manager
- LLM Provider
- CLI core
- existing navigation tools

Create a scaffolding command:

```bash
npm run add-language java
```

The command should:

1. validate language name
2. determine/register the language
3. add the Tree-sitter grammar dependency if configured
4. create the language provider file
5. create a fixture
6. create a test file
7. update the symbol registry
8. run TypeScript compilation
9. run the new tests
10. report remaining TODOs

Example:

```text
src/navigation/symbols/languages/java.ts
tests/navigation/symbols/java.test.ts
tests/fixtures/symbols/java/Sample.java
```

The command creates scaffolding.

It does NOT magically implement language semantics.

The developer still implements the language-specific extraction rules.

This makes language extension easy without pretending that every language is automatically supported.

---

# 19. Symbol Registry

Create a registry:

```ts
registerSymbolProvider(provider);
```

Lookup:

```ts
getProviderForExtension(".py");
```

Example:

```text
.ts  -> TypeScript provider
.tsx -> TypeScript provider
.js  -> JavaScript provider
.jsx -> JavaScript provider
.py  -> Python provider
```

Unsupported extensions return no provider.

The core navigation system then falls back to ordinary search.

---

# 20. Navigation State

Add task-local navigation state.

Example:

```ts
interface NavigationState {
  repositoryRoot: string;
  exploredDirectories: Set<string>;
  discoveredFiles: Set<string>;
  discoveredSymbols: SymbolMatch[];
  discoveredReferences: SearchMatch[];
  discoveredTests: string[];
  searches: SearchRecord[];
}
```

This is **temporary task state**.

It is not persistent memory.

Do not create a database.

Do not persist repository knowledge between tasks.

---

# 21. Repeated Navigation

Do not hard-block repeated searches.

A repeated search can be legitimate after:

- an edit
- a failed test
- context compaction
- repository changes
- changed search scope

Record repeated operations for metrics.

Only prevent an operation if it is clearly unsafe or exceeds an explicit safety/iteration limit.

The invariant is:

> A previous search does not make a future search invalid.

---

# 22. Context Manager Integration

All navigation results MUST pass through the existing Context Manager.

Do not directly append arbitrary large navigation output to the LLM context.

Flow:

```text
Navigation Tool
      ↓
Raw result
      ↓
Context Manager
      ↓
truncate/prioritize/compact
      ↓
LLM
```

The Navigation Layer should have only a **raw safety ceiling**.

The Context Manager owns the actual LLM context budget.

Do not create a second independent "navigation token budget" that competes with the Context Manager.

---

# 23. Compaction Requirement

Before Iteration 3 evaluation, ensure the existing context system preserves tool-call/result relationships.

A tool interaction should conceptually remain:

```text
tool call
   +
tool result
```

and should not be independently removed in a way that leaves an uninterpretable context.

Test this with sequences such as:

```text
search → result
read → result
find_symbol → result
edit → result
test → result
```

Run at least one test using the real Gemini provider.

This is necessary because Iteration 3 produces more navigation output and will exercise compaction more heavily.

---

# 24. Navigation Strategy

Do not build a complicated autonomous navigation planner.

The LLM remains responsible for deciding what navigation action to take.

The system provides good tools and useful results.

Typical behavior may be:

```text
task
 ↓
list_directory
 ↓
search
 ↓
read_file
 ↓
find_symbol
 ↓
read_file
 ↓
find_tests
 ↓
edit
 ↓
test
```

But this sequence must NOT be hardcoded.

Different tasks may legitimately require different sequences.

---

# 25. Repository Types for Evaluation

Do not evaluate Iteration 3 only on a TypeScript authentication repository.

Use at least:

### Repository A — TypeScript/JavaScript

Tests Tree-sitter symbol discovery.

### Repository B — Python

Tests second-language support.

### Repository C — static HTML/CSS/JavaScript site

Tests that the agent remains useful without language-aware symbols.

### Repository D — noisy repository

Contains:

- many irrelevant files
- ignored directories
- generated files
- minified files
- repeated identifiers
- distractor files

This specifically tests repository scope and search quality.

---

# 26. Evaluation Task Design

Tasks must not reveal their implementation location.

Bad:

```text
Fix PasswordResetService.process()
```

Good:

```text
Users sometimes receive an invalid reset link after requesting a password reset. Fix the issue and verify the behavior.
```

The relevant implementation should not be obvious from the task wording.

Avoid tasks where one exact search term immediately identifies the solution.

---

# 27. Benchmark Ground Truth

Every evaluation task should have a manually maintained manifest.

Example:

```yaml
task: mobile-menu-close

relevant_files:
  - src/js/navigation.js
  - src/css/header.css
  - src/index.html

acceptable_files:
  - src/components/mobile-nav.html

verification:
  command: npm test
```

This allows measurement of:

- relevant files discovered
- relevant files read
- irrelevant files read
- time to first relevant file

Do not infer relevance from the agent's own behavior.

---

# 28. Required Evaluation Tasks

At minimum:

### Task 1 — Unknown-location bug

The task description describes behavior, not the implementation.

### Task 2 — Cross-file behavior

The relevant behavior is distributed across multiple files.

### Task 3 — Symbol discovery

The task requires finding a class/function whose location is not given.

### Task 4 — Static site

HTML/CSS/JS task where Tree-sitter symbol tools are not the primary solution.

### Task 5 — Noisy repository

Many irrelevant files and generated/vendor content.

### Task 6 — Unsupported language

The agent encounters an unsupported language and must successfully fall back to text/file navigation.

---

# 29. Testing Strategy

Testing has four levels.

## Level 1 — Unit Tests

Test deterministic components independently.

### Repository Scope

Test:

- `.gitignore`
- `.git`
- `node_modules`
- generated directories
- binary files
- minified files
- workspace boundary

### Directory Listing

Test:

- depth
- deterministic ordering
- hidden files
- ignored files
- nonexistent directories
- workspace escape

### Search

Test:

- content search
- filename search
- path restriction
- file pattern
- max results
- ignored files
- binary files
- no matches
- huge match sets

### Read File

Test:

- complete file
- start line
- end line
- context lines
- invalid range
- nonexistent file
- huge file
- workspace escape

### Symbol Registry

Test:

- provider registration
- provider lookup by extension
- unsupported extension
- duplicate registration

### TypeScript/JavaScript Symbol Provider

Test:

- function
- class
- method
- interface
- type
- variable
- exported declarations
- line ranges
- comments containing symbol-like text

### Python Symbol Provider

Test:

- function
- class
- method
- nested declarations
- line ranges
- comments containing symbol-like text

### `find_symbol`

Test:

- Tree-sitter success
- unsupported language
- symbol not found
- `rg` fallback
- multiple matches
- path restriction

### Navigation State

Test:

- discovered files
- discovered symbols
- repeated search recording
- state reset between tasks

---

# 30. Integration Tests

Use a real repository fixture.

Test the complete flow:

```text
task
 ↓
repository discovery
 ↓
search
 ↓
symbol discovery
 ↓
focused read
 ↓
edit
 ↓
test
 ↓
verification
```

The integration test should not hardcode that exact sequence as the only valid sequence.

Verify the resulting repository state and tests instead.

---

# 31. Real-Provider Tests

Mock tests cannot establish whether the LLM chooses the right navigation tools.

Therefore run a smaller set of evaluations with the real Gemini provider.

Measure:

- tools selected
- navigation order
- relevant information found
- task completion
- test result
- context size
- tokens
- iterations
- unnecessary exploration

These tests are evaluation tests, not deterministic unit tests.

---

# 32. Multiple Runs

Do not judge a change from one run.

For each important evaluation task:

```text
Iteration 2 baseline:
    Run 1
    Run 2
    Run 3
    Run 4
    Run 5

Iteration 3:
    Run 1
    Run 2
    Run 3
    Run 4
    Run 5
```

Record the results.

Identical tasks can produce different tool sequences because LLM behavior is nondeterministic.

---

# 33. Metrics

Record:

### Success

- task completed
- tests passed
- independently verified

### Navigation

- navigation tool calls
- searches
- directory listings
- symbol searches
- files discovered
- files read
- relevant files read
- irrelevant files read

### Efficiency

- time to first relevant file
- tool calls before first relevant file
- tokens
- peak context
- total context sent
- repeated searches

### Symbol discovery

- Tree-sitter searches
- fallback searches
- symbol matches
- false/irrelevant matches

Do not optimize for the fewest navigation calls alone.

A larger number of calls can be better if they produce better information with fewer irrelevant tokens.

---

# 34. Navigation Failure Analysis

Classify failures as:

```text
REPOSITORY_SCOPE
FILE_DISCOVERY
SEARCH_QUERY
SYMBOL_DISCOVERY
REFERENCE_DISCOVERY
TEST_DISCOVERY
RESULT_RANKING
TOOL_SELECTION
NAVIGATION_LOOP
EXCESSIVE_EXPLORATION
INSUFFICIENT_EXPLORATION
CONTEXT_HANDOFF
CONTEXT_COMPACTION
MODEL_REASONING
PROVIDER
```

For every failure identify:

1. first incorrect action
2. what the agent should have done
3. why it failed
4. whether the problem was:
   - tool implementation
   - tool interface
   - context
   - model/tool selection
   - evaluation design
5. smallest change that could fix it

Do not automatically add a new feature for every failure.

---

# 35. Important Evaluation Matrix

Evaluate tasks along two dimensions.

## Location knowledge

```text
                 Code location
              Known       Unknown

Behavior
Known         easy        navigation
Unknown       medium      hardest
```

Iteration 3 primarily targets:

```text
behavior unknown
+
code location unknown
```

Those are the tasks where repository navigation matters most.

Also evaluate:

```text
             Information value
             High       Low

Known         useful     noise
Unknown       target     distraction
```

The system should become better at finding **unknown, high-value information**.

---

# 36. Debugging

Add:

```bash
engineering-agent --debug-navigation "Fix the bug"
```

Show:

```text
Repository scope:
  ignored: node_modules/
  ignored: dist/

Navigation:
  list_directory(".")
  search("mobile menu")
  find_symbol("toggleMenu")
  read_file("src/navigation.js", 40, 75)

Results:
  relevant files: ...
  truncated: ...
```

Do not dump huge raw outputs.

Debug mode exists to understand navigation behavior.

---

# 37. Logging

Add structured events:

```text
repository_scan_started
repository_scan_completed

directory_listed

search_started
search_completed

symbol_search_started
symbol_search_completed

test_discovery_started
test_discovery_completed

navigation_duplicate_detected
navigation_scope_filtered

navigation_result_truncated
```

Include:

- task ID
- timestamp
- iteration
- operation
- path where appropriate
- duration
- result count
- output size
- provider used
- Tree-sitter vs fallback

Never log API keys.

---

# 38. `IMPLEMENTATION_PROGRESS.md`

Add an Iteration 3 section.

Track every meaningful task.

Example:

```markdown
## Iteration 3

### Repository Scope
- [ ] Implement RepositoryScope
- [ ] Add .gitignore handling
- [ ] Add binary filtering
- [ ] Add generated/minified filtering
- [ ] Unit tests

### Navigation
- [ ] Improve list_directory
- [ ] Implement unified search
- [ ] Add focused read_file
- [ ] Implement test discovery

### Symbol Discovery
- [ ] SymbolProvider interface
- [ ] Symbol registry
- [ ] Tree-sitter infrastructure
- [ ] TypeScript/JavaScript provider
- [ ] Python provider
- [ ] rg fallback
- [ ] Symbol tests

### Language Extension
- [ ] add-language command
- [ ] Generated provider scaffold
- [ ] Generated fixture
- [ ] Generated tests
- [ ] Registry integration

### Context Integration
- [ ] Navigation results pass through Context Manager
- [ ] Verify compaction preserves tool interactions
- [ ] Real-provider context test

### Evaluation
- [ ] TypeScript fixture
- [ ] Python fixture
- [ ] HTML/CSS fixture
- [ ] Noisy fixture
- [ ] Unsupported-language fixture
- [ ] Ground-truth manifests
- [ ] Multiple real-provider runs
- [ ] Failure analysis
- [ ] Iteration 2 vs Iteration 3 comparison
```

Only mark `[x]` after verification.

Update the file continuously.

---

# 39. Implementation Order

Do not implement everything at once.

### Phase 1 — Baseline

1. Read previous implementation.
2. Read `IMPLEMENTATION_PROGRESS.md`.
3. Run all previous tests.
4. Verify Iteration 2 context behavior.
5. Fix context/tool-pairing issues that would invalidate Iteration 3.

### Phase 2 — Repository Scope

6. Implement RepositoryScope.
7. Add ignore handling.
8. Add binary/generated filtering.
9. Test.

### Phase 3 — Core Navigation

10. Improve `list_directory`.
11. Implement unified search.
12. Add focused `read_file`.
13. Implement test discovery.
14. Test.

### Phase 4 — Symbol Infrastructure

15. Create `SymbolProvider`.
16. Create registry.
17. Add Tree-sitter infrastructure.
18. Implement TypeScript/JavaScript extractor.
19. Implement Python extractor.
20. Implement `find_symbol`.
21. Implement `rg` fallback.
22. Test.

### Phase 5 — Language Extension

23. Implement `add-language`.
24. Generate a sample language provider.
25. Generate fixture/test files.
26. Verify adding a language does not require core navigation changes.

### Phase 6 — Integration

27. Integrate navigation state.
28. Integrate with Context Manager.
29. Verify result limits.
30. Verify compaction behavior.
31. Add debug navigation mode.
32. Add navigation metrics/logging.

### Phase 7 — Evaluation

33. Build diverse fixtures.
34. Build ground-truth manifests.
35. Run Iteration 2 baseline.
36. Run Iteration 3.
37. Repeat each important task multiple times.
38. Independently verify results.
39. Analyze failures.
40. Fix only demonstrated problems.
41. Repeat evaluation.

---

# 40. Acceptance Criteria

Iteration 3 is successful when:

### Repository discovery

- [ ] Agent can orient itself in an unfamiliar repository.
- [ ] Ignored/generated/binary content does not dominate discovery.
- [ ] Repository boundaries are enforced.

### Navigation

- [ ] Directory discovery works.
- [ ] Search works for filenames and content.
- [ ] `read_file` supports focused line ranges.
- [ ] Test discovery finds likely tests.
- [ ] Results are bounded.

### Symbols

- [ ] TypeScript/JavaScript symbol discovery works.
- [ ] Python symbol discovery works.
- [ ] Symbol locations include useful line ranges.
- [ ] Unsupported languages gracefully fall back to text search.
- [ ] Tree-sitter and fallback behavior are tested.
- [ ] Adding another language does not require changing core navigation.

### Context

- [ ] Navigation results pass through Context Manager.
- [ ] Navigation does not create a second competing context budget.
- [ ] Tool calls/results remain coherent during compaction.

### Agent behavior

- [ ] Real-model tasks demonstrate useful navigation.
- [ ] The agent can solve unknown-location tasks.
- [ ] The agent does not require a hardcoded navigation sequence.

### Evaluation

- [ ] Multiple repository types are tested.
- [ ] Evaluation tasks do not reveal implementation locations.
- [ ] Ground truth exists for relevant files.
- [ ] Multiple runs are performed.
- [ ] Results are independently verified.
- [ ] Failures are classified and analyzed.

---

# 41. Definition of Done

Iteration 3 is complete when a real coding task can follow this general path:

```text
User task
   ↓
Agent
   ↓
Understand repository
   ↓
Respect repository scope
   ↓
Discover relevant information
   ↓
Use search / read / symbol discovery when appropriate
   ↓
Pass useful information through Context Manager
   ↓
Modify code
   ↓
Run tests
   ↓
Verify result
   ↓
Report completion
```

and this works across the selected evaluation repositories.

The implementation must also demonstrate:

```text
TypeScript/JavaScript
        +
Python
        +
HTML/CSS generic navigation
        +
unsupported-language fallback
```

---

# 42. What We Learn From Iteration 3

At the end, we should be able to answer:

1. Does repository structure discovery improve agent performance?
2. Does ignoring generated/vendor/noisy content materially help?
3. Does focused reading reduce context usage?
4. Does Tree-sitter symbol discovery outperform ordinary text search for relevant tasks?
5. When does the agent choose symbol discovery?
6. When does it choose normal search?
7. How often is `rg` fallback required?
8. Does language-specific structural information improve task success?
9. How much irrelevant repository information does the agent consume?
10. Does the current navigation interface make tool selection easier or harder?
11. Does the Context Manager preserve useful navigation information?
12. What navigation failures actually occur in real tasks?
13. Are the failures caused by tools, context, or the model?
14. Is there evidence that we need something more sophisticated?

That last question is intentionally left unanswered until evaluation.

---

# 43. Future Work Decision Rule

Do not automatically start building RAG, embeddings, vector search, memory, or indexing after Iteration 3.

First review the evidence.

For example:

### If keyword search is sufficient

Keep it.

### If symbol discovery is highly valuable

Improve the existing Tree-sitter providers.

### If one more language is needed

Use `add-language`.

### If large repositories cause excessive repeated search

Investigate indexing as a separate experiment.

### If the agent repeatedly needs semantic retrieval that keyword search cannot provide

Then, and only then, consider a future experiment involving embeddings or semantic search.

### If the agent needs information across tasks

Then investigate persistent memory.

Each major capability must be justified by an observed limitation.

---

# 44. Final Engineering Principle

The team must follow this rule throughout Iteration 3:

> **Do not build infrastructure for hypothetical future requirements. Implement the smallest mechanism that solves an observed problem, measure it, and only then decide whether the next capability is necessary.**

Iteration 3 is therefore a **repository navigation and information-discovery iteration**, not the beginning of a RAG/vector/memory platform.

The final implementation should be small enough that a developer can understand the complete navigation system end-to-end.
