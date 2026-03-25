import { spawn } from "child_process";

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
    const commandChecks = new Map<string, Promise<boolean>>();
    return Promise.all(
      this.serverDefs.map(async (server) => {
      const id = String(server.id ?? "unknown");
      const enabled = Boolean(server.enabled ?? false);
      const trust = String(server.trust ?? "unknown");
      const transport = String(server.transport ?? "stdio");

      if (!enabled) {
        return {
          id,
          enabled,
          trust,
          transport,
          state: "disabled",
          detail: "Server is disabled by configuration.",
        };
      }

      if (transport === "stdio") {
        const command =
          typeof server.command === "string" ? server.command.trim() : "";
        if (!command) {
          return {
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: "Missing required stdio command.",
          };
        }

        const availableCheck = commandChecks.get(command) ?? isCommandAvailable(command);
        commandChecks.set(command, availableCheck);
        if (!(await availableCheck)) {
          return {
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: `Command not found in PATH: ${command}`,
          };
        }

        return {
          id,
          enabled,
          trust,
          transport,
          state: "configured",
          detail: "Stdio command is available.",
        };
      }

      if (transport === "sse" || transport === "http") {
        const url = typeof server.url === "string" ? server.url.trim() : "";
        if (!url) {
          return {
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: "Missing required server url.",
          };
        }

        try {
          // Validate URL format at configuration time.
          new URL(url);
          return {
            id,
            enabled,
            trust,
            transport,
            state: "configured",
            detail: "Remote MCP URL appears valid.",
          };
        } catch {
          return {
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: `Invalid URL: ${url}`,
          };
        }
      }

      return {
        id,
        enabled,
        trust,
        transport,
        state: "error",
        detail: `Unsupported transport: ${transport}`,
      };
      }),
    );
  }
}

function isCommandAvailable(command: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    let completed = false;
    const done = (value: boolean): void => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeoutHandle);
      resolve(value);
    };

    const child = spawn(probe, [command], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    const timeoutHandle = setTimeout(() => {
      child.kill();
      done(false);
    }, 1_500);

    child.on("error", () => {
      done(false);
    });
    child.on("close", (code) => {
      done(code === 0);
    });
  });
}
