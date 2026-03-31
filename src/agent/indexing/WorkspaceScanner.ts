import * as vscode from "vscode";

export interface WorkspaceStats {
  totalFiles: number;
  indexedAt: string;
}

export interface WorkspaceInventory {
  totalFiles: number;
  listedFiles: string[];
  truncated: boolean;
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

  public async collectWorkspaceInventory(
    limit = 250,
  ): Promise<WorkspaceInventory> {
    const files = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,dist,.git,out,coverage,.pulse}/**",
      5000,
    );

    const listedFiles = files.slice(0, limit).map((file) => file.fsPath);

    return {
      totalFiles: files.length,
      listedFiles,
      truncated: files.length > listedFiles.length,
      indexedAt: new Date().toISOString(),
    };
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

    // ── IDF-like term weighting ────────────────────────────────────
    // Count how many file paths contain each keyword (document frequency).
    // Keywords that appear in fewer paths are more discriminating.
    const docFreq = new Map<string, number>();
    for (const kw of keywords) {
      let count = 0;
      for (const fp of allPaths) {
        if (fp.toLowerCase().includes(kw)) {
          count++;
        }
      }
      // IDF = log(N / (1 + df))  — +1 avoids division by zero
      docFreq.set(kw, Math.log(allPaths.length / (1 + count)));
    }

    // ── Fetch modification times for recency bonus ─────────────────
    // Sample up to 500 files to keep this fast; uses Promise.allSettled
    // so we don't block on unreadable files.
    const recencyMap = new Map<string, number>();
    const statBatch = files.slice(0, 500);
    const stats = await Promise.allSettled(
      statBatch.map(async (file) => {
        const stat = await vscode.workspace.fs.stat(file);
        return { fsPath: file.fsPath, mtime: stat.mtime };
      }),
    );
    let latestMtime = 0;
    for (const result of stats) {
      if (result.status === "fulfilled") {
        recencyMap.set(result.value.fsPath, result.value.mtime);
        if (result.value.mtime > latestMtime) {
          latestMtime = result.value.mtime;
        }
      }
    }
    // Age window: files modified within the last 24 hours get the full
    // recency bonus; files older than 7 days get none.
    const ONE_DAY = 86_400_000;
    const RECENCY_WINDOW = 7 * ONE_DAY;

    // Score each file path based on keyword matches + IDF + recency
    const scored = allPaths.map((filePath) => {
      const lower = filePath.toLowerCase();
      const segments = lower.split(/[/\\]/);
      const basename = segments.pop() ?? "";
      const ext = basename.split(".").pop() ?? "";
      let score = 0;

      for (const kw of keywords) {
        const idf = docFreq.get(kw) ?? 1;

        // Exact filename match (highest signal)
        if (basename === kw || basename.startsWith(kw + ".")) {
          score += 10 * idf;
        }
        // Basename contains keyword
        else if (basename.includes(kw)) {
          score += 5 * idf;
        }
        // Directory path contains keyword
        else if (lower.includes(kw)) {
          score += 2 * idf;
        }
      }

      // ── File-type weighting ────────────────────────────────────
      if (SOURCE_EXTENSIONS.has(ext)) {
        score += 1.5;
      } else if (CONFIG_EXTENSIONS.has(ext)) {
        score += 0.5;
      }

      // ── Recency bonus (0 – 3 points) ─────────────────────────
      const mtime = recencyMap.get(filePath);
      if (mtime !== undefined && latestMtime > 0) {
        const age = latestMtime - mtime;
        if (age < RECENCY_WINDOW) {
          score += 3 * (1 - age / RECENCY_WINDOW);
        }
      }

      // ── Path depth penalty ────────────────────────────────────
      // Very deep files (> 5 segments) are slightly less likely to be
      // the "right" file for a broad query.
      if (segments.length > 5) {
        score -= 0.5 * (segments.length - 5);
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
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; matches: string[] }>> {
    if (signal?.aborted) {
      return [];
    }

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

    const batchSize = 24;
    for (let start = 0; start < files.length; start += batchSize) {
      if (signal?.aborted) {
        break;
      }

      const batch = files.slice(start, start + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (file) => {
          if (signal?.aborted) {
            return null;
          }

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
                    const startLine = Math.max(0, i - 1);
                    const endLine = Math.min(lines.length, i + 2);
                    matchingLines.push(
                      lines
                        .slice(startLine, endLine)
                        .map((l, idx) => `${startLine + idx + 1}: ${l}`)
                        .join("\n"),
                    );
                  }
                }
              }
            }

            return score > 0
              ? { path: file.fsPath, matches: matchingLines, score }
              : null;
          } catch {
            // Skip unreadable files
            return null;
          }
        }),
      );

      for (const result of batchResults) {
        if (result) {
          results.push(result);
        }
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
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; content: string }>> {
    if (signal?.aborted) {
      return [];
    }

    const snippets = await Promise.all(
      paths.map(async (filePath) => {
        if (signal?.aborted) {
          return null;
        }

        try {
          const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.file(filePath),
          );
          const text = Buffer.from(bytes).toString("utf8");
          return {
            path: filePath,
            content: text.slice(0, maxChars),
          };
        } catch {
          return null;
        }
      }),
    );

    return snippets.filter(
      (snippet): snippet is { path: string; content: string } =>
        snippet !== null,
    );
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

const SOURCE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mts",
  "mjs",
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
  "swift",
  "kt",
  "scala",
]);

const CONFIG_EXTENSIONS = new Set([
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "ini",
  "cfg",
  "env",
  "lock",
  "md",
  "txt",
]);
