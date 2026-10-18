Engineering Agent — Iteration 1 Technical Implementation Plan
1. Iteration 1 Goal
Build the minimum working coding agent that can:
Accept a coding task from the CLI.
Send the task to an LLM.
Let the LLM choose from a small set of tools.
Inspect a repository.
Read files.
Search files/code.
Modify files.
Run a command/test.
Observe the result.
Continue the agent loop when necessary.
Stop when the task is complete or a safety/iteration limit is reached.
Report what happened.
The objective is not to build a feature-rich coding agent.
The objective is to create the smallest complete system that demonstrates the real coding-agent loop.

2. MVP Definition
The MVP consists of:
CLI
 |
 v
Agent Runtime
 |
 +---- Agent Loop
 |
 +---- Context
 |
 +---- LLM Interface
 |       |
 |       +---- Gemini Provider
 |
 +---- Tool Registry
         |
         +---- Search
         +---- Read File
         +---- Edit/Write File
         +---- Run Command

The MVP must work against a real local repository.

3. Technology
Required
TypeScript
Node.js
npm
CLI application
Git for source control
Gemini API as the first provider
Recommended libraries
Use simple, well-maintained libraries rather than building infrastructure unnecessarily.
Suggested:
TypeScript
Node.js
tsx for development execution
vitest for tests
zod for input validation
Gemini's official JavaScript/TypeScript SDK for the Gemini adapter
Native Node.js filesystem/process APIs where practical
Do not introduce an agent framework.
The purpose of this project is to implement the agent runtime ourselves.

4. Provider Independence
The most important architectural rule is:
The Agent Loop must not know which LLM provider is being used.
The architecture should be:
Agent Loop
    |
    v
LLM Interface
    |
    v
Provider Adapter
    |
    v
Gemini API

Later:
LLM Interface
    |
    +-- Gemini
    +-- OpenAI
    +-- Claude
    +-- Groq
    +-- Local Model

Only the Gemini adapter should contain Gemini-specific API code.
Do not call the Gemini SDK directly from:
Agent Loop
Tools
CLI
Context Manager
Evaluation code

5. Suggested Project Structure
Create the project approximately as follows:
engineering-agent/
│
├── src/
│   ├── cli/
│   │   └── main.ts
│   │
│   ├── agent/
│   │   ├── agent.ts
│   │   ├── loop.ts
│   │   └── state.ts
│   │
│   ├── llm/
│   │   ├── types.ts
│   │   ├── provider.ts
│   │   └── gemini.ts
│   │
│   ├── tools/
│   │   ├── types.ts
│   │   ├── registry.ts
│   │   ├── read-file.ts
│   │   ├── search.ts
│   │   ├── edit-file.ts
│   │   └── run-command.ts
│   │
│   ├── context/
│   │   └── context.ts
│   │
│   ├── safety/
│   │   └── policy.ts
│   │
│   └── logging/
│       └── logger.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
│
├── eval/
│   └── tasks/
│
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md

The implementation can change this structure if there is a strong technical reason, but responsibilities should remain separated.

6. Core Data Types
Create internal types that are independent of Gemini.
Message
Conceptually:
Message
- role
- content
- optional tool call
- optional tool result

Supported roles initially:
system
user
assistant
tool

Tool Call
ToolCall
- id
- toolName
- arguments

Tool Result
ToolResult
- toolCallId
- success
- output
- error

LLM Response
LLMResponse
- type: "text" | "tool_call"
- text?
- toolCall?
- usage?

The exact TypeScript representation is up to the developer, but the provider adapter must convert Gemini responses into these internal structures.

7. LLM Interface
Define a provider-independent interface.
Conceptually:
LLMProvider.generate(
    messages,
    tools,
    options
) -> LLMResponse

The interface should support:
Messages
Tool definitions
Model name
Temperature/configuration where supported
Maximum output configuration where supported
Usage information where available
The interface should also normalize provider errors.
For example:
ProviderError
- type
- message
- retryable
- provider

Do not expose Gemini-specific response objects outside the Gemini adapter.

8. Gemini Adapter
Implement the first provider using Gemini.
Responsibilities:
Read API configuration securely.
Convert internal messages to Gemini format.
Convert internal tool definitions to Gemini function/tool definitions.
Send the request.
Parse normal text responses.
Parse tool calls.
Convert usage information into the internal format.
Normalize errors.
Configuration should come from environment/configuration rather than source code.
Example:
GEMINI_API_KEY
GEMINI_MODEL

Do not commit API keys.

9. Tool Interface
Every tool should implement the same conceptual contract:
Tool
- name
- description
- input schema
- execute(input, context)

The tool registry should provide:
register(tool)
get(toolName)
list()

The Agent Loop should ask the registry for tools.
It should not directly instantiate individual tools.

10. MVP Tools
Only four capabilities are required.
Tool 1 — Search
Purpose:
Find relevant files/code before reading them.
Input:
query
path?
filePattern?
maxResults?

Output:
file
line
matching text

Requirements:
Search only inside the workspace.
Limit number of results.
Limit total output size.
Clearly indicate when results were truncated.
Handle no results cleanly.
Use an existing local search command if appropriate rather than implementing a complete code-search engine.

11. Tool 2 — Read File
Input:
path
startLine?
endLine?

Requirements:
Workspace boundary check.
File existence check.
Maximum output size.
Clear error messages.
Support reading only part of a file.
The tool should discourage unnecessarily loading huge files.
If output is truncated, return something like:
[Output truncated. File contains additional content.]


12. Tool 3 — Edit/Write File
The MVP should support creating and modifying files.
Prefer targeted edits where practical.
Input should contain enough information to make the change unambiguous.
For example:
path
operation
content / edit instructions

Requirements:
Validate workspace path.
Reject unsafe paths.
Detect invalid edit requests.
Return success/failure.
Record modified files.
Do not silently modify unrelated files.
For MVP, simple deterministic editing is preferable to building a complex patch engine.

13. Tool 4 — Run Command
Purpose:
Allow the agent to verify its work.
Input:
command
workingDirectory?
timeout?

Output:
exitCode
stdout
stderr
timedOut

Requirements:
Workspace restriction.
Timeout.
Output limit.
Capture stdout/stderr.
Return exit code.
Clearly distinguish successful execution from command failure.
Do not initially allow unrestricted dangerous commands.
Create a simple command policy.
Examples of potentially allowed commands:
npm test
npm run test
npm run build
npm run lint
node ...

The exact policy should be configurable.

14. Agent State
The MVP needs only simple task state.
Example:
AgentState
- taskId
- userRequest
- workspace
- messages
- iterationCount
- modifiedFiles
- executedCommands
- status

Status:
running
completed
failed
cancelled

Do not build persistent memory yet.

15. Agent Loop Implementation
The core loop should behave approximately as follows:
START
 |
 v
Create task state
 |
 v
Create initial context
 |
 v
Send request + tools to LLM
 |
 v
Receive response
 |
 +------ Text ------> Is task complete?
 |                         |
 |                         +-- Yes --> Verify --> Finish
 |                         |
 |                         +-- No --> Continue
 |
 +---- Tool Call
          |
          v
     Validate tool
          |
          v
     Safety check
          |
          v
     Execute tool
          |
          v
     Capture result
          |
          v
     Add result to context
          |
          v
     Increment iteration
          |
          v
     Send context to LLM

This is the most important component of Iteration 1.

16. Loop Limits
The agent must never run forever.
Add:
MAX_AGENT_ITERATIONS

For MVP, use a conservative default such as:
20 iterations

The limit should be configurable.
If the limit is reached:
status = failed
reason = iteration_limit

The final response must clearly say that the agent stopped because it reached its limit.

17. Repeated Failure Protection
The MVP should detect obvious repeated failures.
Example:
Agent:
run npm test

Result:
test failed

Agent:
run npm test

Result:
same failure

Agent:
run npm test

This should not continue indefinitely.
Track repeated identical or substantially identical actions.
After a configurable number of repeated failures, stop and report:
Agent stopped because the same failing action was repeated.

More sophisticated recovery can be added later.

18. Context for MVP
Do not implement sophisticated context management yet.
The MVP context should contain:
System instructions
+
User task
+
Available tools
+
Previous assistant responses
+
Tool calls
+
Tool results

However, basic limits must exist.
At minimum:
Maximum tool output size
Maximum file-read size
Maximum conversation/iteration limit
Do not implement RAG, embeddings, vector databases, or advanced compaction in Iteration 1.
The purpose is to establish the baseline before adding those capabilities.

19. Initial System Instructions
Create a simple system prompt.
It should tell the model:
It is a coding agent.
It has access to the provided tools.
It should inspect before modifying.
It should make minimal changes.
It should use search before reading large amounts of code.
It should run relevant tests after changes.
It should not claim success without verification.
It should not use unavailable tools.
It should stop when the task is complete.
Keep this prompt short.
Do not attempt to reproduce Claude Code or Pi system prompts.

20. Basic Safety Policy
The MVP must have basic protection.
File safety
Allow:
workspace/**

Reject:
../../outside-workspace

Resolve paths before accessing them.
Command safety
Commands should pass through a policy before execution.
The policy should be able to return:
ALLOW
DENY
CONFIRM

For MVP:
Safe development commands → ALLOW
Clearly destructive commands → DENY
Higher-risk commands → CONFIRM or DENY
The exact policy should be easy to extend later.

21. CLI
The first CLI should be extremely simple.
Example:
engineering-agent "Fix the failing test in calculator.ts"

Optional:
engineering-agent --workspace ./my-project "Fix the failing test"

Optional configuration:
engineering-agent --model <model> "Add validation to the user service"

The CLI should display useful progress such as:
Task: Fix the failing test

→ Thinking
→ Search: calculator
→ Read: src/calculator.ts
→ Edit: src/calculator.ts
→ Run: npm test
→ Test passed

Task completed.

Do not build a web UI.

22. Logging
For every agent run, log structured events.
At minimum:
task_started
llm_request
llm_response
tool_requested
tool_started
tool_completed
tool_failed
verification_started
verification_completed
task_completed
task_failed

The log should include:
Task ID
Timestamp
Iteration number
Tool name
Success/failure
Duration
Output size
Token usage if available
Never log API keys.

23. Task Progress Checklist
Maintain a progress file at the repository root:
IMPLEMENTATION_PROGRESS.md

This file must contain a checklist of every implementation, testing, evaluation, and acceptance task in this plan.
Use GitHub-style checkboxes:
- [ ] Create TypeScript/Node project
- [ ] Implement internal LLM types/interfaces
- [x] Implement Gemini provider adapter

Requirements:
Add one checklist item for every meaningful task.
Mark an item [x] only after the task is actually completed and verified.
Keep incomplete, blocked, or partially completed items as [ ].
Add a short Status, Notes, or Next action section when useful.
Record blockers, failed attempts, and the exact next step when work is interrupted.
Update this file after completing each implementation or verification step, not only at the end.
Before starting work, read this file to determine what remains pending.
If an agent is interrupted, the next agent must be able to resume from this file without reconstructing progress from chat history.
Do not mark a parent task complete while any required subtask remains incomplete.
Include the current date or timestamp for significant progress updates.
Keep the checklist synchronized with the actual repository state.
The progress file should include, at minimum:
# Implementation Progress

## Current Status

- Overall status: Not started
- Current step: Step 1
- Last updated: YYYY-MM-DD
- Next action: Create the TypeScript/Node project

## Checklist

### Project Setup
- [ ] Create TypeScript/Node project
- [ ] Create project structure
- [ ] Add package scripts
- [ ] Add `.env.example`
- [ ] Add `.gitignore`

### Core Runtime
- [ ] Create internal LLM types/interfaces
- [ ] Implement Gemini provider adapter
- [ ] Create tool interface and registry
- [ ] Implement basic context
- [ ] Implement agent state
- [ ] Implement agent loop
- [ ] Implement iteration limits
- [ ] Implement repeated-failure protection

### Tools
- [ ] Implement Read File
- [ ] Implement Search
- [ ] Implement Edit/Write
- [ ] Implement Run Command
- [ ] Implement file safety policy
- [ ] Implement command safety policy

### CLI and Observability
- [ ] Implement CLI
- [ ] Implement structured logging
- [ ] Display progress and final status

### Testing
- [ ] Write LLM unit tests
- [ ] Write Search unit tests
- [ ] Write Read File unit tests
- [ ] Write Edit/Write unit tests
- [ ] Write Run Command unit tests
- [ ] Write Agent Loop unit tests
- [ ] Create integration test fixture
- [ ] Run integration test

### Evaluation
- [ ] Create evaluation task 1
- [ ] Create evaluation task 2
- [ ] Create evaluation task 3
- [ ] Create evaluation task 4
- [ ] Create evaluation task 5
- [ ] Run evaluation tasks
- [ ] Perform failure analysis
- [ ] Fix MVP issues
- [ ] Repeat evaluation

### Acceptance
- [ ] Verify all MVP success criteria
- [ ] Commit the completed MVP
- [ ] Record final Iteration 1 status


24. Unit Testing
Before testing the complete agent, implement unit tests for each component.
LLM
Test:
Normal response parsing
Tool-call parsing
Provider error handling
Invalid response handling
Mock the provider API.
Search
Test:
Match found
No match
Maximum results
Output truncation
Workspace restriction
Read File
Test:
Existing file
Missing file
Partial read
Large file
Outside workspace
Edit/Write
Test:
Create file
Modify file
Invalid path
Invalid input
Workspace restriction
Run Command
Test:
Successful command
Failed command
Timeout
Output capture
Command policy rejection
Agent Loop
Test:
LLM → tool → result → LLM → final response

Use a mocked LLM.
Also test:
Tool failure
Provider failure
Iteration limit
Repeated failure
Final verification
Update IMPLEMENTATION_PROGRESS.md after each test group is implemented and passing.

25. Integration Test
Create a small test repository fixture.
Example:
test-project/
├── src/
│   └── calculator.ts
├── tests/
│   └── calculator.test.ts
└── package.json

Introduce a deliberate small bug.
Example task:
Fix the failing calculator test.
The agent should:
Search
 ↓
Read
 ↓
Understand
 ↓
Edit
 ↓
Run test
 ↓
Observe result
 ↓
Finish

This becomes the first complete end-to-end test.
Record the integration test result in IMPLEMENTATION_PROGRESS.md.

26. Agent Evaluation Task Set
Create at least 5 small coding tasks.
Each task must have:
Task ID
Repository fixture
User request
Expected behavior
Expected verification command
Success criteria

Suggested tasks:
Task 1 — Bug Fix
Fix a small incorrect calculation.
Task 2 — Add Function
Add a missing function with a provided test.
Task 3 — Modify Existing Function
Change existing behavior without breaking current tests.
Task 4 — Test Failure Diagnosis
Identify why a test fails and fix it.
Task 5 — Small Refactor
Refactor a small piece of code while preserving tests.
Keep the tasks small enough that failures can be understood manually.
Track each task's creation and validation status in IMPLEMENTATION_PROGRESS.md.

27. Agent Test Procedure
Every evaluation task should follow:
1. Reset repository to clean state
2. Start agent
3. Give exact task
4. Record agent actions
5. Allow agent to complete
6. Run independent verification
7. Compare expected vs actual result
8. Record success/failure
9. Analyze failure if unsuccessful
10. Repeat the task

The independent verification step is important.
Do not trust the agent's final message as the test result.
Record the outcome of every run in the progress file or linked evaluation report so that an interrupted agent can resume evaluation without losing completed results.

28. Multiple Test Rounds
A single successful run does not prove reliability.
For the initial benchmark:
Run each task multiple times

Record:
Success/failure
Number of iterations
Tool calls
Test result
Time
Token usage if available
Failure type
Example:
Task: Fix calculator bug

Run 1: PASS
Run 2: PASS
Run 3: FAIL
Run 4: PASS
Run 5: PASS

Success rate: 80%

The exact number of repetitions can be adjusted based on API limits.
Update the checklist after each task and test round, including partial results.

29. Failure Analysis
When an agent test fails, do not immediately modify the implementation.
First identify:
What did the agent believe?
What did it do?
What should it have done?
Where did the first incorrect decision occur?

Classify the failure.
Initial categories:
UNDERSTANDING
SEARCH
FILE_SELECTION
TOOL_SELECTION
TOOL_INPUT
CODE_CHANGE
TEST_INTERPRETATION
RECOVERY
CONTEXT
SAFETY
FALSE_SUCCESS
LOOP
PROVIDER

Example:
Task:
Fix parser bug

Failure:
Agent modified parser.test.ts instead of parser.ts

Category:
FILE_SELECTION

First incorrect action:
Selected test file as implementation target

Likely cause:
Insufficient repository inspection

Potential improvement:
Improve search/instruction/context

This analysis becomes input to the next development decision.
Record each failure analysis and resulting action in IMPLEMENTATION_PROGRESS.md.

30. MVP Success Criteria
Iteration 1 is successful only when all of the following work:
Core
CLI starts successfully.
User can provide a coding task.
LLM provider can be changed through configuration/interface.
Gemini adapter works.
Agent loop executes multiple iterations.
Tool calls work.
Tool results return to the LLM.
Agent can modify code.
Agent can execute a verification command.
Agent can complete a small coding task.
Safety
Workspace boundaries work.
Command policy works.
Iteration limit works.
Repeated-failure protection works.
Testing
Unit tests pass.
Integration tests pass.
At least five agent evaluation tasks exist.
Independent verification is used.
Failures are classified.
Observability
Agent actions are logged.
Tool calls are visible.
Iteration count is visible.
Final result clearly indicates success/failure.
Progress Tracking
IMPLEMENTATION_PROGRESS.md exists.
Every implementation step has a checklist item.
Completed tasks are marked [x].
Pending and partially completed tasks remain [ ].
The file identifies the current step and next action.
An interrupted agent can resume from the progress file.

31. What NOT to Build in Iteration 1
Do not add:
RAG
Vector database
Embeddings
Persistent memory
Sub-agents
Model routing
Automatic model switching
MCP
Complex planning
Complex skill system
Plugin marketplace
Web UI
Autonomous background execution
Automatic Git push
Sophisticated context compaction
Large-scale repository indexing
These are deliberately deferred.
The purpose of Iteration 1 is to establish the baseline.

32. Git in Iteration 1
Git should be used for the Engineering Agent project's own source code, but advanced Git-agent capabilities are deferred.
The developer should:
git init
git add .
git commit -m "Initial Engineering Agent MVP"

The implementation should be committed after the MVP passes its tests.
A remote push can be performed manually by the developer:
git remote add origin <repository>
git push -u origin main

Do not build automatic git commit or git push agent tools in Iteration 1.
Update IMPLEMENTATION_PROGRESS.md before and after the MVP commit, including the commit hash once available.

33. Implementation Order
The coding agent should implement in this order:
Step 1
Create TypeScript/Node project and initialize IMPLEMENTATION_PROGRESS.md.
Step 2
Create project structure.
Step 3
Create internal LLM types/interfaces.
Step 4
Implement Gemini provider adapter.
Step 5
Create tool interface and registry.
Step 6
Implement Read File.
Step 7
Implement Search.
Step 8
Implement Edit/Write.
Step 9
Implement Run Command with safety policy.
Step 10
Implement basic context.
Step 11
Implement Agent Loop.
Step 12
Implement iteration limits and repeated-failure protection.
Step 13
Implement CLI.
Step 14
Implement structured logging.
Step 15
Write unit tests.
Step 16
Create test repository fixtures.
Step 17
Run integration tests.
Step 18
Run the five real agent evaluation tasks.
Step 19
Perform failure analysis.
Step 20
Fix MVP issues.
Step 21
Run the evaluation again.
Step 22
Accept Iteration 1 only when the acceptance criteria are satisfied.
After each step, update IMPLEMENTATION_PROGRESS.md with:
Completed checklist items
Current status
Files changed
Tests run
Any blockers
The next action

34. Definition of Done
Iteration 1 is DONE only when this scenario works:
User
 |
 | "Fix this bug"
 v
CLI
 |
 v
Agent
 |
 v
LLM
 |
 | "Search calculator.ts"
 v
Search Tool
 |
 v
Result
 |
 v
LLM
 |
 | "Read calculator.ts"
 v
Read Tool
 |
 v
Result
 |
 v
LLM
 |
 | "Edit calculator.ts"
 v
Edit Tool
 |
 v
LLM
 |
 | "Run npm test"
 v
Run Command
 |
 v
Test Result
 |
 v
LLM
 |
 v
Verified Final Result

The system must perform this flow against a real repository.
IMPLEMENTATION_PROGRESS.md must show every required task as completed, with no unresolved blockers, before Iteration 1 is accepted.

35. Learning Outcome
At the end of Iteration 1, we should be able to answer from our own implementation:
What is an agent loop?
How does an LLM request a tool?
How does the tool result return to the LLM?
How does the agent decide its next action?
How does the agent know when to stop?
How do we prevent infinite loops?
How do we restrict dangerous actions?
How does the agent inspect a repository without reading everything?
How does the agent verify its changes?
How much context/tokens does a simple coding task consume?
Where does the agent fail?
Which failures come from the model and which come from our agent design?
How can another coding agent resume interrupted work from the progress checklist?
Which implementation steps are complete, pending, blocked, or partially complete?
These questions are more important than adding more features.

36. Next Iteration Decision
After Iteration 1, do not automatically start Iteration 2.
First review:
Evaluation success rate
Failure categories
Token usage
Tool usage
Context size
Repeated actions
Verification failures
Developer experience
Completeness of IMPLEMENTATION_PROGRESS.md
Then select the next component based on the observed problems.
The next iteration will most likely address context management, but this decision should be supported by Iteration 1 evidence.


