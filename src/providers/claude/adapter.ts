import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMResponse,
  Message,
  ModelCapabilities,
  ProviderError,
  ToolDefinition,
} from "../../types/index.js";

function makeProviderError(
  message: string,
  code: ProviderError["code"],
  retryable: boolean,
  cause?: unknown
): ProviderError {
  const err = new Error(message) as ProviderError;
  err.code = code;
  err.retryable = retryable;
  err.cause = cause;
  return err;
}

function classifyError(err: unknown): ProviderError {
  if (err instanceof Anthropic.AuthenticationError)
    return makeProviderError(err.message, "auth", false, err);
  if (err instanceof Anthropic.RateLimitError)
    return makeProviderError(err.message, "rate_limit", true, err);
  if (err instanceof Anthropic.BadRequestError && /context|length|too long/i.test(err.message))
    return makeProviderError(err.message, "context_length", false, err);
  if (err instanceof Anthropic.APIError && err.status >= 500)
    return makeProviderError(err.message, "provider", true, err);
  const msg = err instanceof Error ? err.message : String(err);
  return makeProviderError(msg, "unknown", false, err);
}

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const c of msg.content) {
        if (c.type === "text") content.push({ type: "text", text: c.text });
        else if (c.type === "tool_call")
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      }
      if (content.length) result.push({ role: "assistant", content });
    } else if (msg.role === "user") {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const c of msg.content) {
        if (c.type === "text") content.push({ type: "text", text: c.text });
      }
      if (content.length) result.push({ role: "user", content });
    } else if (msg.role === "tool") {
      // Tool results go as user-role tool_result blocks
      const content: Anthropic.ToolResultBlockParam[] = [];
      for (const c of msg.content) {
        if (c.type === "tool_result") {
          content.push({
            type: "tool_result",
            tool_use_id: c.toolCallId,
            content: c.content,
            is_error: c.isError,
          });
        }
      }
      if (content.length) result.push({ role: "user", content });
    }
  }

  return result;
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));
}

export class ClaudeAdapter implements LLMProvider {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor() {
    // Anthropic() resolves credentials from ANTHROPIC_API_KEY automatically
    try {
      this.client = new Anthropic();
    } catch (err) {
      throw makeProviderError(
        `Anthropic client init failed: ${err instanceof Error ? err.message : err}`,
        "auth",
        false,
        err
      );
    }
    this.model = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";
    // Whole-file writes routinely exceed 8K output tokens.
    this.maxTokens = parseInt(process.env.CLAUDE_MAX_OUTPUT_TOKENS ?? "16384", 10);
  }

  capabilities(): ModelCapabilities {
    // claude-haiku-4-5 and claude-sonnet-4-5 support 200K context
    return { contextWindowTokens: parseInt(process.env.CLAUDE_CONTEXT_WINDOW ?? "200000", 10) };
  }

  async generate(
    messages: Message[],
    tools: ToolDefinition[],
    options?: { model?: string }
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.model;
    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools = tools.length > 0 ? toAnthropicTools(tools) : undefined;

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model,
        max_tokens: this.maxTokens,
        messages: anthropicMessages,
        ...(anthropicTools ? { tools: anthropicTools } : {}),
      });
    } catch (err) {
      throw classifyError(err);
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // A max_tokens cutoff mid-tool_use leaves the input JSON truncated: the SDK
    // surfaces whatever parsed, silently missing the fields that never arrived.
    // Passing that on makes tools fail with nonsense ("Unknown operation: .").
    if (response.stop_reason === "max_tokens" && toolUseBlocks.length > 0) {
      throw makeProviderError(
        `Model hit the ${this.maxTokens}-token output limit while emitting arguments for ` +
          `'${toolUseBlocks[0].name}', so they are incomplete. Retry with a smaller edit ` +
          `(use operation 'replace' for a targeted change instead of rewriting the whole file), ` +
          `or raise CLAUDE_MAX_OUTPUT_TOKENS.`,
        "context_length",
        false
      );
    }

    if (toolUseBlocks.length > 0) {
      return {
        type: "tool_calls",
        toolCalls: toolUseBlocks.map((b) => ({
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        })),
      };
    }

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    return {
      type: "text",
      text: textBlock?.text ?? "",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
