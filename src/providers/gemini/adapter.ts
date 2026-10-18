import { GoogleGenAI } from "@google/genai";
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
  const msg = err instanceof Error ? err.message : String(err);
  if (/api.?key|unauthorized|401/i.test(msg))
    return makeProviderError(msg, "auth", false, err);
  if (/rate.?limit|429/i.test(msg))
    return makeProviderError(msg, "rate_limit", true, err);
  if (/context.?length|token.?limit|too.?long|413/i.test(msg))
    return makeProviderError(msg, "context_length", false, err);
  if (/5\d\d|server.?error|internal/i.test(msg))
    return makeProviderError(msg, "provider", true, err);
  return makeProviderError(msg, "unknown", false, err);
}

function toGeminiContents(messages: Message[]) {
  const contents: Array<{ role: string; parts: unknown[] }> = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const parts: unknown[] = [];
      for (const c of msg.content) {
        if (c.type === "text") parts.push({ text: c.text });
        else if (c.type === "tool_call") {
          const part: Record<string, unknown> = { functionCall: { id: c.id, name: c.name, args: c.input } };
          if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature;
          parts.push(part);
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (msg.role === "user") {
      const parts: unknown[] = [];
      for (const c of msg.content) {
        if (c.type === "text") parts.push({ text: c.text });
      }
      if (parts.length) contents.push({ role: "user", parts });
    } else if (msg.role === "tool") {
      // Tool results go as user-role function response parts
      const parts: unknown[] = [];
      for (const c of msg.content) {
        if (c.type === "tool_result") {
          parts.push({
            functionResponse: {
              id: c.toolCallId,
              name: c.toolName,
              response: { output: c.content, isError: c.isError },
            },
          });
        }
      }
      if (parts.length) contents.push({ role: "user", parts });
    }
  }

  return contents;
}

function toFunctionDeclarations(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

export class GeminiAdapter implements LLMProvider {
  private client: GoogleGenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw makeProviderError("GEMINI_API_KEY is not set", "auth", false);
    this.client = new GoogleGenAI({ apiKey });
    this.model = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
  }

  capabilities(): ModelCapabilities {
    // Gemini 2.0+ models support 1M context window
    return { contextWindowTokens: parseInt(process.env.GEMINI_CONTEXT_WINDOW ?? "1000000", 10) };
  }

  async generate(
    messages: Message[],
    tools: ToolDefinition[],
    options?: { model?: string }
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.model;
    const contents = toGeminiContents(messages);
    const config: Record<string, unknown> = {};
    if (tools.length > 0) {
      config.tools = [{ functionDeclarations: toFunctionDeclarations(tools) }];
    }

    let response;
    try {
      response = await this.client.models.generateContent({
        model,
        contents: contents as never,
        config: config as never,
      });
    } catch (err) {
      throw classifyError(err);
    }

    // Read raw parts to capture thoughtSignature alongside each functionCall.
    // thoughtSignature lives on the same part as functionCall (not a separate part).
    type RawPart = { thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: Record<string, unknown> } };
    const rawParts = (response.candidates?.[0]?.content?.parts ?? []) as RawPart[];
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown>; thoughtSignature?: string }> = [];
    for (const part of rawParts) {
      if (part.functionCall) {
        const fc = part.functionCall;
        toolCalls.push({
          id: fc.id ?? fc.name ?? "",
          name: fc.name ?? "",
          input: (fc.args ?? {}) as Record<string, unknown>,
          thoughtSignature: part.thoughtSignature,
        });
      }
    }
    if (toolCalls.length > 0) {
      return { type: "tool_calls", toolCalls };
    }

    return {
      type: "text",
      text: response.text ?? "",
      usage: response.usageMetadata
        ? {
            inputTokens: response.usageMetadata.promptTokenCount ?? 0,
            outputTokens: response.usageMetadata.candidatesTokenCount ?? 0,
          }
        : undefined,
    };
  }
}
