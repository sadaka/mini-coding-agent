import type {
  LLMProvider,
  Message,
  ToolCall,
  ToolResultContent,
} from "../types/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import { makeLogger, type LogEvent, type LogSink } from "./logger.js";
import { createNavigationState, type NavigationState, type SearchRecord } from "../navigation/state.js";
import { registerNavigationTools } from "../navigation/index.js";
import { createRepositoryScope } from "../navigation/scope.js";
import { summarizeNavigation, type NavigationMetrics } from "../navigation/metrics.js";
import { ContextManager, BudgetImpossibleError, type ContextManagerEvent } from "../context/context-manager.js";
import { loadContextPolicy, usableInputTokens } from "../context/policies.js";
import { defaultTokenEstimator } from "../context/token-estimator.js";
import type { ContextItem, ImportantFact, ContextStats, ImportanceLevel } from "../context/types.js";

export interface AgentConfig {
  maxIterations?: number;
  repeatFailureThreshold?: number;
  verificationCommand?: string;
  /** When set, the navigation tools are registered for this workspace and a fresh NavigationState is owned by the task. */
  workspaceRoot?: string;
}

export interface AgentState {
  taskId: string;
  task: string;
  currentTaskStatus: "running" | "completed" | "failed";
  importantFacts: ImportantFact[];
  modifiedFiles: string[];
  executedCommands: string[];
  testResults: string[];
  contextStats: ContextStats;
}

export interface AgentResult {
  status: "success" | "failed";
  reason?: string;
  changesMade: string[];
  verificationPerformed: boolean;
  verificationPassed?: boolean;
  finalMessage?: string;
  /** Present only when navigation is enabled (config.workspaceRoot). */
  navigation?: NavigationMetrics;
}

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_REPEAT_THRESHOLD = 3;

const SYSTEM_PROMPT = `You are a coding agent with access to tools for searching, reading, editing files, and running commands.

Guidelines:
- Always inspect code before modifying it.
- Prefer minimal, targeted changes.
- Search before reading large amounts of code.
- To find your way around: list_directory shows the layout (excluded and git-ignored paths are hidden), find_symbol locates where a named class, function or other declaration is defined, find_tests lists test files, search finds text, and read_file can read just a line range. Use whichever answers what you need to know next; none is required first.
- Run the relevant verification command after making changes.
- Never claim success without running verification.
- Never invoke tools that are not available.
- Stop when the task is complete.`;

// Extract readable text from a Message for token estimation
function messageToText(msg: Message): string {
  return msg.content.map((c) => {
    if (c.type === "text") return c.text;
    if (c.type === "tool_call") return `${c.name}(${JSON.stringify(c.input)})`;
    if (c.type === "tool_result") return c.content;
    return "";
  }).join("\n");
}

// Date.now() has millisecond resolution, but an assistant turn and its tool result are
// stored microseconds apart — they routinely collide. A tie makes the chronological sort
// non-deterministic, and a stable sort then preserves whatever order the context builder
// emitted (priority-ordered, newest first), which can place a tool_result before its
// own tool_use. Strictly increasing timestamps make the sort authoritative.
let lastTimestamp = 0;
function monotonicNow(): number {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return lastTimestamp;
}

function makeContextItem(
  id: string,
  msg: Message,
  importance: ImportanceLevel,
  removable: boolean,
  source?: ContextItem["source"],
): ContextItem {
  const content = messageToText(msg);
  return {
    id,
    type: msg.role === "tool" ? "tool_result" : msg.role === "assistant" ? "assistant" : "user",
    content,
    importance,
    createdAt: monotonicNow(),
    tokenEstimate: defaultTokenEstimator.estimate(content),
    removable,
    source,
  };
}

interface Nav {
  state: NavigationState;
  filesRead: Set<string>;
  onDuplicate?: (r: SearchRecord) => void;
}

// [started, completed] events per navigation-related tool (FR-61).
const NAV_EVENTS: Record<string, [LogEvent | null, LogEvent]> = {
  list_directory: [null, "directory_listed"],
  search: ["search_started", "search_completed"],
  find_symbol: ["symbol_search_started", "symbol_search_completed"],
  find_tests: ["test_discovery_started", "test_discovery_completed"],
};

export async function runAgentLoop(
  task: string,
  provider: LLMProvider,
  registry: ToolRegistry,
  config: AgentConfig = {},
  logSink: LogSink = () => {}
): Promise<AgentResult> {
  // One NavigationState per call, so every task starts empty (FR-56).
  const nav: Nav | undefined = config.workspaceRoot
    ? { state: createNavigationState(config.workspaceRoot, (r) => nav?.onDuplicate?.(r)), filesRead: new Set() }
    : undefined;
  const result = await runLoop(task, provider, registry, config, logSink, nav);
  return nav ? { ...result, navigation: summarizeNavigation(nav.state, nav.filesRead) } : result;
}

async function runLoop(
  task: string,
  provider: LLMProvider,
  registry: ToolRegistry,
  config: AgentConfig,
  logSink: LogSink,
  nav: Nav | undefined,
): Promise<AgentResult> {
  const taskId = `task-${Date.now()}`;
  const log = makeLogger(taskId, logSink);
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const repeatThreshold = config.repeatFailureThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  const policy = loadContextPolicy(process.env, {
    maxContextTokens: provider.capabilities?.()?.contextWindowTokens,
  });

  const agentState: AgentState = {
    taskId,
    task,
    currentTaskStatus: "running",
    importantFacts: [],
    modifiedFiles: [],
    executedCommands: [],
    testResults: [],
    contextStats: { totalItems: 0, estimatedTokens: 0, utilization: 0, truncations: 0, compactions: 0, droppedItems: 0 },
  };

  const onContextEvent = (e: ContextManagerEvent) => {
    if (e.type === "truncated") log("context_item_truncated", { detail: e.itemId });
    else if (e.type === "compaction_started") log("context_compaction_started");
    else if (e.type === "compaction_completed") {
      log("context_compaction_completed", { droppedItems: e.droppedItems });
      if (e.droppedItems > 0) log("context_item_dropped", { droppedItems: e.droppedItems });
    }
  };
  const cm = new ContextManager(policy, onContextEvent);
  // Map from ContextItem id → full Message, for reconstruction after selection
  const messageStore = new Map<string, Message>();

  function storeMessage(id: string, msg: Message, importance: ImportanceLevel, removable: boolean, source?: ContextItem["source"]): void {
    const item = makeContextItem(id, msg, importance, removable, source);
    messageStore.set(id, msg);
    cm.addItem(item);
  }

  function buildMessagesForProvider(): Message[] {
    // Same budget the ContextManager compacts against — divergence here meant the
    // builder was handed a window the manager had already shrunk context to fit.
    const selected = cm.buildContext(usableInputTokens(policy));

    // Chronological order is required: Claude (and other providers) enforce that each
    // tool_result block immediately follows its tool_use block. Any reordering across
    // assistant/tool pairs breaks that constraint. Selection (what survives compaction)
    // is handled by ContextManager; ordering here is always chronological.
    const messages = selected
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((item) => messageStore.get(item.id))
      .filter((m): m is Message => m !== undefined);

    // Enforce the provider invariant: every tool_result must sit in the message directly
    // after the tool_use it answers. Checking roles alone is not enough — a reordered or
    // partially-dropped history can put a tool_result after an assistant turn from a
    // *different* iteration, which passes a role check and then fails at the API with
    // "unexpected tool_use_id". So compare the actual ids.
    const callIds = (m: Message | undefined): Set<string> =>
      new Set(m?.content.flatMap((c) => (c.type === "tool_call" ? [c.id] : [])) ?? []);

    const paired: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "assistant" && callIds(msg).size > 0) {
        const next = messages[i + 1];
        const answered = new Set(
          next?.role === "tool"
            ? next.content.flatMap((c) => (c.type === "tool_result" ? [c.toolCallId] : []))
            : [],
        );
        // Every call this turn makes must be answered by the very next message.
        const allAnswered = [...callIds(msg)].every((id) => answered.has(id));
        if (!allAnswered) continue;
      }

      if (msg.role === "tool") {
        const expected = callIds(paired[paired.length - 1]);
        const resultIds = msg.content.flatMap((c) => (c.type === "tool_result" ? [c.toolCallId] : []));
        if (resultIds.length === 0 || !resultIds.every((id) => expected.has(id))) continue;
      }

      paired.push(msg);
    }
    return paired;
  }

  let verificationPerformed = false;
  let verificationPassed: boolean | undefined;

  log("task_started", { detail: task });

  if (nav) {
    const root = config.workspaceRoot!;
    log("repository_scan_started", { operation: "scope", path: root });
    // ponytail: a second scope (one more git probe) just to report exclusions; registerNavigationTools builds its own.
    const { excludedDirs } = createRepositoryScope(root);
    registerNavigationTools(registry, root, nav.state);
    log("navigation_scope_filtered", { operation: "scope", resultCount: excludedDirs.length, detail: `excluded: ${excludedDirs.join(", ")}` });
    log("repository_scan_completed", { operation: "scope", path: root, resultCount: excludedDirs.length });
    nav.onDuplicate = (r) =>
      log("navigation_duplicate_detected", { toolName: r.tool, resultCount: r.count, detail: JSON.stringify(r.input).slice(0, 200) });
  }

  // Initial user message: system prompt + task (critical, non-removable)
  const initMsg: Message = {
    role: "user",
    content: [{ type: "text", text: `SYSTEM:\n${SYSTEM_PROMPT}\n\nTASK:\n${task}` }],
  };
  storeMessage(`${taskId}-init`, initMsg, "critical", false);

  // Track repeated failures: key = "toolName:inputHash", value = count
  const failureCounts = new Map<string, number>();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    log("llm_request", { iteration });

    let messages: Message[];
    try {
      log("context_build_started", { iteration });
      messages = buildMessagesForProvider();
      const cs = cm.getState();
      const budget = (provider.capabilities?.()?.contextWindowTokens ?? policy.maxContextTokens) - policy.reservedOutputTokens;
      log("context_build_completed", { iteration, contextItems: messages.length });
      log("context_metrics", {
        iteration,
        estimatedInputTokens: cs.estimatedInputTokens,
        contextItems: messages.length,
        utilization: budget > 0 ? cs.estimatedInputTokens / budget : 0,
        truncatedItems: cs.truncatedItemCount,
        droppedItems: cs.droppedCount,
        compactions: cs.compactionCount,
      });
    } catch (err) {
      if (err instanceof BudgetImpossibleError) {
        log("task_failed", { iteration, detail: err.message });
        agentState.currentTaskStatus = "failed";
        return { status: "failed", reason: err.message, changesMade: agentState.modifiedFiles, verificationPerformed, verificationPassed };
      }
      throw err;
    }

    let response;
    {
      const maxAttempts = 3;
      let lastErr: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
        try {
          response = await provider.generate(messages, registry.definitions());
          break;
        } catch (err) {
          lastErr = err;
          const provErr = err as { retryable?: boolean };
          if (!provErr.retryable) break;
        }
      }
      if (!response) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        log("task_failed", { iteration, detail: `LLM error: ${msg}` });
        agentState.currentTaskStatus = "failed";
        return { status: "failed", reason: `LLM error: ${msg}`, changesMade: agentState.modifiedFiles, verificationPerformed, verificationPassed };
      }
    }

    log("llm_response", { iteration, detail: response.type });

    if (response.type === "text") {
      const finalMessage = response.text ?? "";
      agentState.currentTaskStatus = "completed";
      log("task_completed", { iteration, success: verificationPassed === true });
      return {
        status: "success",
        changesMade: agentState.modifiedFiles,
        verificationPerformed,
        verificationPassed,
        finalMessage,
      };
    }

    // Tool calls
    const toolCalls = response.toolCalls ?? [];
    const toolResultContents: ToolResultContent[] = [];
    let hasErrors = false;

    for (const toolCall of toolCalls) {
      log("tool_requested", { iteration, toolName: toolCall.name });

      const tool = registry.get(toolCall.name);
      if (!tool) {
        const errContent = `Tool not found: ${toolCall.name}`;
        log("tool_failed", { iteration, toolName: toolCall.name, success: false, detail: errContent });
        toolResultContents.push({ type: "tool_result", toolCallId: toolCall.id, toolName: toolCall.name, content: errContent, isError: true });
        hasErrors = true;
        continue;
      }

      const start = Date.now();
      log("tool_started", { iteration, toolName: toolCall.name });
      const navEvents = nav ? NAV_EVENTS[toolCall.name] : undefined;
      const navPath = typeof toolCall.input.path === "string" ? toolCall.input.path : undefined;
      if (navEvents?.[0]) log(navEvents[0], { iteration, operation: toolCall.name, path: navPath });

      let result;
      try {
        result = await tool.execute(toolCall.input);
      } catch (err) {
        result = { content: `Tool threw: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }

      const durationMs = Date.now() - start;

      if (nav && toolCall.name === "read_file" && navPath) nav.filesRead.add(navPath);
      if (navEvents) {
        const out = {
          iteration,
          operation: toolCall.name,
          path: navPath,
          durationMs,
          resultCount: result.isError ? 0 : result.content.split("\n").filter(Boolean).length,
          outputSize: result.content.length,
          detail: JSON.stringify(toolCall.input).slice(0, 200),
        };
        log(navEvents[1], toolCall.name === "find_symbol" && !result.isError
          ? { ...out, source: result.content.includes("[tree-sitter") ? "tree-sitter" : "fallback" }
          : out);
        if (/\[(Truncated|Scan stopped)/.test(result.content)) {
          log("navigation_result_truncated", { iteration, operation: toolCall.name, path: navPath, outputSize: result.content.length });
        }
      }

      if (toolCall.name === "run_command") {
        const cmd = String(toolCall.input.command ?? "");
        agentState.executedCommands.push(cmd);
        if (/npm test|npm run test|npm run build/.test(cmd)) {
          verificationPerformed = true;
          log("verification_started", { iteration, detail: cmd });
          try {
            const parsed = JSON.parse(result.content) as { exitCode: number };
            verificationPassed = parsed.exitCode === 0;
          } catch {
            verificationPassed = false;
          }
          const summary = `${cmd}: ${verificationPassed ? "passed" : "failed"}`;
          agentState.testResults.push(summary);
          log("verification_completed", { iteration, success: verificationPassed });
        }
      }

      if (result.isError) {
        hasErrors = true;
        log("tool_failed", { iteration, toolName: toolCall.name, success: false, durationMs, detail: result.content });

        // Key on the error, not the input: a tool failing the same way repeatedly is
        // the stuck signal. Keying on input lets near-identical retries (or truncated
        // arguments that differ by a byte) slip past the threshold forever.
        const failKey = `${toolCall.name}:${result.content}`;
        const count = (failureCounts.get(failKey) ?? 0) + 1;
        failureCounts.set(failKey, count);
        if (count >= repeatThreshold) {
          log("task_failed", { iteration, detail: `Same failing action repeated ${count} times: ${toolCall.name}` });
          agentState.currentTaskStatus = "failed";
          return {
            status: "failed",
            reason: `Same failing action repeated ${count} times: ${toolCall.name} — ${result.content}`,
            changesMade: agentState.modifiedFiles,
            verificationPerformed,
            verificationPassed,
          };
        }
      } else {
        log("tool_completed", { iteration, toolName: toolCall.name, success: true, durationMs });
        // A successful call means the agent is still making progress, so the repeat
        // guard should only fire on *consecutive* identical failures. Counting across
        // a whole run killed tasks that were advancing between unrelated mistakes;
        // thrashing that never gets stuck is what maxIterations is for.
        failureCounts.clear();
        if (toolCall.name === "edit_file") {
          const path = String(toolCall.input.path ?? "");
          if (path && !agentState.modifiedFiles.includes(path)) agentState.modifiedFiles.push(path);
        }
      }

      toolResultContents.push({
        type: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        // The untruncated result stays in `result` for the run_command exit-code parse above.
        content: cm.truncateToolResult(toolCall.name, result.content),
        isError: result.isError,
      });
    }

    // Store assistant turn (tool calls)
    const primaryTool = toolCalls[0]?.name;
    const assistantMsg: Message = {
      role: "assistant",
      content: toolCalls.map((tc: ToolCall) => ({
        type: "tool_call" as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
        thoughtSignature: tc.thoughtSignature,
      })),
    };
    storeMessage(`${taskId}-assistant-${iteration}`, assistantMsg, "normal", true);

    // Store tool results
    const toolMsg: Message = { role: "tool", content: toolResultContents };
    storeMessage(
      `${taskId}-tool-${iteration}`,
      toolMsg,
      hasErrors ? "high" : "normal",
      true,
      primaryTool ? { toolName: primaryTool } : undefined,
    );
  }

  log("task_failed", { detail: `Iteration limit reached (${maxIterations})` });
  agentState.currentTaskStatus = "failed";
  return {
    status: "failed",
    reason: `iteration_limit`,
    changesMade: agentState.modifiedFiles,
    verificationPerformed,
    verificationPassed,
  };
}
