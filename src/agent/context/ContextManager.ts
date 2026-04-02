/**
 * ContextManager — unified file context system.
 *
 * Replaces the old AttachmentManager with a cleaner, token-aware design:
 *   - Resolves files/directories to enriched metadata.
 *   - Reads content with per-file and total budget caps.
 *   - Serializes context for model prompts.
 *   - Integrates with TokenBudget for accurate tracking.
 *
 * All methods are async and cancellable via AbortSignal.
 */

import * as path from "path";
import * as vscode from "vscode";

import { TokenBudget } from "./TokenBudget";

// ── Public types ─────────────────────────────────────────────────────

export interface ContextFile {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Workspace-relative path (falls back to absolute). */
  relativePath: string;
  /** Display name. */
  name: string;
  /** Size in bytes (0 for directories). */
  sizeBytes: number;
  /** Broad category. */
  kind: "code" | "config" | "text" | "image" | "binary" | "directory";
  /** Extension without the leading dot. */
  extension: string;
}

export interface ContextFileContent {
  file: ContextFile;
  /** null for binary / image / unreadable files. */
  content: string | null;
  /** Estimated token count for this content. */
  tokens: number;
  /** Whether content was truncated. */
  truncated: boolean;
}

export interface ContextLimits {
  /** Maximum files per session (default 20). */
  maxFiles: number;
  /** Maximum bytes per single file (default 512 KB). */
  maxFileSizeBytes: number;
  /** Maximum total payload bytes across all files (default 2 MB). */
  maxTotalBytes: number;
  /** Maximum characters per file when reading content (default 8000). */
  maxCharsPerFile: number;
}

export interface ContextSnapshot {
  files: ContextFile[];
  totalTokens: number;
  serialized: string;
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_LIMITS: ContextLimits = {
  maxFiles: 20,
  maxFileSizeBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxCharsPerFile: 8_000,
};

// ── Extension classifications ────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "mts",
  "cjs",
  "cts",
  "py",
  "pyw",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "cs",
  "fs",
  "cpp",
  "c",
  "h",
  "hpp",
  "cc",
  "cxx",
  "swift",
  "m",
  "mm",
  "scala",
  "clj",
  "cljs",
  "erl",
  "ex",
  "exs",
  "lua",
  "php",
  "pl",
  "pm",
  "r",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "gql",
  "proto",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  "njk",
  "ejs",
  "hbs",
  "pug",
]);

const CONFIG_EXTENSIONS = new Set([
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "xml",
  "env",
  "lock",
  "editorconfig",
  "prettierrc",
  "eslintrc",
  "babelrc",
  "browserslistrc",
  "dockerfile",
  "dockerignore",
  "makefile",
  "cmake",
  "tf",
  "hcl",
  "gitignore",
  "gitattributes",
]);

const TEXT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "rst",
  "adoc",
  "org",
  "svg",
]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "avif",
]);

function classifyExtension(ext: string): ContextFile["kind"] {
  if (!ext) return "text";
  const lower = ext.toLowerCase();
  if (CODE_EXTENSIONS.has(lower)) return "code";
  if (CONFIG_EXTENSIONS.has(lower)) return "config";
  if (TEXT_EXTENSIONS.has(lower)) return "text";
  if (IMAGE_EXTENSIONS.has(lower)) return "image";
  return "binary";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── ContextManager ──────────────────────────────────────────────────

export class ContextManager {
  private readonly limits: ContextLimits;
  private readonly workspaceRoot: string | null;

  constructor(limits?: Partial<ContextLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  // ── Resolve ────────────────────────────────────────────────────────

  /**
   * Validate and enrich a list of raw paths into ContextFile metadata.
   * Splits into accepted / rejected with reasons.
   */
  async resolve(
    paths: string[],
    signal?: AbortSignal,
  ): Promise<{
    accepted: ContextFile[];
    rejected: Array<{ path: string; reason: string }>;
  }> {
    const accepted: ContextFile[] = [];
    const rejected: Array<{ path: string; reason: string }> = [];
    const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];

    for (const raw of unique) {
      if (signal?.aborted) break;

      if (accepted.length >= this.limits.maxFiles) {
        rejected.push({
          path: raw,
          reason: `Limit reached (max ${this.limits.maxFiles} files).`,
        });
        continue;
      }

      const abs = path.isAbsolute(raw)
        ? raw
        : this.workspaceRoot
          ? path.join(this.workspaceRoot, raw)
          : raw;

      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(abs));

        if (stat.type === vscode.FileType.Directory) {
          accepted.push(this.buildMeta(abs, 0, "directory", ""));
          continue;
        }

        if (stat.size > this.limits.maxFileSizeBytes) {
          rejected.push({
            path: raw,
            reason: `Too large (${formatBytes(stat.size)} > ${formatBytes(this.limits.maxFileSizeBytes)}).`,
          });
          continue;
        }

        const ext = path.extname(abs).replace(/^\./, "").toLowerCase();
        accepted.push(
          this.buildMeta(abs, stat.size, classifyExtension(ext), ext),
        );
      } catch {
        rejected.push({ path: raw, reason: "Not found or unreadable." });
      }
    }

    return { accepted, rejected };
  }

  // ── Read content ───────────────────────────────────────────────────

  /**
   * Read the text content of resolved ContextFiles.
   * Respects per-file and total byte limits.
   */
  async readContents(
    files: ContextFile[],
    signal?: AbortSignal,
  ): Promise<ContextFileContent[]> {
    const results: ContextFileContent[] = [];
    let totalBytes = 0;

    for (const file of files) {
      if (signal?.aborted) break;

      if (file.kind === "directory") {
        const children = await this.expandDirectory(file.absolutePath, 10);
        for (const child of children) {
          if (signal?.aborted) break;
          if (totalBytes >= this.limits.maxTotalBytes) break;
          const content = await this.readSingle(child);
          if (content) {
            totalBytes += content.file.sizeBytes;
            results.push(content);
          }
        }
        continue;
      }

      if (file.kind === "binary" || file.kind === "image") {
        results.push({
          file,
          content: null,
          tokens: 0,
          truncated: false,
        });
        continue;
      }

      if (totalBytes >= this.limits.maxTotalBytes) {
        results.push({
          file,
          content: null,
          tokens: 0,
          truncated: true,
        });
        continue;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.file(file.absolutePath),
        );
        const text = Buffer.from(bytes).toString("utf8");
        const truncated = text.length > this.limits.maxCharsPerFile;
        const content = truncated
          ? text.slice(0, this.limits.maxCharsPerFile)
          : text;
        totalBytes += bytes.byteLength;

        results.push({
          file: { ...file, sizeBytes: bytes.byteLength },
          content,
          tokens: TokenBudget.estimateTokens(content),
          truncated,
        });
      } catch {
        results.push({
          file,
          content: null,
          tokens: 0,
          truncated: false,
        });
      }
    }

    return results;
  }

  // ── Serialize for prompt ───────────────────────────────────────────

  /**
   * Build a model-ready context string from file contents.
   */
  serialize(contents: ContextFileContent[]): ContextSnapshot {
    const sections: string[] = [];
    let totalTokens = 0;

    for (const item of contents) {
      if (item.content === null) {
        const note =
          item.file.kind === "image"
            ? "(image, not included as text)"
            : item.truncated
              ? "(skipped — total budget exceeded)"
              : "(binary or unreadable)";
        sections.push(`--- ${item.file.relativePath} ${note}`);
        continue;
      }

      const truncNote = item.truncated ? " [truncated]" : "";
      sections.push(
        `--- ${item.file.relativePath} (${formatBytes(item.file.sizeBytes)})${truncNote}\n${item.content}`,
      );
      totalTokens += item.tokens;
    }

    const serialized =
      sections.length > 0
        ? `<attached_context>\n${sections.join("\n\n")}\n</attached_context>`
        : "";

    return {
      files: contents.map((c) => c.file),
      totalTokens,
      serialized,
    };
  }

  // ── Quick helpers ──────────────────────────────────────────────────

  /**
   * One-shot: resolve + read + serialize.
   * Returns the full snapshot ready for injection into the system prompt.
   */
  async buildContext(
    paths: string[],
    signal?: AbortSignal,
  ): Promise<{
    snapshot: ContextSnapshot;
    rejected: Array<{ path: string; reason: string }>;
  }> {
    const { accepted, rejected } = await this.resolve(paths, signal);
    const contents = await this.readContents(accepted, signal);
    const snapshot = this.serialize(contents);
    return { snapshot, rejected };
  }

  // ── Internals ──────────────────────────────────────────────────────

  private buildMeta(
    absolutePath: string,
    sizeBytes: number,
    kind: ContextFile["kind"],
    extension: string,
  ): ContextFile {
    return {
      absolutePath,
      relativePath: this.toRelative(absolutePath),
      name: path.basename(absolutePath),
      sizeBytes,
      kind,
      extension,
    };
  }

  private toRelative(abs: string): string {
    if (!this.workspaceRoot) return abs;
    const rel = path.relative(this.workspaceRoot, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
    return abs;
  }

  private async expandDirectory(
    dirPath: string,
    limit: number,
  ): Promise<ContextFile[]> {
    try {
      const uri = vscode.Uri.file(dirPath);
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(uri, "**/*"),
        "**/{node_modules,dist,.git,__pycache__,coverage,out,.pulse}/**",
        limit,
      );
      return files.map((f) => {
        const ext = path.extname(f.fsPath).replace(/^\./, "").toLowerCase();
        return this.buildMeta(f.fsPath, 0, classifyExtension(ext), ext);
      });
    } catch {
      return [];
    }
  }

  private async readSingle(
    file: ContextFile,
  ): Promise<ContextFileContent | null> {
    if (file.kind === "binary" || file.kind === "image") return null;
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(file.absolutePath),
      );
      const text = Buffer.from(bytes).toString("utf8");
      const truncated = text.length > this.limits.maxCharsPerFile;
      const content = truncated
        ? text.slice(0, this.limits.maxCharsPerFile)
        : text;
      return {
        file: { ...file, sizeBytes: bytes.byteLength },
        content,
        tokens: TokenBudget.estimateTokens(content),
        truncated,
      };
    } catch {
      return null;
    }
  }
}
