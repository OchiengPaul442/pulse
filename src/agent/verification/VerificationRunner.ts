import * as vscode from "vscode";

export interface VerificationResult {
  diagnosticsCount: number;
  hasErrors: boolean;
  summary: string;
}

export class VerificationRunner {
  public runDiagnostics(toolHints?: string): VerificationResult {
    const allDiagnostics = vscode.languages.getDiagnostics();
    let errorCount = 0;

    for (const [, diagnostics] of allDiagnostics) {
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
          errorCount += 1;
        }
      }
    }

    return {
      diagnosticsCount: allDiagnostics.reduce(
        (acc, [, diagnostics]) => acc + diagnostics.length,
        0,
      ),
      hasErrors: errorCount > 0,
      summary: (() => {
        const base =
          errorCount > 0
            ? `${errorCount} error diagnostics currently active.`
            : "No error diagnostics reported.";
        if (!toolHints) return base;
        // Append a compact, first-lines-only view of tool hints to keep summaries small
        try {
          const compact = toolHints.split("\n").slice(0, 5).join("; ");
          return `${base} Tool hints: ${compact}`;
        } catch {
          return base;
        }
      })(),
    };
  }
}
