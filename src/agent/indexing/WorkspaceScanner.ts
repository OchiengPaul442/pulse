import * as vscode from "vscode";

export interface WorkspaceStats {
  totalFiles: number;
  indexedAt: string;
}

export class WorkspaceScanner {
  public async scanWorkspace(): Promise<WorkspaceStats> {
    const files = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,dist,.git}/**",
      5000,
    );
    return {
      totalFiles: files.length,
      indexedAt: new Date().toISOString(),
    };
  }

  public async findRelevantFiles(query: string, limit = 12): Promise<string[]> {
    const lowered = query.toLowerCase();
    const files = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,dist,.git}/**",
      3000,
    );

    const ranked = files
      .map((f) => f.fsPath)
      .filter((p) => p.toLowerCase().includes(lowered))
      .slice(0, limit);

    if (ranked.length > 0) {
      return ranked;
    }

    return files.map((f) => f.fsPath).slice(0, limit);
  }

  public async readContextSnippets(
    paths: string[],
    maxChars = 4000,
  ): Promise<Array<{ path: string; content: string }>> {
    const snippets: Array<{ path: string; content: string }> = [];

    for (const path of paths) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
        const text = Buffer.from(bytes).toString("utf8");
        snippets.push({
          path,
          content: text.slice(0, maxChars),
        });
      } catch {
        // Skip unreadable files.
      }
    }

    return snippets;
  }
}
