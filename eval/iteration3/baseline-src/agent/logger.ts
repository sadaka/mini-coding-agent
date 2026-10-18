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
  | "context_metrics";

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
