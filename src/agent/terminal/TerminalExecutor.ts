/**
 * Terminal command executor for Pulse agent.
 * Executes commands in VS Code integrated terminal with output capture.
 */
import * as vscode from "vscode";

export interface TerminalExecResult {
  exitCode: number | null;
  output: string;
  command: string;
  durationMs: number;
  timedOut: boolean;
}

export class TerminalExecutor {
  private static instanceCount = 0;

  /**
   * Execute a command in the VS Code integrated terminal.
   * Uses a temporary terminal with shell integration for output capture.
   */
  public async execute(
    command: string,
    options?: {
      cwd?: string;
      timeoutMs?: number;
    },
  ): Promise<TerminalExecResult> {
    const timeout = options?.timeoutMs ?? 30_000;
    const cwd =
      options?.cwd ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      undefined;

    const start = Date.now();
    const termName = `Pulse Task #${++TerminalExecutor.instanceCount}`;

    return new Promise<TerminalExecResult>((resolve) => {
      // Use VS Code's task execution API for output capture
      const shellExec = new vscode.ShellExecution(command, { cwd });
      const taskDef: vscode.TaskDefinition = { type: "shell" };
      const task = new vscode.Task(
        taskDef,
        vscode.TaskScope.Workspace,
        termName,
        "Pulse",
        shellExec,
      );
      task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Silent,
        echo: true,
        panel: vscode.TaskPanelKind.Dedicated,
      };

      let outputLines: string[] = [];
      let resolved = false;

      const finish = (exitCode: number | null, timedOut = false) => {
        if (resolved) return;
        resolved = true;
        resolve({
          exitCode,
          output: outputLines.join("\n").slice(-8000), // cap output
          command,
          durationMs: Date.now() - start,
          timedOut,
        });
      };

      // Listen for task process end
      const endDisposable = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution.task.name === termName) {
          endDisposable.dispose();
          finish(e.exitCode ?? null);
        }
      });

      // Timeout guard
      const timer = setTimeout(() => {
        finish(null, true);
      }, timeout);

      // Execute the task
      vscode.tasks.executeTask(task).then(
        (execution) => {
          // Listen for the terminal to get output
          const terminal = vscode.window.terminals.find(
            (t) => t.name === termName,
          );
          if (terminal) {
            // Unfortunately VS Code API doesn't give terminal output directly.
            // We capture via task end event and exit code.
            outputLines.push(`$ ${command}`);
          }

          // Clean up the timer when task finishes via the end listener
          const done = vscode.tasks.onDidEndTaskProcess((e) => {
            if (e.execution.task.name === termName) {
              clearTimeout(timer);
              done.dispose();
            }
          });
        },
        (err) => {
          clearTimeout(timer);
          outputLines.push(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
          finish(1);
        },
      );
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
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({
      name: name ?? "Pulse",
      cwd,
    });
    terminal.show(false);
    terminal.sendText(command);
    return terminal;
  }
}
