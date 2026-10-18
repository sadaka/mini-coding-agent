Engineering Agent — Iteration 2
Technical Implementation Plan: Context Management & Token Efficiency
Project: Engineering Agent
 Iteration: 2
 Primary Goal: Context Management
 Status: Implementation specification
 Target: Coding agent / developer implementation

1. Iteration Objective
Iteration 2 improves the MVP created in Iteration 1 by introducing a dedicated Context Management subsystem.
The agent must no longer blindly send the complete conversation history and every tool result to the LLM.
Instead, it must explicitly decide:
What information is required for the current LLM request
What information can be removed or shortened
Which tool outputs should be truncated
How much context is currently being sent
How much context is available
How context grows during an agent task
When older information should be compacted
How to preserve important information when context is compacted
The core learning question is:
Given everything that happened during a coding task, what is the minimum useful context the LLM needs to make the next correct decision?

2. What Iteration 2 Is NOT
Do not turn Iteration 2 into a large memory or retrieval system.
Do NOT implement:
RAG
embeddings
vector databases
semantic retrieval
persistent long-term memory
sub-agents
model routing
MCP
automatic model switching
sophisticated repository indexing
autonomous background agents
multi-agent communication
distributed context storage
These may be experiments in later iterations.
Iteration 2 is about controlling the existing agent's context.

3. Starting Point
Iteration 1 already provides:
CLI
  ↓
Agent Runtime
  ↓
Agent Loop
  ↓
LLM Interface
  ↓
Gemini Provider
  ↓
Tool Registry
  ├── Search
  ├── Read File
  ├── Edit/Write File
  └── Run Command

Iteration 2 adds:
                   ┌──────────────────────┐
                    │   Context Manager    │
                    │                      │
                    │ - Context Builder   │
                    │ - Token Estimator   │
                    │ - Truncator         │
                    │ - Compactor         │
                    │ - Context Metrics   │
                    └──────────┬───────────┘
                               │
Agent Loop ────────────────────┤
                               ↓
                         LLM Interface

The Agent Loop should no longer construct LLM messages directly.
It should ask the Context Manager for the context to send.

4. Iteration 2 Architecture
Target architecture:
                        ┌─────────────────────┐
                         │       CLI           │
                         └──────────┬──────────┘
                                    ↓
                         ┌─────────────────────┐
                         │    Agent Runtime    │
                         └──────────┬──────────┘
                                    ↓
                         ┌─────────────────────┐
                         │     Agent Loop      │
                         └──────────┬──────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  ↓                                   ↓
       ┌─────────────────────┐             ┌──────────────────┐
       │  Context Manager    │             │   Tool Registry  │
       │                     │             └──────────────────┘
       │ Context Builder     │
       │ Token Estimator     │
       │ Truncator          │
       │ Compactor          │
       │ Metrics            │
       └──────────┬──────────┘
                  ↓
       ┌─────────────────────┐
       │    LLM Interface    │
       └──────────┬──────────┘
                  ↓
       ┌─────────────────────┐
       │   Gemini Adapter    │
       └─────────────────────┘


5. Primary Design Principle
Context must be treated as a managed resource.
The system should distinguish between:
Required context
Information necessary to make the next decision.
Examples:
Current user task
Important constraints
Relevant files
Recent tool result
Current test failure
Recent code change
Important discovered facts
Useful context
Information that may help but is not always required.
Examples:
Earlier search results
Older tool calls
Previous reasoning
Historical command output
Disposable context
Information that can normally be removed.
Examples:
Repeated search results
Large irrelevant file sections
Old command output
Duplicate information
Earlier intermediate reasoning
The Context Manager should preserve the first category, selectively retain the second, and remove/truncate the third.

6. Required Implementation Components
Create or expand:
src/context/
├── types.ts
├── context-manager.ts
├── context-builder.ts
├── token-estimator.ts
├── truncator.ts
├── compactor.ts
├── context-metrics.ts
└── policies.ts

Tests:
tests/unit/context/
├── context-manager.test.ts
├── context-builder.test.ts
├── token-estimator.test.ts
├── truncator.test.ts
├── compactor.test.ts
├── context-metrics.test.ts
└── policies.test.ts

tests/integration/
└── context-management.test.ts


7. Context Data Model
Define an internal representation for context items.
Conceptually:
type ContextItemType =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "task_state"
  | "important_fact"
  | "summary";

Each context item should contain enough metadata to make management decisions.
Example:
interface ContextItem {
  id: string;
  type: ContextItemType;
  content: string;

  importance: "critical" | "high" | "normal" | "low";

  createdAt: number;

  tokenEstimate?: number;

  source?: {
    toolName?: string;
    filePath?: string;
    command?: string;
  };

  removable?: boolean;
}

Do not over-engineer this data model.
The purpose is to experiment with context management, not create a universal memory framework.

8. Context State
The Context Manager should maintain:
interface ContextState {
  items: ContextItem[];

  maxContextTokens: number;

  reservedOutputTokens: number;

  estimatedInputTokens: number;

  compactionCount: number;

  truncatedItemCount: number;
}

Additional metrics can be added later.

9. Context Budget
The agent must have an explicit context budget.
Example configuration:
MAX_CONTEXT_TOKENS=32000
RESERVED_OUTPUT_TOKENS=4096
MAX_TOOL_OUTPUT_TOKENS=4000
MAX_FILE_READ_TOKENS=6000
COMPACTION_THRESHOLD=0.80

These are initial defaults, not permanent values.
The configuration must be changeable without modifying source code.

10. Why Reserve Output Tokens?
The context window is shared conceptually between:
Input context
+
Expected model output

Therefore:
usable input budget =
max context size - reserved output tokens

For example:
Context limit:       32,000
Reserved output:      4,000
--------------------------------
Input budget:        28,000

The implementation should never assume that the entire context window is available for input.

11. Token Estimation
Iteration 2 must introduce token estimation.
The first implementation does NOT need to reproduce the provider's exact tokenizer.
Create:
interface TokenEstimator {
  estimate(text: string): number;
}

Implement a simple estimator first.
For example:
estimatedTokens ≈ characters / 4

or another clearly documented approximation.
The estimator must be:
deterministic
fast
provider-independent
testable
Do not make the core Context Manager depend on a Gemini tokenizer.

12. Token Estimation Requirements
The system should estimate:
individual message tokens
tool-call tokens
tool-result tokens
total input tokens
context budget utilization
Example:
Context:
  System instructions       350
  User request              120
  Search result             900
  File content             4200
  Test output               700
  Previous conversation    1800
  --------------------------------
  Estimated input          8070

Budget:                   28000

Utilization:              28.8%

Exact numbers may differ because the initial estimator is approximate.
The important requirement is that the system measures rather than guesses.

13. Context Builder
Create a dedicated Context Builder.
Responsibilities:
Receive current agent state
Receive historical context items
Apply context policies
Estimate token usage
Select appropriate items
Truncate oversized items
Compact context if required
Produce LLM-ready messages
Interface:
interface ContextBuilder {
  build(input: BuildContextInput): BuildContextResult;
}

Conceptually:
interface BuildContextInput {
  task: string;
  contextState: ContextState;
  tools: ToolDefinition[];
  budget: ContextBudget;
}

Result:
interface BuildContextResult {
  messages: Message[];

  estimatedTokens: number;

  utilization: number;

  truncated: boolean;

  compacted: boolean;

  metrics: ContextMetrics;
}


14. Context Ordering
Context ordering matters.
Use this general priority:
1. System instructions
2. Current user task
3. Current task state / important facts
4. Relevant recent tool results
5. Recent assistant/tool interaction
6. Older useful context
7. Summaries of older context

Do not simply append everything forever.
The most important information must remain available.

15. Tool Output Management
Large tool output is one of the easiest ways to destroy context efficiency.
Every tool should have an output limit.
Iteration 1 already limits tool output.
Iteration 2 must make that limit part of the Context Management architecture.
Example:
Search:
  max output: 2000 tokens

Read File:
  max output: 6000 tokens

Run Command:
  max output: 4000 tokens

If a result is larger:
[result truncated]

Original size: 13,500 tokens
Returned: 4,000 tokens

Use a narrower search/read operation if more information is required.

The model should be told that truncation occurred.

16. Intelligent Truncation
Do not truncate all content using the same strategy.
File content
Prefer:
requested line range
+
relevant surrounding lines

rather than taking the first N tokens.
Search results
Prefer:
highest-relevance matches

and discard low-priority matches.
Command output
Prefer:
error output
+
last portion of output

when output is excessively large.
For test failures, the failure/error portion is usually more valuable than thousands of successful log lines.

17. Truncator
Create:
interface Truncator {
  truncate(
    item: ContextItem,
    maxTokens: number
  ): ContextItem;
}

The result must clearly indicate truncation.
Example metadata:
{
  truncated: true,
  originalTokenEstimate: 12000,
  finalTokenEstimate: 3000
}

Do not silently discard content.

18. Context Priority
Implement a simple priority system.
Suggested priority:
CRITICAL
HIGH
NORMAL
LOW

Examples:
CRITICAL
User task
Safety restrictions
Current failing test
Current task state
Important discovered constraint
HIGH
Relevant source file
Recent code change
Important test result
Important repository information
NORMAL
Recent search result
Normal command output
Earlier interaction
LOW
Repeated search results
Old intermediate output
Redundant information

19. Context Selection Algorithm
The initial algorithm should be deterministic.
Pseudo-process:
1. Always include critical items.
2. Include high-priority items.
3. Add recent normal-priority items.
4. Add low-priority items only if budget remains.
5. If budget is exceeded:
   a. truncate oversized items
   b. remove low-priority items
   c. remove older normal items
   d. compact older history if necessary
6. Never remove critical items unless the system cannot fit them.
7. Record what was removed/truncated.

This should be implemented as a policy rather than scattered throughout the Agent Loop.

20. Recency
When two items have similar importance, prefer recent information.
For example:
HIGH + recent

should normally beat:
HIGH + old

But:
CRITICAL + old

should still beat:
NORMAL + recent

Therefore priority must be considered before recency.

21. Duplicate Information
Iteration 2 should detect simple duplication.
Example:
The model searches:
calculator.ts

three times and receives essentially the same result.
Do not continue sending all three copies.
Initial duplicate detection can use:
normalized content hash

or another simple deterministic mechanism.
Do NOT build semantic similarity or embeddings.

22. Context Compaction
Iteration 2 introduces basic compaction.
Compaction means:
Replace older detailed interaction history with a shorter summary that preserves information required to continue the task.
Example:
Before:
User request
Search result
Assistant response
Read file
Assistant response
Run test
Test failure
Assistant response
Search result
Read file
...

After compaction:
Task:
Fix calculator multiplication bug.

Important findings:
- Bug is in src/calculator.ts
- multiply() returns addition
- Existing tests expect multiplication
- Modified src/calculator.ts
- Test command: npm test
- Current test status: failing on division test

Recent interaction should remain detailed.
Older interaction becomes summarized.

23. Compaction Strategy
Do not implement complex autonomous summarization initially.
Use a clear two-stage design.
Stage 1
Identify older context eligible for compaction.
Example:
Everything before the most recent 8 interaction turns

Stage 2
Generate a compact summary.
There are two acceptable approaches.
Option A — Deterministic summary
Extract:
user task
modified files
commands
test results
important facts
errors
This is preferred for the first implementation because it is predictable.
Option B — LLM summary
Use the LLM to summarize older context.
This can be implemented as an experimental feature after deterministic compaction works.
Do not make LLM summarization mandatory for the first working version.

24. Compaction Safety
A summary must never cause loss of critical state.
The compactor must preserve:
Original user goal
Current status
Modified files
Important discovered facts
Important constraints
Failed approaches
Successful approaches
Current errors
Relevant verification results

It may remove:
Repeated searches
Verbose command output
Intermediate reasoning
Redundant tool results
Old conversational wording


25. Compaction Metadata
Record:
interface CompactionEvent {
  timestamp: number;

  itemsBefore: number;
  itemsAfter: number;

  estimatedTokensBefore: number;
  estimatedTokensAfter: number;

  itemsRemoved: number;

  summaryCreated: boolean;
}

This is required for evaluation.

26. When to Compact
Do not wait until the context is completely full.
Use a threshold.
Example:
Context utilization < 80%
    ↓
Continue normally

Context utilization >= 80%
    ↓
Try truncation/removal

Still >= 80%
    ↓
Compact older context

Still too large
    ↓
Apply stronger reduction

Still impossible
    ↓
Fail safely with clear error

The threshold must be configurable.

27. Agent Loop Changes
Iteration 1 probably has logic similar to:
messages.push(toolResult)

llm.generate(messages)

Iteration 2 must change this.
New pattern:
agentState.addContext(toolResult)

context = contextManager.build(agentState)

llm.generate(context.messages)

The Agent Loop should not decide which historical messages are removed.
That is the Context Manager's responsibility.

28. Agent State Changes
Extend the existing agent state.
Add:
interface ContextStats {
  totalItems: number;
  estimatedTokens: number;
  utilization: number;

  truncations: number;
  compactions: number;

  droppedItems: number;
}

The Agent State should also track:
important facts
modified files
executed commands
test results
current task status

These should be available to the Context Manager.

29. Important Facts
Introduce a small structured store:
interface ImportantFact {
  id: string;
  content: string;
  importance: "critical" | "high" | "normal";
  source?: string;
}

Examples:
"Bug is in src/calculator.ts"
"multiply() currently performs addition"
"npm test fails in calculator.test.ts"
"Do not modify generated files"

This is NOT persistent memory.
It exists only for the current agent task.

30. Context vs Memory
Do not confuse the two.
Context
Information available during the current task.
Task starts
    ↓
Context grows
    ↓
Context is managed
    ↓
Task ends
    ↓
Context can disappear

Persistent memory
Information intentionally retained across tasks.
Iteration 2 does NOT implement persistent memory.

31. LLM Interface Changes
The provider-independent interface must remain provider-independent.
Do not add Gemini-specific context logic.
Existing:
generate(
  messages,
  tools,
  options
)

can remain conceptually the same.
The Context Manager prepares the messages before the provider sees them.
Architecture remains:
Context Manager
      ↓
LLM Interface
      ↓
Provider Adapter
      ↓
Gemini

Never:
Context Manager
      ↓
Gemini SDK


32. Provider Context Limits
Provider configuration should expose a context limit.
Example:
interface ModelCapabilities {
  contextWindowTokens: number;
  maxOutputTokens?: number;
}

For example:
{
  contextWindowTokens: 32000,
  maxOutputTokens: 4096
}

The Context Manager uses these values.
The Gemini adapter supplies provider/model capabilities.
The core Context Manager does not hardcode Gemini-specific limits.

33. Model Configuration
Allow configuration such as:
MODEL_CONTEXT_TOKENS
MODEL_OUTPUT_TOKENS
CONTEXT_COMPACTION_THRESHOLD
MAX_TOOL_OUTPUT_TOKENS

Example:
MODEL_CONTEXT_TOKENS=32000
MODEL_OUTPUT_TOKENS=4096
CONTEXT_COMPACTION_THRESHOLD=0.80

Do not implement automatic model selection.

34. Context Metrics
Every LLM request should record:
iteration
estimated input tokens
estimated output tokens if available
context utilization
number of context items
number of tool results
number of truncated results
number of dropped items
number of compactions

Example log:
LLM Request
iteration: 7
context_items: 19
estimated_input_tokens: 8420
context_budget: 28000
utilization: 30.1%
truncated_items: 1
compactions: 0


35. Logging
Add events:
context_build_started
context_build_completed
context_item_truncated
context_item_dropped
context_compaction_started
context_compaction_completed

Example:
context_compaction_completed
items_before=24
items_after=9
tokens_before=28100
tokens_after=7400

Do not log sensitive secrets.

36. CLI Context Visibility
Add an optional debugging mode:
engineering-agent --debug-context "Fix the failing test"

Normal users should not see every context-management detail.
Debug mode may display:
Context:
  Items: 14
  Estimated tokens: 8,420
  Budget: 28,000
  Utilization: 30%

No compaction required.

When compaction occurs:
Context:
  Before: 27,900 tokens
  Compacted: 14,200 tokens
  After: 8,100 tokens


37. Context Debug Dump
Add an optional command/debug facility to inspect the context.
Example:
engineering-agent --debug-context ...

Output should show:
[CRITICAL] User task
[CRITICAL] Current task state
[HIGH] src/calculator.ts
[HIGH] Latest test result
[NORMAL] Search result
[LOW] Previous search result [DROPPED]

This is extremely useful for learning how coding agents manage context.

38. Testing Strategy
Iteration 2 must be tested independently before testing the complete agent.
Testing has four levels:
1. Unit tests
2. Context stress tests
3. Agent integration tests
4. Evaluation tasks


39. Unit Test: Token Estimator
Test:
empty string
short text
long text
deterministic output
increasing text produces increasing estimate
Example:
estimate("hello")
<
estimate("hello world this is a longer sentence")


40. Unit Test: Truncation
Test:
Case 1
Input below limit.
Expected:
unchanged

Case 2
Input above limit.
Expected:
truncated

Case 3
Truncated result contains marker.
Expected:
[result truncated]

Case 4
Original metadata preserved.
Expected:
originalTokenEstimate > finalTokenEstimate


41. Unit Test: Priority Selection
Create 20 context items with different priorities.
Force a small budget.
Verify:
critical items remain
high-priority items are preferred
low-priority items are removed first


42. Unit Test: Recency
Create:
HIGH old
HIGH recent

When only one fits:
HIGH recent

should be selected.
But verify:
CRITICAL old

beats:
NORMAL recent


43. Unit Test: Duplicate Removal
Add the same tool result multiple times.
Expected:
duplicate result is not repeatedly included

Verify that unique results remain.

44. Unit Test: Compaction
Create a large context.
Expected:
before tokens > after tokens

Verify:
user task remains
important facts remain
current state remains
recent context remains
old redundant context is removed

45. Context Stress Test
Create an artificial conversation containing:
100+ tool results
50+ file reads
20+ test commands
large search results
repeated results

The Context Manager must:
remain within budget
not crash
preserve critical information
report truncation/compaction
produce valid LLM messages

46. Important Stress Scenario
Simulate:
Agent iteration 1
Search repository

Agent iteration 2
Read file

Agent iteration 3
Read another file

...

Agent iteration 30
Run tests

The system should not allow context to grow without limit.
Measure:
iteration
raw context size
managed context size
estimated tokens
compaction count


47. Integration Test
Use the Iteration 1 test fixture:
test-project/
├── src/
│   └── calculator.ts
├── tests/
│   └── calculator.test.ts
└── package.json

Give the agent:
Fix the failing calculator test.

The agent should still:
Search
→ Read
→ Edit
→ Run test
→ Observe
→ Finish

Context management must not break the existing workflow.

48. Long-Running Agent Test
Create a task that intentionally requires many interactions.
Example:
Inspect the project, identify three related bugs,
fix them, and run the complete test suite.

The exact fixture should be controlled.
The purpose is to force:
context growth
→ threshold
→ truncation
→ compaction
→ continued work
→ verification

The agent must continue correctly after compaction.

49. Failure Test: Context Too Large
Construct a situation where even after compaction the context cannot fit.
Expected behavior:
Agent does not crash unexpectedly.

Agent reports:
"Unable to fit required context within configured context budget."

The system must fail safely rather than silently dropping critical information.

50. Failure Test: Important Information Loss
Create a task where an important discovery happens early.
Example:
"Do not modify generated files."

Later generate enough context to trigger compaction.
Verify that the instruction remains available after compaction.
This test is critical.

51. Failure Test: Incorrect Summary
If LLM-generated summaries are implemented experimentally, create tests where the summary could accidentally omit:
modified file
test failure
important constraint

The system should either preserve these through structured task state or detect insufficient summary quality.
For the first implementation, deterministic compaction is preferred.

52. Evaluation Tasks
Run at least these tasks:
Task 1 — Simple Bug Fix
Short context.
Purpose:
Ensure Iteration 2 does not hurt basic performance.

Task 2 — Multi-file Change
Purpose:
Require several files to remain relevant.

Task 3 — Large Search
Purpose:
Test search-output truncation.

Task 4 — Large File
Purpose:
Test file-read truncation.

Task 5 — Long Task
Purpose:
Force context growth and compaction.

Task 6 — Repeated Search
Purpose:
Test duplicate removal.

Task 7 — Important Early Discovery
Purpose:
Verify important information survives compaction.


53. Baseline Comparison
Iteration 2 must be compared with Iteration 1.
Run the same evaluation tasks using:
Version A:
Iteration 1 context handling

Version B:
Iteration 2 context management

Measure:
task success
iterations
tool calls
estimated tokens
context size
compactions
truncations
execution time
verification result

The objective is not necessarily to make every task use fewer tokens.
The objective is to understand the tradeoff.

54. Evaluation Table
Record results like:
Task
Version
Success
Iterations
Est. Tokens
Compactions
Truncations
Bug fix
Iteration 1










Bug fix
Iteration 2










Multi-file
Iteration 1










Multi-file
Iteration 2










Long task
Iteration 1










Long task
Iteration 2











Do not judge the implementation using token count alone.

55. Failure Analysis
For every failed task ask:
1. Did context management remove required information?
If yes:
CONTEXT_LOSS

2. Did the model receive too much irrelevant information?
CONTEXT_OVERLOAD

3. Was a tool result truncated incorrectly?
TRUNCATION

4. Did compaction lose important information?
COMPACTION_LOSS

5. Did the model fail despite receiving sufficient information?
MODEL_REASONING

6. Did context selection choose the wrong information?
CONTEXT_SELECTION

7. Did token estimation cause an incorrect decision?
TOKEN_ESTIMATION


56. Failure Analysis Example
Record:
Task:
Fix failing authentication test.

Result:
FAIL

Observed:
Agent changed wrong file.

Context analysis:
Relevant file was discovered during iteration 3.
It was removed during compaction.
Summary preserved the test failure but not the file path.

Root cause:
COMPACTION_LOSS

Correction:
Persist modified/relevant file paths as structured important facts.

This analysis is more important than simply fixing the bug.
The purpose of Iteration 2 is to understand why context decisions affect agent behavior.

57. Context Efficiency Metrics
Track:
Raw context
Amount of information generated during the task.
Managed context
Information actually sent to the LLM.
Reduction ratio
1 - managed/raw

Average request size
total input tokens / number of LLM requests

Maximum context utilization
Highest percentage reached.
Compaction effectiveness
tokens before compaction
vs
tokens after compaction

Task success
Most important metric.

58. Important Metric: Information Preservation
Token reduction is not useful if correctness falls.
Therefore evaluate:
Context efficiency
        ×
Information preservation
        ×
Task success

A system that reduces context by 80% but causes the agent to fail is worse than one that reduces context by 30% while preserving correctness.

59. Context Policy Configuration
Create a central configuration.
Example:
interface ContextPolicy {
  maxContextTokens: number;
  reservedOutputTokens: number;

  compactionThreshold: number;

  maxToolResultTokens: number;
  maxFileReadTokens: number;
  maxSearchResultTokens: number;
  maxCommandOutputTokens: number;

  maxRecentItems: number;

  enableDuplicateRemoval: boolean;
  enableCompaction: boolean;
}

Avoid hardcoded numbers across multiple files.

60. Backward Compatibility
Iteration 2 must not break Iteration 1.
Existing commands must continue to work:
engineering-agent "Fix the failing test"

and:
engineering-agent --workspace ./project "Fix the failing test"

Existing tools must continue to work.
Existing provider abstraction must remain intact.

61. README Updates
Update README with:
Context management
Explain:
The agent does not continuously send unlimited conversation history.
It manages context using priorities, truncation, token estimation,
and basic compaction.

Debugging
Document:
engineering-agent --debug-context ...

Configuration
Document all context-related environment/configuration options.

62. Progress Tracking
Continue using:
IMPLEMENTATION_PROGRESS.md

from Iteration 1.
Add an Iteration 2 section.
Example:
# Iteration 2 Progress

## Current Status
IN PROGRESS

## Implementation

- [ ] Context types
- [ ] Token estimator
- [ ] Context builder
- [ ] Priority policy
- [ ] Truncator
- [ ] Duplicate removal
- [ ] Deterministic compactor
- [ ] Context metrics
- [ ] Agent loop integration
- [ ] Configuration
- [ ] Debug context output

## Testing

- [ ] Token estimator tests
- [ ] Truncation tests
- [ ] Priority tests
- [ ] Duplicate tests
- [ ] Compaction tests
- [ ] Stress tests
- [ ] Integration tests

## Evaluation

- [ ] Baseline Iteration 1
- [ ] Iteration 2 evaluation
- [ ] Failure analysis
- [ ] Fix failures
- [ ] Repeat evaluation

## Current Step
...

## Blockers
...

## Next Action
...

Update this file after every meaningful implementation step.

63. Implementation Order
The coding agent must implement in this order.
Phase 1 — Understand Existing Code
Before modifying anything:
Read current project structure.
Read Agent Loop.
Read Agent State.
Read LLM interface.
Read Message types.
Read Tool Result types.
Read logging.
Read tests.
Read IMPLEMENTATION_PROGRESS.md.
Do not rewrite existing architecture unnecessarily.

Phase 2 — Context Types
Implement:
context/types.ts

Add:
ContextItem
ContextState
ContextBudget
ContextMetrics
ImportantFact
Write unit tests.
Run tests.
Update progress.

Phase 3 — Token Estimator
Implement:
token-estimator.ts

Add deterministic approximation.
Write tests.
Run tests.
Update progress.

Phase 4 — Truncator
Implement:
truncator.ts

Support:
generic text
file content
search results
command output
Write tests.
Run tests.
Update progress.

Phase 5 — Context Policies
Implement:
policies.ts

Add:
priority
recency
removal
truncation
duplicate handling
Write tests.
Run tests.
Update progress.

Phase 6 — Context Builder
Implement:
context-builder.ts

Build LLM-ready messages from managed context.
Verify:
critical → high → recent normal → low

Write tests.
Run tests.
Update progress.

Phase 7 — Deterministic Compaction
Implement:
compactor.ts

First implementation must use deterministic structured summarization.
Preserve:
task
status
important facts
files
commands
test results
errors
Write tests.
Run tests.
Update progress.

Phase 8 — Context Manager
Implement:
context-manager.ts

It should coordinate:
Context Builder
Token Estimator
Truncator
Compactor
Policies
Metrics

The Agent Loop should call this single subsystem.

Phase 9 — Agent Loop Integration
Replace direct message accumulation with:
Agent State
    ↓
Context Manager
    ↓
Managed LLM Context
    ↓
LLM

Do not duplicate context logic inside the Agent Loop.

Phase 10 — Metrics and Logging
Add:
context_build_started
context_build_completed
context_item_truncated
context_item_dropped
context_compaction_started
context_compaction_completed

Add token/context statistics to LLM request logs.

Phase 11 — Debug Mode
Implement:
--debug-context

Show:
context size
token estimate
budget
utilization
dropped items
truncation
compaction

Phase 12 — Unit Tests
All context components must have tests.
Run:
npm test

or the project's equivalent.
Do not proceed if existing tests regress.

Phase 13 — Stress Tests
Run artificial large-context tests.
Verify:
bounded context
+
critical information preservation
+
no crashes


Phase 14 — Integration Tests
Run the original Iteration 1 fixture.
Verify that the agent still completes the task.

Phase 15 — Evaluation
Run all Iteration 2 evaluation tasks.
Record results.
Compare with Iteration 1 baseline.

Phase 16 — Failure Analysis
For every failure:
Identify first incorrect context decision
→ classify failure
→ fix
→ rerun

Do not simply patch the individual test.
Fix the underlying context-management behavior where appropriate.

Phase 17 — Repeat
After fixes:
Run complete tests
→ run evaluation suite
→ analyze results
→ verify no regression

Repeat until stable.

64. Acceptance Criteria
Iteration 2 is complete only when all of the following are true.
Architecture
[ ] Context Manager exists as a separate subsystem.
[ ] Agent Loop uses Context Manager.
[ ] Context logic is not embedded throughout Agent Loop.
[ ] Provider independence remains intact.
Token Management
[ ] Token estimation exists.
[ ] Context budget exists.
[ ] Output reservation exists.
[ ] Tool outputs are bounded.
[ ] Oversized content can be truncated.
[ ] Context utilization is measured.
Context Selection
[ ] Context priorities exist.
[ ] Recency is considered.
[ ] Duplicate information can be removed.
[ ] Low-value information can be dropped.
[ ] Critical information is protected.
Compaction
[ ] Basic deterministic compaction exists.
[ ] Older context can be summarized.
[ ] Important task state survives compaction.
[ ] Compaction metrics are recorded.
[ ] Agent can continue after compaction.
Observability
[ ] Context metrics are logged.
[ ] Truncation is logged.
[ ] Dropped context is logged.
[ ] Compaction is logged.
[ ] Debug context mode exists.
Testing
[ ] Unit tests pass.
[ ] Integration tests pass.
[ ] Stress tests pass.
[ ] Long-context tests pass.
[ ] Existing Iteration 1 tests still pass.
[ ] Evaluation tasks have been executed.
[ ] Failures have been analyzed.
Documentation
[ ] README updated.
[ ] Configuration documented.
[ ] IMPLEMENTATION_PROGRESS.md updated.
[ ] Architecture changes documented.

65. Definition of Done
The iteration is considered complete only when this flow works:
User Task
    ↓
Agent Loop
    ↓
Context Manager
    ↓
Select Relevant Context
    ↓
Estimate Tokens
    ↓
Truncate / Drop / Compact if required
    ↓
LLM
    ↓
Tool Call
    ↓
Tool Result
    ↓
Context Manager
    ↓
Updated Managed Context
    ↓
LLM
    ↓
...
    ↓
Verification
    ↓
Completed Task

The agent must be able to perform a sufficiently long coding task without allowing its LLM context to grow indefinitely.

66. Learning Deliverables
At the end of Iteration 2, the developer/coding agent must produce a short engineering note answering:
Question 1
What information did the agent generate during a long task?
Question 2
What information was actually sent to the model?
Question 3
What information was removed?
Question 4
Why was it removed?
Question 5
What information was most important to preserve?
Question 6
How much context was saved?
Question 7
Did context reduction affect task success?
Question 8
What failures were caused by context management?
Question 9
What should be improved in Iteration 3?
This is a learning project, so these observations are part of the deliverable.

67. Expected Iteration 2 Outcome
At the end of Iteration 2, Engineering Agent should have evolved from:
"Keep adding everything to the conversation."

to:
"Maintain a managed working context containing the
most useful information required for the next decision."

The important architectural lesson should be:
Agent intelligence
        ≠
Only the LLM

Agent intelligence
        =
LLM
+
Tools
+
State
+
Context Management
+
Verification

Iteration 2 specifically teaches the role of:
Context Management

without prematurely introducing RAG, memory, sub-agents, or other advanced mechanisms.

68. Next Iteration Boundary
Do not implement Iteration 3 as part of this work.
Iteration 3 will focus on:
Repository Navigation and Information Discovery
Its question will be:
"Where should the agent look to find the information it needs?"

Iteration 2's question is:
"What information should the agent keep and send to the LLM?"

Keep these concerns separate.

69. Final Instruction to the Coding Agent
Implement this iteration incrementally.
For every phase:
Implement
→ Unit test
→ Run tests
→ Update IMPLEMENTATION_PROGRESS.md
→ Inspect behavior
→ Continue

Never implement the entire iteration blindly and test only at the end.
Do not introduce unrelated features.
Do not replace working Iteration 1 components without a technical reason.
When a test fails:
Stop
→ Identify root cause
→ Classify failure
→ Fix underlying problem
→ Rerun relevant tests
→ Continue

When all implementation and evaluation criteria are complete:
Run full test suite
→ Run full evaluation suite
→ Perform failure analysis
→ Confirm no regression
→ Update IMPLEMENTATION_PROGRESS.md
→ Mark Iteration 2 complete

Iteration 2 should leave the repository in a fully working, testable state before Iteration 3 begins.


