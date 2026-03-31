import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: [base.fsPath, ...segments].join("/"),
    }),
  },
}));

import { PulseSidebarProvider } from "../src/views/PulseSidebarProvider";

describe("PulseSidebarProvider loading UI", () => {
  it("renders a text-only shimmering thinking title", () => {
    const provider = new PulseSidebarProvider(
      { fsPath: "/workspace" } as any,
      {
        summary: vi.fn().mockResolvedValue(null),
      } as any,
      {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      } as any,
    );

    const html = (provider as any).buildHtml(
      {
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: { fsPath: string }) => uri.fsPath,
      },
      null,
    );

    expect(html).not.toContain("thinking-shimmer");
    expect(html).not.toContain("thinking-done-icon");
    expect(html).toContain("thinkingTitle");
    // CSS is now loaded from an external stylesheet
    expect(html).toContain("sidebar.css");
  });
});
