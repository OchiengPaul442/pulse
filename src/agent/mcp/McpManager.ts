export interface McpServerStatus {
  id: string;
  enabled: boolean;
  trust: string;
  transport: string;
  state: "configured" | "disabled";
}

export class McpManager {
  public constructor(
    private readonly serverDefs: Array<Record<string, unknown>>,
  ) {}

  public listServerStatus(): McpServerStatus[] {
    return this.serverDefs.map((server) => ({
      id: String(server.id ?? "unknown"),
      enabled: Boolean(server.enabled ?? false),
      trust: String(server.trust ?? "unknown"),
      transport: String(server.transport ?? "stdio"),
      state: Boolean(server.enabled ?? false) ? "configured" : "disabled",
    }));
  }
}
