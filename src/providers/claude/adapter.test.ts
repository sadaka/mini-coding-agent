import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, ToolDefinition } from "../../types/index.js";

const mockCreate = vi.fn();

class MockAuthenticationError extends Error { status = 401; constructor(m: string) { super(m); } }
class MockRateLimitError extends Error { status = 429; constructor(m: string) { super(m); } }
class MockBadRequestError extends Error { status = 400; constructor(m: string) { super(m); } }
class MockAPIError extends Error { constructor(m: string, public status: number) { super(m); } }

const MockAnthropic = vi.fn().mockImplementation(() => ({
  messages: { create: mockCreate },
})) as unknown as { new(): unknown } & {
  AuthenticationError: typeof MockAuthenticationError;
  RateLimitError: typeof MockRateLimitError;
  BadRequestError: typeof MockBadRequestError;
  APIError: typeof MockAPIError;
};
MockAnthropic.AuthenticationError = MockAuthenticationError;
MockAnthropic.RateLimitError = MockRateLimitError;
MockAnthropic.BadRequestError = MockBadRequestError;
MockAnthropic.APIError = MockAPIError;

vi.mock("@anthropic-ai/sdk", () => ({
  default: MockAnthropic,
  AuthenticationError: MockAuthenticationError,
  RateLimitError: MockRateLimitError,
  BadRequestError: MockBadRequestError,
  APIError: MockAPIError,
}));

const { ClaudeAdapter } = await import("./adapter.js");

describe("ClaudeAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.CLAUDE_MODEL = "claude-test";
  });

  it("returns text response for text output", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello from Claude" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const adapter = new ClaudeAdapter();
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const result = await adapter.generate(messages, []);

    expect(result.type).toBe("text");
    expect(result.text).toBe("Hello from Claude");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it("returns tool_calls response when model calls a tool", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "tu-1", name: "search", input: { query: "foo" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 8 },
    });

    const adapter = new ClaudeAdapter();
    const tools: ToolDefinition[] = [
      { name: "search", description: "search files", inputSchema: { type: "object", properties: {} } },
    ];
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "find foo" }] }];
    const result = await adapter.generate(messages, tools);

    expect(result.type).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({ id: "tu-1", name: "search", input: { query: "foo" } });
  });

  it("translates tool result messages (role=tool) to tool_result blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const adapter = new ClaudeAdapter();
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "run" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "search", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", toolName: "search", content: "result", isError: false }] },
    ];

    await adapter.generate(messages, []);
    const call = mockCreate.mock.calls[0][0];
    const toolResultMsg = call.messages.find(
      (m: { content: { type?: string }[] }) => m.content?.some((b: { type?: string }) => b.type === "tool_result")
    );
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
  });

  it("rejects truncated tool arguments when the model hits max_tokens", async () => {
    // A max_tokens cutoff mid-tool_use leaves input JSON incomplete — here the
    // 'operation' and 'content' fields never arrived. Passing this through made
    // edit_file fail with "Unknown operation: ." on every retry.
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "tu-1", name: "edit_file", input: { path: "gallery.html" } }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 500, output_tokens: 16384 },
    });

    const adapter = new ClaudeAdapter();
    const tools: ToolDefinition[] = [
      { name: "edit_file", description: "edit", inputSchema: { type: "object", properties: {} } },
    ];
    await expect(
      adapter.generate([{ role: "user", content: [{ type: "text", text: "write a page" }] }], tools)
    ).rejects.toMatchObject({ code: "context_length" });
  });

  it("does not reject a max_tokens stop on a plain text response", async () => {
    // Truncated prose is still usable; only truncated tool arguments are corrupt.
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "a long answer that got cut o" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 16384 },
    });

    const adapter = new ClaudeAdapter();
    const result = await adapter.generate(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      []
    );
    expect(result.type).toBe("text");
  });

  it("normalizes rate limit errors to retryable ProviderError", async () => {
    mockCreate.mockRejectedValue(new MockRateLimitError("rate limit"));

    const adapter = new ClaudeAdapter();
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    await expect(adapter.generate(messages, [])).rejects.toMatchObject({
      code: "rate_limit",
      retryable: true,
    });
  });

  it("normalizes auth errors to non-retryable ProviderError", async () => {
    mockCreate.mockRejectedValue(new MockAuthenticationError("invalid key"));

    const adapter = new ClaudeAdapter();
    await expect(adapter.generate([{ role: "user", content: [{ type: "text", text: "hi" }] }], [])).rejects.toMatchObject({
      code: "auth",
      retryable: false,
    });
  });
});
