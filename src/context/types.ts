export type ContextItemType =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "task_state"
  | "important_fact"
  | "summary";

export type ImportanceLevel = "critical" | "high" | "normal" | "low";

export interface ContextItem {
  id: string;
  type: ContextItemType;
  content: string;
  importance: ImportanceLevel;
  createdAt: number;
  tokenEstimate?: number;
  source?: {
    toolName?: string;
    filePath?: string;
    command?: string;
  };
  removable?: boolean;
  truncated?: boolean;
  originalTokenEstimate?: number;
}

export interface ContextState {
  items: ContextItem[];
  maxContextTokens: number;
  reservedOutputTokens: number;
  estimatedInputTokens: number;
  compactionCount: number;
  truncatedItemCount: number;
  droppedCount: number;
}

export interface ContextBudget {
  maxContextTokens: number;
  reservedOutputTokens: number;
  usableInputTokens: number;
}

export interface ContextMetrics {
  iteration: number;
  estimatedInputTokens: number;
  contextBudget: number;
  utilization: number;
  contextItems: number;
  toolResults: number;
  truncatedItems: number;
  droppedItems: number;
  compactions: number;
}

export interface ImportantFact {
  id: string;
  content: string;
  importance: "critical" | "high" | "normal";
  source?: string;
}

export interface CompactionEvent {
  timestamp: number;
  itemsBefore: number;
  itemsAfter: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  itemsRemoved: number;
  summaryCreated: boolean;
}

export interface ContextStats {
  totalItems: number;
  estimatedTokens: number;
  utilization: number;
  truncations: number;
  compactions: number;
  droppedItems: number;
}
