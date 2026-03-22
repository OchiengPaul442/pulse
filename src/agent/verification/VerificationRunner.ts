import * as vscode from "vscode";

export interface VerificationResult {
  diagnosticsCount: number;
  hasErrors: boolean;
  summary: string;
}

export class VerificationRunner {
  public runDiagnostics(): VerificationResult {
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
      summary:
        errorCount > 0
          ? `${errorCount} error diagnostics currently active.`
          : "No error diagnostics reported.",
    };
  }
}
