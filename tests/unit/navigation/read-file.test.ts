import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadFileTool } from "../../../src/tools/readfile.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "readfile-"));
  dirs.push(d);
  return d;
};
let ws: string;
const read = (input: Record<string, unknown>) => createReadFileTool(ws).execute(input);
const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

beforeEach(() => {
  ws = tmp();
  writeFileSync(join(ws, "ten.txt"), ten);
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("read_file numbered, ranged reads", () => {
  it("numbers every line of a whole-file read; the trailing newline adds no phantom line", async () => {
    const r = await read({ path: "ten.txt" });
    const lines = r.content.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("1\tline 1");
    expect(lines[9]).toBe("10\tline 10");
  });

  it("returns exactly the requested range with original line numbers", async () => {
    expect((await read({ path: "ten.txt", startLine: 3, endLine: 5 })).content).toBe("3\tline 3\n4\tline 4\n5\tline 5");
    expect((await read({ path: "ten.txt", startLine: 9 })).content).toBe("9\tline 9\n10\tline 10");
  });

  it("contextLines widens the range both ways, clamped to the file", async () => {
    expect((await read({ path: "ten.txt", startLine: 5, endLine: 5, contextLines: 2 })).content.split("\n").map((l) => l.split("\t")[0])).toEqual(["3", "4", "5", "6", "7"]);
    expect((await read({ path: "ten.txt", startLine: 1, endLine: 1, contextLines: 3 })).content.split("\n")).toHaveLength(4);
    expect((await read({ path: "ten.txt", startLine: 10, endLine: 10, contextLines: 5 })).content.split("\n")).toHaveLength(6);
  });

  it("endLine past EOF is clamped, as before", async () => {
    expect((await read({ path: "ten.txt", startLine: 9, endLine: 99 })).content).toBe("9\tline 9\n10\tline 10");
  });

  it("errors clearly on invalid ranges and a start beyond EOF", async () => {
    expect((await read({ path: "ten.txt", startLine: 5, endLine: 2 })).content).toMatch(/endLine 2 is before startLine 5/);
    expect((await read({ path: "ten.txt", startLine: 0 })).content).toMatch(/Invalid startLine/);
    expect((await read({ path: "ten.txt", startLine: 1.5 })).content).toMatch(/Invalid startLine/);
    expect((await read({ path: "ten.txt", contextLines: -1 })).content).toMatch(/Invalid contextLines/);
    const r = await read({ path: "ten.txt", startLine: 50 });
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toMatch(/beyond the end of the file \(10 lines\)/);
  });

  it("handles CRLF, a missing trailing newline, and multibyte text split across chunks", async () => {
    writeFileSync(join(ws, "crlf.txt"), "a\r\nb\r\nlast");
    expect((await read({ path: "crlf.txt" })).content).toBe("1\ta\n2\tb\n3\tlast");
    writeFileSync(join(ws, "utf.txt"), "é".repeat(100_000) + "\nsecond\n"); // 200KB line crosses chunk edges
    const r = await read({ path: "utf.txt", startLine: 2, endLine: 2 });
    expect(r.content).toBe("2\tsecond");
  });

  it("does not read a multi-megabyte file whole for a small range", async () => {
    const row = "x".repeat(99) + "\n";
    writeFileSync(join(ws, "huge.txt"), row.repeat(50_000)); // ~5MB
    let bytes = 0;
    const tool = createReadFileTool(ws, { onChunk: (n) => (bytes += n) });
    const r = await tool.execute({ path: "huge.txt", startLine: 2, endLine: 3 });
    expect(r.content.split("\n")).toHaveLength(2);
    expect(bytes).toBeLessThanOrEqual(128 * 1024);
  });

  it("truncates a whole-file read of a large file with the marker, still bounded", async () => {
    writeFileSync(join(ws, "huge.txt"), ("y".repeat(99) + "\n").repeat(50_000));
    let bytes = 0;
    const r = await createReadFileTool(ws, { onChunk: (n) => (bytes += n) }).execute({ path: "huge.txt" });
    expect(r.content).toContain("[Output truncated at 100KB]");
    expect(r.content.length).toBeLessThan(101 * 1024 + 100);
    expect(bytes).toBeLessThan(400 * 1024);
  });

  it("reports binary files instead of dumping them", async () => {
    writeFileSync(join(ws, "b.bin"), Buffer.from([1, 2, 0, 3]));
    expect(await read({ path: "b.bin" })).toEqual({ content: "binary file - content not displayed", isError: false });
  });

  it("rejects ../ and symlink escape, reports missing files and directories", async () => {
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(ws, "leak.txt"));
    symlinkSync(outside, join(ws, "linkdir"));
    mkdirSync(join(ws, "sub"));
    expect((await read({ path: "../x" })).content).toMatch(/outside the workspace/);
    expect((await read({ path: "leak.txt" })).content).toMatch(/outside the workspace/);
    expect((await read({ path: "linkdir/secret.txt" })).content).toMatch(/outside the workspace/);
    expect((await read({ path: "nope.txt" })).content).toBe("File not found: nope.txt");
    expect((await read({ path: "sub" })).content).toBe("File not found: sub");
  });

  it("an empty file reads as empty, not an error", async () => {
    writeFileSync(join(ws, "empty.txt"), "");
    expect(await read({ path: "empty.txt" })).toEqual({ content: "", isError: false });
  });
});
