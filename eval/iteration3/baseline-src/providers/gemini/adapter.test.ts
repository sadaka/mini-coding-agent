import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, ToolDefinition } from "../../types/index.js";

// Mock @google/genai before importing adapter
const mockGenerateContent = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  })),
}));

// Import after mock is set up
const { GeminiAdapter } = await import("./adapter.js");

describe("GeminiAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "gemini-test";
  });

  it("throws auth error when GEMINI_API_KEY is missing", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => new GeminiAdapter()).toThrow();
    const err = (() => { try { new GeminiAdapter(); } catch (e) { return e; } })() as { code: string };
    expect(err.code).toBe("auth");
  });

  it("returns text response for text output", async () => {
    mockGenerateContent.mockResolvedValue({
      text: "Hello from Gemini",
      functionCalls: undefined,
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });

    const adapter = new GeminiAdapter();
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const result = await adapter.generate(messages, []);

    expect(result.type).toBe("text");
    expect(result.text).toBe("Hello from Gemini");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it("returns tool_calls response when model calls a function", async () => {
    mockGenerateContent.mockResolvedValue({
      text: undefined,
      candidates: [{ content: { parts: [
        { functionCall: { id: "call-1", name: "search", args: { query: "foo" } } },
      ] } }],
    });

    const adapter = new GeminiAdapter();
    const tools: ToolDefinition[] = [
      { name: "search", description: "search files", inputSchema: { type: "object", properties: {} } },
    ];
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "find foo" }] }];
    const result = await adapter.generate(messages, tools);

    expect(result.type).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({ id: "call-1", name: "search", input: { query: "foo" } });
  });

  it("translates tool result messages (role=tool) to functionResponse parts", async () => {
    mockGenerateContent.mockResolvedValue({ text: "done", functionCalls: undefined });

    const adapter = new GeminiAdapter();
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "run" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "search", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", toolName: "search", content: "result", isError: false }] },
    ];

    await adapter.generate(messages, []);
    const call = mockGenerateContent.mock.calls[0][0];
    const toolResultContent = call.contents.find(
      (c: { parts: { functionResponse?: unknown }[] }) =>
        c.parts?.some((p) => "functionResponse" in p)
    );
    expect(toolResultContent).toBeDefined();
    expect(toolResultContent.role).toBe("user");
  });

  it("normalizes rate limit errors to retryable ProviderError", async () => {
    mockGenerateContent.mockRejectedValue(new Error("rate limit exceeded 429"));

    const adapter = new GeminiAdapter();
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

    await expect(adapter.generate(messages, [])).rejects.toMatchObject({
      code: "rate_limit",
      retryable: true,
    });
  });

  it("normalizes auth errors to non-retryable ProviderError", async () => {
    mockGenerateContent.mockRejectedValue(new Error("API key invalid 401"));

    const adapter = new GeminiAdapter();
    await expect(adapter.generate([{ role: "user", content: [{ type: "text", text: "hi" }] }], [])).rejects.toMatchObject({
      code: "auth",
      retryable: false,
    });
  });
});
