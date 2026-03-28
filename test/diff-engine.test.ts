import { describe, it, expect } from "vitest";
import {
  computeLineDiff,
  computeFileDiff,
} from "../src/agent/edits/DiffEngine";

describe("DiffEngine – computeLineDiff", () => {
  it("returns empty hunks for identical content", () => {
    const hunks = computeLineDiff("hello\nworld", "hello\nworld");
    expect(hunks).toEqual([]);
  });

  it("detects a single line addition", () => {
    const hunks = computeLineDiff("a\nb\nc", "a\nb\nnew\nc");
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    const allLines = hunks.flatMap((h) => h.lines);
    const adds = allLines.filter((l) => l.type === "add");
    expect(adds.length).toBe(1);
    expect(adds[0].content).toBe("new");
  });

  it("detects a single line removal", () => {
    const hunks = computeLineDiff("a\nold\nb", "a\nb");
    const allLines = hunks.flatMap((h) => h.lines);
    const removes = allLines.filter((l) => l.type === "remove");
    expect(removes.length).toBe(1);
    expect(removes[0].content).toBe("old");
  });

  it("detects a line modification (remove + add)", () => {
    const hunks = computeLineDiff("line1\nold\nline3", "line1\nnew\nline3");
    const allLines = hunks.flatMap((h) => h.lines);
    const removes = allLines.filter((l) => l.type === "remove");
    const adds = allLines.filter((l) => l.type === "add");
    expect(removes.length).toBe(1);
    expect(removes[0].content).toBe("old");
    expect(adds.length).toBe(1);
    expect(adds[0].content).toBe("new");
  });

  it("includes context lines around changes", () => {
    const old = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const now = ["a", "b", "c", "X", "e", "f", "g"].join("\n");
    const hunks = computeLineDiff(old, now, 2);
    expect(hunks.length).toBe(1);
    const ctxLines = hunks[0].lines.filter((l) => l.type === "context");
    // Should have context lines before and after the change
    expect(ctxLines.length).toBeGreaterThanOrEqual(2);
  });

  it("handles empty old content (new file)", () => {
    const hunks = computeLineDiff("", "line1\nline2\nline3");
    const allLines = hunks.flatMap((h) => h.lines);
    const adds = allLines.filter((l) => l.type === "add");
    expect(adds.length).toBe(3);
  });

  it("handles empty new content (deleted file)", () => {
    const hunks = computeLineDiff("line1\nline2", "");
    const allLines = hunks.flatMap((h) => h.lines);
    const removes = allLines.filter((l) => l.type === "remove");
    expect(removes.length).toBe(2);
  });

  it("merges adjacent hunks when gap is small", () => {
    // Two changes close together should yield one merged hunk
    const old = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
    const now = ["1", "X", "3", "4", "Y", "6", "7"].join("\n");
    const hunks = computeLineDiff(old, now, 1);
    // With contextLines=1, gap between changes (1 line: "3","4") <= 2*1, so should merge
    expect(hunks.length).toBe(1);
  });

  it("produces separate hunks for distant changes", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const modified = [...lines];
    modified[2] = "CHANGED_A";
    modified[25] = "CHANGED_B";
    const hunks = computeLineDiff(lines.join("\n"), modified.join("\n"), 2);
    expect(hunks.length).toBe(2);
  });

  it("assigns correct line numbers", () => {
    const hunks = computeLineDiff("a\nb\nc", "a\nX\nc");
    const allLines = hunks.flatMap((h) => h.lines);
    const remove = allLines.find((l) => l.type === "remove");
    const add = allLines.find((l) => l.type === "add");
    expect(remove?.oldLine).toBe(2);
    expect(add?.newLine).toBe(2);
  });

  it("handles multi-line additions efficiently", () => {
    const old = "start\nend";
    const now = "start\na\nb\nc\nd\ne\nend";
    const hunks = computeLineDiff(old, now);
    const adds = hunks.flatMap((h) => h.lines).filter((l) => l.type === "add");
    expect(adds.length).toBe(5);
  });

  it("produces a summary hunk for very large files", () => {
    const bigOld = Array.from({ length: 2000 }, (_, i) => `old${i}`).join("\n");
    const bigNew = Array.from({ length: 2000 }, (_, i) => `new${i}`).join("\n");
    const hunks = computeLineDiff(bigOld, bigNew);
    // Should get a summary hunk instead of detailed diff
    expect(hunks.length).toBe(1);
    expect(hunks[0].lines.length).toBe(2);
  });
});

describe("DiffEngine – computeFileDiff", () => {
  it("marks new files correctly", () => {
    const result = computeFileDiff("/src/new.ts", null, "const x = 1;\n");
    expect(result.isNew).toBe(true);
    expect(result.isDelete).toBe(false);
    expect(result.fileName).toBe("new.ts");
    expect(result.additions).toBeGreaterThan(0);
    expect(result.deletions).toBe(0);
  });

  it("marks deleted files correctly", () => {
    const result = computeFileDiff("/src/old.ts", "const x = 1;\n", null);
    expect(result.isNew).toBe(false);
    expect(result.isDelete).toBe(true);
    expect(result.deletions).toBeGreaterThan(0);
    expect(result.additions).toBe(0);
  });

  it("computes correct stats for modified files", () => {
    const result = computeFileDiff(
      "/src/mod.ts",
      "line1\nold\nline3",
      "line1\nnew\nline3",
    );
    expect(result.isNew).toBe(false);
    expect(result.isDelete).toBe(false);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.hunks.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts fileName from path with mixed separators", () => {
    const result = computeFileDiff("d:\\src\\folder\\file.ts", "", "x\n");
    expect(result.fileName).toBe("file.ts");
    const result2 = computeFileDiff("/home/user/file.py", "", "x\n");
    expect(result2.fileName).toBe("file.py");
  });
});
