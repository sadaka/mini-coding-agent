import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSearchTool } from "./search.js";
import { createReadFileTool } from "./readfile.js";
import { createEditFileTool } from "./editfile.js";
import { createRunCommandTool, isAllowed } from "./runcommand.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agent-test-"));
  await writeFile(join(workspace, "hello.ts"), 'export const greeting = "hello";\n');
  await writeFile(join(workspace, "notes.txt"), "line one\nline two\nline three\n");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

// ── Search ──────────────────────────────────────────────────────────────────

describe("search tool", () => {
  it("finds matching lines", async () => {
    const tool = createSearchTool(workspace);
    const result = await tool.execute({ query: "greeting" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello.ts");
    expect(result.content).toContain("greeting");
  });

  it("returns no-results message when nothing matches", async () => {
    const tool = createSearchTool(workspace);
    const result = await tool.execute({ query: "zzznomatch" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No results");
  });

  it("rejects path outside workspace", async () => {
    const tool = createSearchTool(workspace);
    const result = await tool.execute({ query: "x", path: "../../etc" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/i);
  });
});

// ── Read File ────────────────────────────────────────────────────────────────

describe("read_file tool", () => {
  it("reads a file successfully", async () => {
    const tool = createReadFileTool(workspace);
    const result = await tool.execute({ path: "notes.txt" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("line one");
  });

  it("returns error for missing file", async () => {
    const tool = createReadFileTool(workspace);
    const result = await tool.execute({ path: "does-not-exist.txt" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found/i);
  });

  it("rejects path outside workspace", async () => {
    const tool = createReadFileTool(workspace);
    const result = await tool.execute({ path: "../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/i);
  });

  it("reads a line range", async () => {
    const tool = createReadFileTool(workspace);
    const result = await tool.execute({ path: "notes.txt", startLine: 2, endLine: 2 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("line two");
    expect(result.content).not.toContain("line one");
  });

  it("truncates oversized output", async () => {
    const big = "x".repeat(101 * 1024);
    await writeFile(join(workspace, "big.txt"), big);
    const tool = createReadFileTool(workspace);
    const result = await tool.execute({ path: "big.txt" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("[Output truncated");
  });
});

// ── Edit/Write File ──────────────────────────────────────────────────────────

describe("edit_file tool", () => {
  it("writes a new file", async () => {
    const tool = createEditFileTool(workspace);
    const result = await tool.execute({ path: "new.ts", operation: "write", content: "const x = 1;" });
    expect(result.isError).toBe(false);
    const read = createReadFileTool(workspace);
    const r2 = await read.execute({ path: "new.ts" });
    expect(r2.content).toContain("const x = 1;");
  });

  it("replaces an exact string", async () => {
    const tool = createEditFileTool(workspace);
    const result = await tool.execute({
      path: "notes.txt",
      operation: "replace",
      old_string: "line two",
      new_string: "line TWO",
    });
    expect(result.isError).toBe(false);
    const read = createReadFileTool(workspace);
    const r2 = await read.execute({ path: "notes.txt" });
    expect(r2.content).toContain("line TWO");
    expect(r2.content).not.toContain("line two");
  });

  it("fails replace when old_string not found", async () => {
    const tool = createEditFileTool(workspace);
    const result = await tool.execute({
      path: "notes.txt",
      operation: "replace",
      old_string: "DOES NOT EXIST",
      new_string: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found/i);
  });

  it("fails replace when old_string matches multiple times", async () => {
    await writeFile(join(workspace, "dup.txt"), "foo foo foo");
    const tool = createEditFileTool(workspace);
    const result = await tool.execute({
      path: "dup.txt",
      operation: "replace",
      old_string: "foo",
      new_string: "bar",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/3 times/);
  });

  it("rejects write outside workspace", async () => {
    const tool = createEditFileTool(workspace);
    const result = await tool.execute({ path: "../../evil.ts", operation: "write", content: "x" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/i);
  });

  // Models omit the redundant 'operation' discriminator — most editing tools infer it.
  // Every test above passes it explicitly, which is why this went unnoticed in the suite
  // while failing repeatedly in real use.
  it("infers write from content when operation is omitted", async () => {
    const tool = createEditFileTool(workspace);
    const result = await tool.execute({ path: "inferred.ts", content: "const y = 2;" });
    expect(result.isError).toBe(false);
    const r2 = await createReadFileTool(workspace).execute({ path: "inferred.ts" });
    expect(r2.content).toContain("const y = 2;");
  });

  it("infers replace from old_string/new_string when operation is omitted", async () => {
    await writeFile(join(workspace, "infer2.txt"), "alpha beta gamma");
    const tool = createEditFileTool(workspace);
    const result = await tool.execute({
      path: "infer2.txt",
      old_string: "beta",
      new_string: "BETA",
    });
    expect(result.isError).toBe(false);
    const r2 = await createReadFileTool(workspace).execute({ path: "infer2.txt" });
    expect(r2.content).toContain("alpha BETA gamma");
  });

  it("infers the edit when operation is an unrecognized synonym", async () => {
    await writeFile(join(workspace, "infer3.txt"), "keep one two");
    const tool = createEditFileTool(workspace);
    const result = await tool.execute({
      path: "infer3.txt",
      operation: "str_replace",
      old_string: "one",
      new_string: "ONE",
    });
    expect(result.isError).toBe(false);
    const r2 = await createReadFileTool(workspace).execute({ path: "infer3.txt" });
    expect(r2.content).toContain("keep ONE two");
  });

  it("reports the received keys when no edit can be inferred", async () => {
    const tool = createEditFileTool(workspace);
    const result = await tool.execute({ path: "nope.txt", mode: "edit" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Received keys/);
    expect(result.content).toContain("mode");
  });
});

// ── Run Command ──────────────────────────────────────────────────────────────

describe("run_command tool", () => {
  it("allows npm test", async () => {
    const r = await isAllowed("npm test", workspace);
    expect(r.allowed).toBe(true);
  });

  it("denies rm -rf", async () => {
    const r = await isAllowed("rm -rf /", workspace);
    expect(r.allowed).toBe(false);
  });

  it("denies npm install", async () => {
    const r = await isAllowed("npm install", workspace);
    expect(r.allowed).toBe(false);
  });

  it("denies git push", async () => {
    const r = await isAllowed("git push", workspace);
    expect(r.allowed).toBe(false);
  });

  it("denies shell operators with actionable guidance", async () => {
    // shell:false means a pipe reaches the binary as a literal argument,
    // producing "find: |: unknown primary or operator" instead of a clear denial.
    for (const cmd of [
      'find . -name "*.html" | grep gallery',
      "ls && cat x",
      "echo hi > out.txt",
      "cat $(ls)",
      "ls; rm -rf /",
    ]) {
      const r = await isAllowed(cmd, workspace);
      expect(r.allowed, `should deny: ${cmd}`).toBe(false);
      expect(r.reason, `should explain: ${cmd}`).toMatch(/without a shell|not supported/);
    }
  });

  it("still allows plain commands that contain no shell operators", async () => {
    const r = await isAllowed('find . -name "*.html"', workspace);
    expect(r.allowed).toBe(true);
  });

  it("executes an allowed command and returns structured output", async () => {
    // Use a node script inside workspace as an allowed command
    const script = join(workspace, "hello.js");
    await writeFile(script, 'process.stdout.write("ok\\n");');
    const tool = createRunCommandTool(workspace);
    const result = await tool.execute({ command: `node hello.js` });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toContain("ok");
    expect(parsed.timedOut).toBe(false);
  });

  it("returns timedOut:true when command exceeds timeout", async () => {
    const script = join(workspace, "hang.js");
    await writeFile(script, "setTimeout(()=>{},60000);");
    const tool = createRunCommandTool(workspace);
    const result = await tool.execute({ command: "node hang.js", timeoutMs: 200 });
    const parsed = JSON.parse(result.content);
    expect(parsed.timedOut).toBe(true);
  });

  it("denies cwd outside workspace", async () => {
    const tool = createRunCommandTool(workspace);
    const result = await tool.execute({ command: "npm test", cwd: "../../" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/i);
  });
});
