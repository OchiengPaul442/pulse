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

  public async listWorkspaceFiles(limit = 250): Promise<string[]> {
    const files = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,dist,.git,out,coverage,.pulse}/**",
      limit,
    );

    return files.map((file) => file.fsPath);
  }

  public async findRelevantFiles(query: string, limit = 12): Promise<string[]> {
    const files = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,dist,.git,out,coverage,.pulse,.next,__pycache__,build,target}/**",
      3000,
    );

    const allPaths = files.map((f) => f.fsPath);
    if (allPaths.length === 0) {
      return [];
    }

    // Extract meaningful keywords from the query (lowercase, min 2 chars)
    const keywords = query
      .toLowerCase()
      .replace(/[^a-z0-9\s_.-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

    if (keywords.length === 0) {
      // No useful keywords → return config/entry files first, then any files
      return allPaths.slice(0, limit);
    }

    // Score each file path based on keyword matches
    const scored = allPaths.map((filePath) => {
      const lower = filePath.toLowerCase();
      const basename = lower.split(/[/\\]/).pop() ?? "";
      const ext = basename.split(".").pop() ?? "";
      let score = 0;

      for (const kw of keywords) {
        // Exact filename match (highest signal)
        if (basename === kw || basename.startsWith(kw + ".")) {
          score += 10;
        }
        // Basename contains keyword
        else if (basename.includes(kw)) {
          score += 5;
        }
        // Directory path contains keyword
        else if (lower.includes(kw)) {
          score += 2;
        }
      }

      // Boost source files over configs/docs
      if (
        [
          "ts",
          "tsx",
          "js",
          "jsx",
          "py",
          "java",
          "rs",
          "go",
          "cs",
          "cpp",
          "c",
          "rb",
          "vue",
          "svelte",
        ].includes(ext)
      ) {
        score += 1;
      }

      return { filePath, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Return files with score > 0, or fall back to first N files
    const matched = scored.filter((s) => s.score > 0);
    if (matched.length > 0) {
      return matched.slice(0, limit).map((s) => s.filePath);
    }

    return allPaths.slice(0, limit);
  }

  public async searchFileContents(
    query: string,
    limit = 10,
    maxCharsPerFile = 3000,
  ): Promise<Array<{ path: string; matches: string[] }>> {
    const files = await vscode.workspace.findFiles(
      "**/*.{ts,tsx,js,jsx,py,java,rs,go,cs,cpp,c,rb,vue,svelte,json,yaml,yml,toml,md}",
      "**/{node_modules,dist,.git,out,coverage,.pulse,.next,__pycache__,build,target}/**",
      2000,
    );

    const keywords = query
      .toLowerCase()
      .replace(/[^a-z0-9\s_.-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

    if (keywords.length === 0) {
      return [];
    }

    const results: Array<{
      path: string;
      matches: string[];
      score: number;
    }> = [];

    for (const file of files) {
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        const text = Buffer.from(bytes)
          .toString("utf8")
          .slice(0, maxCharsPerFile);
        const lower = text.toLowerCase();

        const matchingLines: string[] = [];
        let score = 0;

        for (const kw of keywords) {
          if (lower.includes(kw)) {
            score += 1;
            // Find the line containing the keyword and include context
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (
                lines[i].toLowerCase().includes(kw) &&
                matchingLines.length < 5
              ) {
                const start = Math.max(0, i - 1);
                const end = Math.min(lines.length, i + 2);
                matchingLines.push(
                  lines
                    .slice(start, end)
                    .map((l, idx) => `${start + idx + 1}: ${l}`)
                    .join("\n"),
                );
              }
            }
          }
        }

        if (score > 0) {
          results.push({ path: file.fsPath, matches: matchingLines, score });
        }
      } catch {
        // Skip unreadable files
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => ({
      path: r.path,
      matches: r.matches,
    }));
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

const STOP_WORDS = new Set([
  "the",
  "is",
  "at",
  "in",
  "of",
  "on",
  "to",
  "for",
  "a",
  "an",
  "and",
  "or",
  "it",
  "be",
  "as",
  "do",
  "if",
  "my",
  "so",
  "up",
  "me",
  "by",
  "we",
  "am",
  "this",
  "that",
  "with",
  "from",
  "but",
  "not",
  "are",
  "was",
  "can",
  "has",
  "how",
  "what",
  "when",
  "which",
  "will",
  "all",
  "you",
  "your",
  "code",
  "file",
  "files",
  "please",
  "help",
  "want",
  "need",
  "make",
  "should",
]);
