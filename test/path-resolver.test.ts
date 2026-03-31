import path from "node:path";

import { describe, expect, it } from "vitest";

import { PathResolver } from "../src/agent/runtime/PathResolver";

describe("PathResolver", () => {
  it("resolves relative paths against the latest workspace root", () => {
    let root = { fsPath: "/workspace-a" } as any;
    const resolver = new PathResolver(() => root);

    expect(resolver.resolve("src/index.ts")).toBe(
      path.join("/workspace-a", "src/index.ts"),
    );

    root = { fsPath: "/workspace-b" } as any;

    expect(resolver.resolve("src/index.ts")).toBe(
      path.join("/workspace-b", "src/index.ts"),
    );
    expect(resolver.normalizeDisplay("/workspace-b/src/index.ts")).toBe(
      "src/index.ts",
    );
  });
});
