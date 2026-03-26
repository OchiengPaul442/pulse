/**
 * Terminal command executor for Pulse agent.
 * Executes commands in a real shell process so output can be captured reliably.
 */
import { spawn } from "child_process";
import type * as vscode from "vscode";

export interface TerminalExecResult {
  exitCode: number | null;
  output: string;
  command: string;
  durationMs: number;
  timedOut: boolean;
}

export class TerminalExecutor {
  /**
   * Execute a command in the workspace shell and capture output.
   */
  public async execute(
    command: string,
    options?: {
      cwd?: string;
      timeoutMs?: number;
    },
  ): Promise<TerminalExecResult> {
    const timeout = options?.timeoutMs ?? 30_000;
    const cwd = options?.cwd ?? this.getWorkspaceRoot() ?? undefined;

    const start = Date.now();

    return new Promise<TerminalExecResult>((resolve) => {
      let output = "";
      let resolved = false;
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: process.env,
      });

      const finish = (exitCode: number | null, timedOut = false) => {
        if (resolved) return;
        resolved = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        resolve({
          exitCode,
          output: output.slice(-8000),
          command,
          durationMs: Date.now() - start,
          timedOut,
        });
      };

      const timeoutHandle = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Ignore kill failures and fall through to timeout resolution.
        }
        finish(null, true);
      }, timeout);

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });

      child.on("error", (err) => {
        output += `Error: ${err instanceof Error ? err.message : String(err)}`;
        finish(1);
      });

      child.on("close", (code) => {
        finish(code ?? null);
      });
    });
  }

  /**
   * Execute a command and return just the exit code (quick check).
   */
  public async check(command: string): Promise<boolean> {
    const result = await this.execute(command, { timeoutMs: 15_000 });
    return result.exitCode === 0;
  }

  /**
   * Run a command in a visible terminal (for user interaction).
   */
  public runInVisibleTerminal(command: string, name?: string): vscode.Terminal {
    const vscodeApi = this.getVscodeApi();
    const cwd = this.getWorkspaceRoot();
    const terminal = vscodeApi.window.createTerminal({
      name: name ?? "Pulse",
      cwd,
    });
    terminal.show(false);
    terminal.sendText(command);
    return terminal;
  }

  private getWorkspaceRoot(): string | undefined {
    try {
      return this.getVscodeApi().workspace.workspaceFolders?.[0]?.uri.fsPath;
    } catch {
      return undefined;
    }
  }

  private getVscodeApi(): typeof vscode {
    return require("vscode") as typeof vscode;
  }
}
