import * as vscode from "vscode";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  debug(message: string): void;
  dispose(): void;
}

export function createLogger(): Logger {
  const channel = vscode.window.createOutputChannel("Pulse");

  function format(
    level: "INFO" | "WARN" | "ERROR" | "DEBUG",
    message: string,
  ): string {
    return `${new Date().toISOString()} [${level}] ${message}`;
  }

  return {
    info(message: string): void {
      channel.appendLine(format("INFO", message));
    },
    warn(message: string): void {
      channel.appendLine(format("WARN", message));
    },
    error(message: string, error?: unknown): void {
      const suffix =
        error instanceof Error
          ? ` | ${error.message}`
          : error
            ? ` | ${String(error)}`
            : "";
      channel.appendLine(format("ERROR", `${message}${suffix}`));
    },
    debug(message: string): void {
      channel.appendLine(format("DEBUG", message));
    },
    dispose(): void {
      channel.dispose();
    },
  };
}
