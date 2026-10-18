export type LogEvent =
  | "task_started"
  | "llm_request"
  | "llm_response"
  | "tool_requested"
  | "tool_started"
  | "tool_completed"
  | "tool_failed"
  | "verification_started"
  | "verification_completed"
  | "task_completed"
  | "task_failed"
  | "context_build_started"
  | "context_build_completed"
  | "context_item_truncated"
  | "context_item_dropped"
  | "context_compaction_started"
  | "context_compaction_completed"
  | "context_metrics"
  | "repository_scan_started"
  | "repository_scan_completed"
  | "directory_listed"
  | "search_started"
  | "search_completed"
  | "symbol_search_started"
  | "symbol_search_completed"
  | "test_discovery_started"
  | "test_discovery_completed"
  | "navigation_duplicate_detected"
  | "navigation_scope_filtered"
  | "navigation_result_truncated";

export interface LogEntry {
  event: LogEvent;
  taskId: string;
  timestamp: string;
  iteration?: number;
  toolName?: string;
  success?: boolean;
  durationMs?: number;
  detail?: string;
  estimatedInputTokens?: number;
  contextItems?: number;
  utilization?: number;
  truncatedItems?: number;
  droppedItems?: number;
  compactions?: number;
  operation?: string;
  path?: string;
  resultCount?: number;
  outputSize?: number;
  /** "tree-sitter" or "fallback" (text search) for symbol searches. */
  source?: "tree-sitter" | "fallback";
}

export type LogSink = (entry: LogEntry) => void;

export function makeLogger(taskId: string, sink: LogSink) {
  return function log(
    event: LogEvent,
    extra?: Omit<LogEntry, "event" | "taskId" | "timestamp">
  ) {
    sink({ event, taskId, timestamp: new Date().toISOString(), ...extra });
  };
}
