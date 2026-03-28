/**
 * Terminal command executor for Pulse agent.
 * Executes commands in a real shell process so output can be captured reliably.
 * Supports a persistent visible "Pulse Agent" terminal for user visibility.
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
  private agentTerminal: vscode.Terminal | null = null;

  /**
   * Execute a command in the workspace shell and capture output.
   * If `showInTerminal` is true, also mirrors the command in a visible
   * "Pulse Agent" terminal for user visibility (Copilot-style).
   */
  public async execute(
    command: string,
    options?: {
      cwd?: string;
      timeoutMs?: number;
      showInTerminal?: boolean;
    },
  ): Promise<TerminalExecResult> {
    const timeout = options?.timeoutMs ?? 30_000;
    const cwd = options?.cwd ?? this.getWorkspaceRoot() ?? undefined;

    // Mirror to visible terminal if requested
    if (options?.showInTerminal) {
      this.sendToAgentTerminal(command);
    }

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

  /**
   * Send a command to the persistent "Pulse Agent" terminal.
   * Creates the terminal on first use and reuses it.
   */
  private sendToAgentTerminal(command: string): void {
    try {
      const vscodeApi = this.getVscodeApi();
      // Reuse existing terminal if it's still alive
      if (this.agentTerminal) {
        const alive = vscodeApi.window.terminals.some(
          (t) => t === this.agentTerminal,
        );
        if (!alive) {
          this.agentTerminal = null;
        }
      }
      if (!this.agentTerminal) {
        const cwd = this.getWorkspaceRoot();
        this.agentTerminal = vscodeApi.window.createTerminal({
          name: "Pulse Agent",
          cwd,
          isTransient: true,
        });
      }
      this.agentTerminal.show(true); // true = preserveFocus
      this.agentTerminal.sendText(command);
    } catch {
      // Silently ignore — visible terminal is a convenience, not critical
    }
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
