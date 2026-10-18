export type Role = "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCallContent {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export type MessageContent = TextContent | ToolCallContent | ToolResultContent;

export interface Message {
  role: Role;
  content: MessageContent[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface LLMResponse {
  type: "text" | "tool_calls";
  text?: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ProviderError extends Error {
  code: "auth" | "rate_limit" | "context_length" | "provider" | "unknown";
  retryable: boolean;
  cause?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface Tool {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export interface ModelCapabilities {
  contextWindowTokens: number;
}

export interface LLMProvider {
  generate(
    messages: Message[],
    tools: ToolDefinition[],
    options?: { model?: string }
  ): Promise<LLMResponse>;
  capabilities?(): ModelCapabilities;
}
