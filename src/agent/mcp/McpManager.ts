import { spawnSync } from "child_process";

export interface McpServerStatus {
  id: string;
  enabled: boolean;
  trust: string;
  transport: string;
  state: "configured" | "disabled" | "error";
  detail: string;
}

interface McpServerDefinition {
  id?: unknown;
  enabled?: unknown;
  trust?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
}

export class McpManager {
  public constructor(private serverDefs: McpServerDefinition[]) {}

  public updateServerDefinitions(serverDefs: McpServerDefinition[]): void {
    this.serverDefs = [...serverDefs];
  }

  public async listServerStatus(): Promise<McpServerStatus[]> {
    const statuses: McpServerStatus[] = [];

    for (const server of this.serverDefs) {
      const id = String(server.id ?? "unknown");
      const enabled = Boolean(server.enabled ?? false);
      const trust = String(server.trust ?? "unknown");
      const transport = String(server.transport ?? "stdio");

      if (!enabled) {
        statuses.push({
          id,
          enabled,
          trust,
          transport,
          state: "disabled",
          detail: "Server is disabled by configuration.",
        });
        continue;
      }

      if (transport === "stdio") {
        const command =
          typeof server.command === "string" ? server.command.trim() : "";
        if (!command) {
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: "Missing required stdio command.",
          });
          continue;
        }

        if (!isCommandAvailable(command)) {
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: `Command not found in PATH: ${command}`,
          });
          continue;
        }

        statuses.push({
          id,
          enabled,
          trust,
          transport,
          state: "configured",
          detail: "Stdio command is available.",
        });
        continue;
      }

      if (transport === "sse" || transport === "http") {
        const url = typeof server.url === "string" ? server.url.trim() : "";
        if (!url) {
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: "Missing required server url.",
          });
          continue;
        }

        try {
          // Validate URL format at configuration time.
          new URL(url);
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "configured",
            detail: "Remote MCP URL appears valid.",
          });
        } catch {
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: `Invalid URL: ${url}`,
          });
        }
        continue;
      }

      statuses.push({
        id,
        enabled,
        trust,
        transport,
        state: "error",
        detail: `Unsupported transport: ${transport}`,
      });
    }

    return statuses;
  }
}

function isCommandAvailable(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], {
    stdio: "ignore",
    shell: false,
  });
  return result.status === 0;
}
