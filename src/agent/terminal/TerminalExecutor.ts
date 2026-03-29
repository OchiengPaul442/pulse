/**
 * Terminal command executor for Pulse agent.
 * Executes commands in a real shell process so output can be captured reliably.
 * Supports a persistent visible "Pulse Agent" terminal for user visibility.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import * as path from "path";
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
    let cwd = options?.cwd ?? this.getWorkspaceRoot() ?? undefined;

    if (cwd && !existsSync(cwd)) {
      const fallback = this.getWorkspaceRoot();
      cwd = fallback && existsSync(fallback) ? fallback : undefined;
    }

    const preflight = this.preflightCommand(command, cwd);
    if (!preflight.ok) {
      return {
        exitCode: 127,
        output: preflight.message,
        command,
        durationMs: 0,
        timedOut: false,
      };
    }

    // Mirror to visible terminal if requested
    if (options?.showInTerminal) {
      this.sendToAgentTerminal(command);
    }

    const start = Date.now();
    const shell = this.resolveShellCommand(command);

    return new Promise<TerminalExecResult>((resolve) => {
      let output = "";
      let resolved = false;
      const child = spawn(shell.executable, shell.args, {
        cwd,
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
          output: output.slice(-12_000),
          command,
          durationMs: Date.now() - start,
          timedOut,
        });
      };

      const timeoutHandle = setTimeout(() => {
        this.killProcessTree(child.pid);
        output += `\n[timeout] Command exceeded ${Math.round(timeout / 1000)}s and was terminated.`;
        finish(null, true);
      }, timeout);

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });

      child.on("error", (err) => {
        output += this.formatSpawnError(err, command, cwd);
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

  private resolveShellCommand(command: string): {
    executable: string;
    args: string[];
  } {
    if (process.platform === "win32") {
      const shell = this.findWindowsShell();
      if (
        shell.toLowerCase().endsWith("pwsh.exe") ||
        shell.toLowerCase().endsWith("powershell.exe")
      ) {
        return {
          executable: shell,
          args: [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
          ],
        };
      }

      return {
        executable: shell,
        args: ["/d", "/s", "/c", command],
      };
    }

    const preferred = process.env.SHELL;
    const shell =
      preferred && existsSync(preferred)
        ? preferred
        : existsSync("/bin/bash")
          ? "/bin/bash"
          : "/bin/sh";
    return {
      executable: shell,
      args: ["-lc", command],
    };
  }

  private findWindowsShell(): string {
    const candidates = [
      process.env.PWSH_PATH,
      path.join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "PowerShell",
        "7",
        "pwsh.exe",
      ),
      path.join(
        process.env.WINDIR ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      process.env.COMSPEC,
      "cmd.exe",
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      if (candidate.toLowerCase() === "cmd.exe") {
        return candidate;
      }
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return "cmd.exe";
  }

  private preflightCommand(
    command: string,
    cwd?: string,
  ): { ok: true } | { ok: false; message: string } {
    const executable = this.extractExecutable(command);
    if (!executable) {
      return {
        ok: false,
        message: "No executable command was provided.",
      };
    }

    if (this.isShellBuiltin(executable)) {
      return { ok: true };
    }

    if (this.isPathLikeExecutable(executable)) {
      const absolute = path.isAbsolute(executable)
        ? executable
        : cwd
          ? path.resolve(cwd, executable)
          : path.resolve(executable);
      if (existsSync(absolute)) {
        return { ok: true };
      }

      return {
        ok: false,
        message: `Executable path not found: ${absolute}`,
      };
    }

    if (this.findExecutableInPath(executable)) {
      return { ok: true };
    }

    return {
      ok: false,
      message:
        `Executable not found in PATH: ${executable}. ` +
        "Install the tool or run an equivalent command available in this shell.",
    };
  }

  private extractExecutable(command: string): string | null {
    const tokens = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    if (tokens.length === 0) {
      return null;
    }

    for (const token of tokens) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*=.*/.test(token)) {
        continue;
      }
      if (token === "&&" || token === "||" || token === "|") {
        continue;
      }
      if (token === "sudo") {
        continue;
      }
      return token.replace(/^['"]+|['"]+$/g, "");
    }

    return null;
  }

  private isShellBuiltin(executable: string): boolean {
    const lower = executable.toLowerCase();
    const builtins = new Set([
      "cd",
      "echo",
      "pwd",
      "dir",
      "ls",
      "cat",
      "type",
      "set",
      "export",
      "alias",
      "which",
      "where",
      "test",
      "true",
      "false",
    ]);
    return builtins.has(lower);
  }

  private isPathLikeExecutable(executable: string): boolean {
    return (
      executable.startsWith("./") ||
      executable.startsWith("../") ||
      executable.startsWith("/") ||
      executable.includes("\\") ||
      /^[a-zA-Z]:[\\/]/.test(executable)
    );
  }

  private findExecutableInPath(executable: string): boolean {
    const pathEnv = process.env.PATH ?? "";
    const directories = pathEnv
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (directories.length === 0) {
      return false;
    }

    const candidates = this.executableCandidates(executable);
    for (const directory of directories) {
      for (const candidate of candidates) {
        const fullPath = path.join(directory, candidate);
        if (existsSync(fullPath)) {
          return true;
        }
      }
    }

    return false;
  }

  private executableCandidates(executable: string): string[] {
    if (process.platform !== "win32") {
      return [executable];
    }

    const lower = executable.toLowerCase();
    const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0);

    const hasKnownExtension = pathExt.some((ext) => lower.endsWith(ext));
    if (hasKnownExtension) {
      return [executable];
    }

    return [executable, ...pathExt.map((ext) => `${executable}${ext}`)];
  }

  private killProcessTree(pid: number | undefined): void {
    if (!pid || pid <= 0) {
      return;
    }

    if (process.platform === "win32") {
      try {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.unref();
      } catch {
        // Best effort; fall back to direct kill below.
        try {
          process.kill(pid);
        } catch {
          // ignore
        }
      }
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }

    setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore if already exited
      }
    }, 1500);
  }

  private formatSpawnError(
    error: unknown,
    command: string,
    cwd?: string,
  ): string {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "";

    if (code.toUpperCase() === "ENOENT") {
      const cwdHint = cwd ? ` Working directory: ${cwd}.` : "";
      return `Executable lookup failed (ENOENT) while running: ${command}.${cwdHint} Verify the command exists and PATH is configured for the extension host.`;
    }

    return `Error: ${message}`;
  }
}
