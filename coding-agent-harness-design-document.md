Engineering Agent — System Design Document
1. Purpose
Engineering Agent is an independent, provider-agnostic coding agent built from the ground up to understand how coding agents work.
The system will be developed incrementally through working implementations, repeatable tests, agent-task evaluations, and failure analysis.
The primary objective is learning through implementation:
Build a minimal working coding agent, understand each important component through implementation and testing, and gradually evolve it into a capable and extensible agent.
The system is not intended to clone Pi, Claude Code, GitHub Copilot, or any other existing product.

2. System Goals
Engineering Agent should:
Accept coding tasks through a CLI
Inspect repositories and source code
Search for relevant files and symbols
Read selected file content
Modify or create files
Execute commands and tests
Interpret tool results
Recover from failures
Maintain useful task context
Verify changes before reporting success
Support multiple LLM providers
Provide structured logging and evaluation
Remain extensible as new capabilities are added
The system should prioritize transparency, testability, safety, and learning over feature count.

3. Non-Goals
The initial system will not attempt to:
Replace established coding agents
Depend on a single LLM provider
Read entire repositories by default
Automatically perform unsafe operations
Add RAG, memory, sub-agents, or complex planning before the core loop is understood
Optimize for maximum autonomy before reliability is established
Treat every proposed feature as necessary
Future capabilities must be justified by learning value, practical value, or measurable improvement.

4. High-Level Architecture
The system will use the following logical architecture:
User
  |
  v
CLI Interface
  |
  v
Agent Runtime
  |
  +--> Context Manager
  |
  +--> Agent Loop
  |      |
  |      +--> LLM Interface
  |      |      |
  |      |      +--> Provider Adapter
  |      |             |
  |      |             +--> Model API
  |      |
  |      +--> Tool Registry
  |             |
  |             +--> File Tools
  |             +--> Search Tools
  |             +--> Command Tools
  |             +--> Git Tools
  |
  +--> Verification and Evaluation
  |
  +--> Logging and Failure Analysis

The architecture should keep the agent loop independent from provider-specific APIs and tool implementation details.

5. Core Components
5.1 CLI Interface
The CLI is the primary user-facing interface for the MVP.
Responsibilities:
Accept a user task
Select or validate the working directory
Configure the provider and model
Display agent progress
Display tool actions and results
Report final status
Support debug or verbose logging
Return an appropriate process exit code
Example usage:
engineering-agent "Fix the failing test in the parser module"

The CLI should not contain agent reasoning logic. It should delegate execution to the agent runtime.

5.2 Agent Runtime
The agent runtime coordinates the major system components.
Responsibilities:
Create a task session
Initialize context
Start the agent loop
Register available tools
Enforce execution limits
Track task state
Trigger verification
Produce a final result
Record structured events
The runtime should provide a stable boundary between the CLI and the internal agent implementation.

5.3 LLM Interface
The LLM interface provides a provider-independent abstraction.
Conceptually:
Agent Loop
    |
    v
LLM Interface
    |
    v
Provider Adapter
    |
    v
Model

The interface should support:
Sending conversation messages
Supplying tool definitions
Receiving text responses
Receiving structured tool calls
Reporting usage metadata when available
Handling provider errors
Supporting configurable model parameters
A provider adapter must translate between the internal interface and the provider's API format.
The agent loop must not directly import or depend on Gemini, OpenAI, Claude, or another provider SDK.

5.4 Provider Adapters
The first provider adapter will target Gemini.
Future adapters may support:
OpenAI
Claude
Groq
Local models
Other compatible providers
Each adapter is responsible for:
Authentication
Request formatting
Tool-call translation
Response parsing
Error normalization
Usage reporting
Provider-specific retry behavior
Changing providers should not require changes to the agent loop, tools, context manager, or evaluation framework.

5.5 Agent Loop
The agent loop is the core execution mechanism.
Basic flow:
1. Receive user request
2. Build the initial context
3. Send context and available tools to the LLM
4. Inspect the LLM response
5. If the response requests a tool:
   a. Validate the tool call
   b. Apply safety checks
   c. Execute the tool
   d. Record the result
   e. Add the result to context
   f. Continue the loop
6. If the response contains a final answer:
   a. Run required verification
   b. Determine whether the task is complete
   c. Return the result
7. Stop on success, failure, cancellation, or configured limits

The loop must support:
Maximum iteration limits
Tool-call validation
Tool execution errors
Provider errors
Repeated failed actions
Cancellation
Context limits
Explicit completion status
Verification before success
The agent must not declare a coding task successful solely because the LLM produced a confident final message.

5.6 Tool Registry
Tools should be registered through a common interface.
Each tool should define:
Name
Description
Input schema
Execution function
Permission requirements
Output limits
Error behavior
Safety classification
The tool registry should allow tools to be added or removed without modifying the agent loop.
Initial tools:
Read file
Search files
Search code
Write file
Edit file
Run command
Future tools:
File discovery
Symbol navigation
Git status
Git diff
Git commit
Git push
External knowledge retrieval
Memory access
Sub-agent delegation

6. Initial Tool Design
6.1 Read File
Purpose:
Read a selected file or file section
Avoid loading unnecessary repository content
Limit output size
Inputs may include:
File path
Start line
End line
Maximum output size
Safety requirements:
Restrict access to the configured workspace by default
Reject paths outside the workspace unless explicitly permitted
Report missing files clearly
Truncate oversized output with an explicit notice

6.2 Search Files and Code
Purpose:
Locate relevant files, symbols, strings, and patterns
Encourage search-before-read behavior
Reduce unnecessary context usage
Inputs may include:
Search query
Search path
File pattern
Case sensitivity
Maximum results
The tool should return concise, structured results containing:
File path
Line number
Matching text or symbol
Result count
Truncation status

6.3 Write or Edit File
Purpose:
Create or modify source files
Apply targeted changes
Preserve unrelated content
The system should prefer precise edits over replacing entire files.
Safety requirements:
Validate paths
Record the original state when possible
Show or log the intended change
Reject malformed edit requests
Prevent accidental writes outside the workspace
Support dry-run behavior in future versions

6.4 Run Command
Purpose:
Execute tests, builds, linters, formatters, and other development commands
Provide feedback for verification and recovery
Inputs may include:
Command
Working directory
Timeout
Environment configuration
Safety requirements:
Apply command restrictions
Enforce timeouts
Capture stdout and stderr
Limit output size
Record exit code
Distinguish timeout, failure, and successful execution
Require confirmation for high-risk commands when appropriate
The initial implementation should use an explicit command policy rather than unrestricted shell access.

7. Context Management
Context management is responsible for deciding what information is sent to the LLM.
The initial context should include:
System instructions
User request
Current task state
Available tools
Relevant tool results
Relevant file content
Verification results
Important failure information
The system should avoid:
Reading the entire repository
Repeating identical tool results
Including irrelevant files
Sending unbounded command output
Retaining every historical message indefinitely
Future context capabilities include:
Token estimation
Context budgets
Relevance-based selection
Output truncation
Context compaction
State preservation
Resume support
Input/output usage measurement
The system must distinguish between:
Active context: information currently supplied to the model
Persistent memory: information stored for future tasks or sessions

These are separate capabilities and should not be conflated.

8. Task State
Each task session should maintain explicit state.
Possible state fields:
Task identifier
User request
Workspace path
Current phase
Conversation history
Tool-call history
Files inspected
Files modified
Commands executed
Verification results
Failure classifications
Token usage
Iteration count
Completion status
Cancellation status
Example task phases:
initialized
investigating
planning
editing
verifying
recovering
completed
failed
cancelled

The MVP may use a simple state model. More advanced planning and resume behavior can be added later.

9. Verification
Verification is required before a task is considered complete.
Verification may include:
Running targeted tests
Running the project test suite
Running a build
Running a linter
Inspecting the resulting diff
Confirming expected files changed
Checking that unrelated files were not modified
The verification strategy should depend on the task and repository.
A successful final response should distinguish between:
Changes made
Verification performed
Verification passed
Verification failed
Verification not performed
Remaining uncertainty
The agent must not claim that a task is complete when verification failed or was skipped without clearly stating that fact.

10. Error Handling and Recovery
Errors should be represented as structured events rather than plain text whenever possible.
Error categories include:
Invalid tool input
Missing file
Search failure
File write failure
Command failure
Command timeout
Provider failure
Authentication failure
Rate limit
Context overflow
Tool permission denial
Repeated action
Agent iteration limit
Unsafe operation attempt
Recovery behavior may include:
Returning the error to the LLM
Retrying transient provider failures
Asking for clarification
Adjusting the command or tool input
Reducing output size
Replanning the task
Stopping after repeated failure
Reporting incomplete work
The system should prevent infinite loops by tracking repeated actions and enforcing iteration limits.

11. Safety Model
Safety should be introduced early and strengthened over time.
Initial safety controls:
Workspace boundary enforcement
Command allowlist or policy
Timeouts
Output limits
Maximum agent iterations
Tool input validation
Explicit logging
No automatic Git push
No destructive operations by default
Higher-risk operations should require explicit confirmation or a future permission mechanism.
Examples:
Deleting files
Modifying files outside the workspace
Installing packages
Changing system configuration
Running network commands
Committing changes
Pushing changes
Executing destructive shell commands
The agent should favor reversible actions and provide enough information for the user to understand what occurred.

12. Logging and Observability
The system should produce structured logs for each task.
Important events include:
Task started
User request received
LLM request sent
LLM response received
Tool selected
Tool input validated
Tool started
Tool completed
Tool failed
File changed
Command executed
Verification started
Verification completed
Context compacted
Retry performed
Failure classified
Task completed
Task failed
Logs should support:
Debugging
Performance analysis
Token analysis
Failure analysis
Reproducibility
Evaluation comparison
Sensitive information such as API keys must never be written to logs.

13. Evaluation Framework
Evaluation must include both software tests and real agent tasks.
13.1 Unit Tests
Unit tests should cover:
LLM interface behavior
Provider adapter translation
Tool input validation
File path safety
Search behavior
File editing
Command execution
Output truncation
Context management
State transitions
Error normalization
Iteration limits
Logging behavior
13.2 Integration Tests
Integration tests should cover:
Agent loop with mocked LLM responses
Tool-call execution
Tool errors returned to the model
Multi-step tasks
Verification behavior
Provider adapter integration
Context-limit behavior
13.3 Agent Task Tests
Agent task tests should use representative coding tasks such as:
Find and fix a small bug
Add a missing function
Update a test
Refactor a small module
Diagnose a failing command
Modify configuration safely
Each task should define:
Initial repository state
User request
Expected files or behavior
Allowed commands
Verification command
Success criteria
Failure categories
Token or time budget where relevant
13.4 Repeatability
A single successful run is insufficient.
Evaluation should measure:
Success rate across repeated runs
Correctness
Unrelated modifications
Verification success
Number of tool calls
Number of retries
Token usage
Execution time
Safety violations
Failure category distribution

14. Failure Analysis Framework
Failures should be classified consistently.
Initial categories:
Request misunderstanding
Incorrect repository navigation
Wrong file selection
Wrong tool selection
Invalid tool input
Incorrect code generation
Unrelated modification
Ignored tool result
Misinterpreted test failure
Repeated failed action
Lost context
Excessive context usage
Unsafe command
Missing verification
False success declaration
Provider failure
Agent loop deadlock
Iteration limit exceeded
Each failure record should include:
Task identifier
Failure category
Relevant events
Last successful action
First incorrect action
Expected behavior
Actual behavior
Likely cause
Proposed improvement
Whether the failure was reproduced
The purpose is to improve the system based on evidence rather than intuition.

15. Development Iterations
Iteration 1 — MVP
Components:
CLI
LLM interface
Gemini adapter
Agent loop
Read file
Search
Edit/write file
Run command
Basic context
Basic error handling
Logging
Unit tests
Real coding-task evaluation
Acceptance criteria:
The agent can inspect a repository
The agent can make a small code change
The agent can run a verification command
The agent reports the result accurately
The system works through the provider abstraction
Repeatable task tests are available
Iteration 2 — Context
Components:
Conversation state
Relevant-file selection
Context limits
Output truncation
Basic token measurement
Acceptance criteria:
The agent avoids unnecessary context
Large outputs are controlled
Important state is preserved
Context behavior is measurable
Iteration 3 — Repository Navigation
Components:
File discovery
Improved search
Symbol navigation
Better repository structure awareness
Acceptance criteria:
The agent finds relevant code more reliably
Repository exploration becomes more efficient
Search and navigation behavior can be evaluated
Iteration 4 — Verification
Components:
Test execution
Command result interpretation
Retry behavior
Failure recovery
Verification policies
Acceptance criteria:
The agent responds appropriately to failed tests
The agent retries or replans when useful
The agent does not report success without verification
Iteration 5 — Planning
Components:
Explicit task plan
Task steps
Step status
Plan updates
Acceptance criteria:
Planning behavior is measurable
Planning improves or does not improve task outcomes based on evidence
Failed plans can be revised
Iteration 6 — Skills
Components:
Reusable instructions
Task-specific behavior
Skill discovery and selection
Acceptance criteria:
Skills can modify behavior without core-code changes
Skill usage is observable
Skills can be evaluated against a baseline
Iteration 7 — Extensions
Components:
Configurable tools
Extension loading
Capability registration
Acceptance criteria:
New tools can be added without modifying the agent loop
Extensions have clear interfaces and safety rules
Iteration 8 — Git
Components:
Git status
Git diff
Repository initialization
Commit
Push
Safety requirements:
Inspect changes before committing
Verify implementation before committing
Require explicit rules for commit and push
Do not push automatically by default
Acceptance criteria:
Git actions are observable
Unsafe or premature commits are prevented
Commit and push behavior is tested separately
Iteration 9 — Sub-Agents
Components:
Delegation
Separate task contexts
Result aggregation
Delegation limits
Acceptance criteria:
Delegation has measurable benefits
Sub-agent failures are isolated
The main agent can interpret and verify delegated results
Iteration 10 — RAG Experiment
Components:
Retrieval
External or project knowledge sources
Retrieval configuration
Comparison evaluation
Evaluation:
Agent without RAG
versus
Agent with RAG

RAG should be accepted only if it produces measurable improvement for selected tasks.
Iteration 11 — Memory
Components:
Persistent useful information
Session resume
Memory retrieval
Memory update rules
Acceptance criteria:
Persistent memory is distinct from active context
Stored information is useful and controlled
Incorrect or stale memory can be corrected
Iteration 12 — Safety and Evaluation
Components:
Permissions
Safer execution
Stronger evaluation
Failure analysis
Risk-based controls
Acceptance criteria:
High-risk actions are controlled
Evaluation is repeatable
Reliability and safety metrics are tracked

16. Token and Context Efficiency
The system should progressively improve efficiency by:
Searching before reading
Reading only relevant sections
Limiting tool output
Avoiding repeated information
Tracking active context
Compacting older context
Preserving important task state
Resuming without replaying unnecessary history
Measuring input and output tokens
Identifying expensive behaviors
Initial metrics should include:
Input tokens
Output tokens
Total tokens
Tool-call count
Tool-output size
Context size
Number of repeated actions
Time per task
Cost where available
Model routing and switching are not required initially. They may be evaluated later after the basic system is understood.

17. Prioritization Framework
Proposed capabilities should be evaluated using a 2×2 matrix:
                High learning/practical value
                              |
                              |
Low complexity/risk ----------+---------- High complexity/risk
                              |
                              |
                 Low learning/practical value

The matrix should be used when planning iterations or evaluating new feature ideas.
Features should be prioritized when they:
Teach an important agent mechanism
Provide measurable practical value
Have manageable implementation risk
Improve reliability or safety
Enable meaningful evaluation
Features should be deferred when they are fashionable but poorly understood, difficult to evaluate, or unrelated to the project's learning objectives.

18. Evaluation Matrices
18.1 Known / Unknown × Value
Tasks should be classified according to:
How well the problem is understood
How valuable solving it is
This matrix helps select representative evaluation tasks and prioritize learning.
It is a project-level evaluation tool, not a mandatory step for every iteration.
18.2 Reliability / Risk Matrix
Tasks and capabilities should also be evaluated according to:
Likelihood of agent failure
Impact of failure
High-likelihood, high-impact areas should receive stronger controls, more testing, and clearer permissions.
This matrix should be applied selectively, especially to:
File modification
Command execution
Git operations
External access
Persistent memory
Autonomous retries

19. Configuration
Configuration should be externalized where practical.
Potential configuration values:
Provider
Model
API credentials
Workspace path
Maximum iterations
Command timeout
Tool output limits
Context budget
Logging level
Allowed commands
Confirmation policy
Verification commands
Evaluation mode
Configuration should have safe defaults and should not expose secrets through logs or error messages.

20. Project Success Criteria
The project is successful when:
The core agent loop is understood through implementation
The system can complete small coding tasks
Provider-specific code is isolated
Tools are independently testable
Agent behavior is observable
Failures are classified and measured
Verification is part of task completion
Context and token usage are measurable
New capabilities can be added incrementally
Safety controls prevent avoidable destructive actions
Evaluation results guide future development
The primary success criterion is:
Do we understand how a coding agent works because we built and tested its important parts ourselves?
A useful general-purpose coding agent, including one capable of assisting with difficult legacy-code or bug-fixing work, is a valuable secondary outcome.


