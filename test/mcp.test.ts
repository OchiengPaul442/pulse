import { describe, expect, it } from "vitest";

import { McpManager } from "../src/agent/mcp/McpManager";

describe("McpManager", () => {
  it("maps server definitions to status rows", async () => {
    const manager = new McpManager([
      {
        id: "filesystem",
        enabled: true,
        trust: "workspace",
        transport: "stdio",
        command: "node",
      },
      { id: "docs", enabled: false, trust: "user", transport: "stdio" },
    ]);

    const rows = await manager.listServerStatus();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.state).toBe("configured");
    expect(rows[1]?.state).toBe("disabled");
  });
});
