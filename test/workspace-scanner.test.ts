import { describe, expect, it, vi, afterEach } from "vitest";
import * as vscode from "vscode";

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
  workspace: {
    findFiles: vi.fn(),
    fs: {
      readFile: vi.fn(),
    },
  },
}));

import { WorkspaceScanner } from "../src/agent/indexing/WorkspaceScanner";

describe("WorkspaceScanner cancellation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns early when search is already aborted", async () => {
    const scanner = new WorkspaceScanner();
    const controller = new AbortController();
    controller.abort();

    const result = await scanner.searchFileContents(
      "needle",
      5,
      1000,
      controller.signal,
    );

    expect(result).toEqual([]);
    expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
  });

  it("returns early when context read is already aborted", async () => {
    const scanner = new WorkspaceScanner();
    const controller = new AbortController();
    controller.abort();

    const result = await scanner.readContextSnippets(
      ["src/index.ts", "src/app.ts"],
      200,
      controller.signal,
    );

    expect(result).toEqual([]);
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
  });
});
