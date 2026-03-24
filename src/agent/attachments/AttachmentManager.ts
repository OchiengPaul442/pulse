/**
 * Manages file attachments for the agent chat context.
 * Handles validation, metadata extraction, size limits, and serialization.
 */
import * as path from "path";
import * as vscode from "vscode";

export interface AttachmentMeta {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Workspace-relative path (or absolute if outside workspace). */
  relativePath: string;
  /** Display name (file basename or folder name). */
  name: string;
  /** File size in bytes (0 for directories). */
  sizeBytes: number;
  /** Detected MIME-like type hint. */
  type: "text" | "code" | "config" | "image" | "binary" | "directory";
  /** File extension without the dot. */
  extension: string;
}

export interface AttachmentContent {
  meta: AttachmentMeta;
  /** Text content (null for binary/unsupported files). */
  content: string | null;
  /** Whether the content was truncated due to size limits. */
  truncated: boolean;
}

export interface AttachmentLimits {
  /** Maximum total attachments per session. */
  maxFiles: number;
  /** Maximum single file size in bytes. */
  maxFileSizeBytes: number;
  /** Maximum total payload size in bytes. */
  maxTotalSizeBytes: number;
}

const DEFAULT_LIMITS: AttachmentLimits = {
  maxFiles: 20,
  maxFileSizeBytes: 512 * 1024, // 512 KB per file
  maxTotalSizeBytes: 2 * 1024 * 1024, // 2 MB total
};

const TEXT_EXTENSIONS = new Set([
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
  "R",
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
  "md",
  "mdx",
  "txt",
  "rst",
  "adoc",
  "org",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "xml",
  "svg",
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
  "env",
  "env.local",
  "env.development",
  "env.production",
  "gitignore",
  "gitattributes",
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
  "lock",
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
  "svg",
]);

export class AttachmentManager {
  private readonly limits: AttachmentLimits;
  private readonly workspaceRoot: string | null;

  public constructor(limits?: Partial<AttachmentLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  /**
   * Resolve metadata for a list of file paths.
   * Validates limits and returns enriched metadata.
   */
  public async resolveAttachments(
    paths: string[],
  ): Promise<{
    accepted: AttachmentMeta[];
    rejected: Array<{ path: string; reason: string }>;
  }> {
    const accepted: AttachmentMeta[] = [];
    const rejected: Array<{ path: string; reason: string }> = [];

    const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];

    for (const rawPath of unique) {
      if (accepted.length >= this.limits.maxFiles) {
        rejected.push({
          path: rawPath,
          reason: `Exceeds max file limit (${this.limits.maxFiles}).`,
        });
        continue;
      }

      const absolutePath = path.isAbsolute(rawPath)
        ? rawPath
        : this.workspaceRoot
          ? path.join(this.workspaceRoot, rawPath)
          : rawPath;

      try {
        const stat = await vscode.workspace.fs.stat(
          vscode.Uri.file(absolutePath),
        );

        if (stat.type === vscode.FileType.Directory) {
          accepted.push({
            absolutePath,
            relativePath: this.toRelativePath(absolutePath),
            name: path.basename(absolutePath),
            sizeBytes: 0,
            type: "directory",
            extension: "",
          });
          continue;
        }

        if (stat.size > this.limits.maxFileSizeBytes) {
          rejected.push({
            path: rawPath,
            reason: `File too large (${formatBytes(stat.size)} > ${formatBytes(this.limits.maxFileSizeBytes)}).`,
          });
          continue;
        }

        const ext = path.extname(absolutePath).replace(/^\./, "").toLowerCase();
        const type = classifyExtension(ext);

        accepted.push({
          absolutePath,
          relativePath: this.toRelativePath(absolutePath),
          name: path.basename(absolutePath),
          sizeBytes: stat.size,
          type,
          extension: ext,
        });
      } catch {
        rejected.push({
          path: rawPath,
          reason: "File not found or unreadable.",
        });
      }
    }

    return { accepted, rejected };
  }

  /**
   * Read the text content of attachments that are text-based.
   * Returns content with size limits enforced.
   */
  public async readAttachmentContents(
    metas: AttachmentMeta[],
    maxCharsPerFile = 8000,
  ): Promise<AttachmentContent[]> {
    const results: AttachmentContent[] = [];
    let totalBytes = 0;

    for (const meta of metas) {
      if (meta.type === "directory") {
        // Expand directory to child files (shallow, limited)
        const children = await this.expandDirectory(meta.absolutePath, 10);
        for (const child of children) {
          if (totalBytes >= this.limits.maxTotalSizeBytes) break;
          const content = await this.readSingleFile(child, maxCharsPerFile);
          if (content) {
            totalBytes += content.meta.sizeBytes;
            results.push(content);
          }
        }
        continue;
      }

      if (meta.type === "binary" || meta.type === "image") {
        results.push({ meta, content: null, truncated: false });
        continue;
      }

      if (totalBytes >= this.limits.maxTotalSizeBytes) {
        results.push({ meta, content: null, truncated: true });
        continue;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.file(meta.absolutePath),
        );
        const text = Buffer.from(bytes).toString("utf8");
        const truncated = text.length > maxCharsPerFile;
        const content = truncated ? text.slice(0, maxCharsPerFile) : text;
        totalBytes += bytes.byteLength;

        results.push({ meta, content, truncated });
      } catch {
        results.push({ meta, content: null, truncated: false });
      }
    }

    return results;
  }

  /**
   * Serialize attachment contents into a format suitable for model context.
   */
  public serializeForContext(contents: AttachmentContent[]): string {
    const sections: string[] = ["Attached file context:"];

    for (const item of contents) {
      if (item.content === null) {
        sections.push(
          `File: ${item.meta.relativePath} (${item.meta.type}, not readable as text)`,
        );
        continue;
      }

      const truncNote = item.truncated ? " [truncated]" : "";
      sections.push(
        `File: ${item.meta.relativePath} (${formatBytes(item.meta.sizeBytes)})${truncNote}\n${item.content}`,
      );
    }

    return sections.join("\n\n");
  }

  private toRelativePath(absolutePath: string): string {
    if (!this.workspaceRoot) return absolutePath;
    const rel = path.relative(this.workspaceRoot, absolutePath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel;
    }
    return absolutePath;
  }

  private async expandDirectory(
    dirPath: string,
    limit: number,
  ): Promise<AttachmentMeta[]> {
    try {
      const uri = vscode.Uri.file(dirPath);
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(uri, "**/*"),
        "**/{node_modules,dist,.git,__pycache__}/**",
        limit,
      );

      return files.map((f) => {
        const ext = path.extname(f.fsPath).replace(/^\./, "").toLowerCase();
        return {
          absolutePath: f.fsPath,
          relativePath: this.toRelativePath(f.fsPath),
          name: path.basename(f.fsPath),
          sizeBytes: 0,
          type: classifyExtension(ext),
          extension: ext,
        };
      });
    } catch {
      return [];
    }
  }

  private async readSingleFile(
    meta: AttachmentMeta,
    maxChars: number,
  ): Promise<AttachmentContent | null> {
    if (meta.type === "binary" || meta.type === "image") {
      return null;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(meta.absolutePath),
      );
      const text = Buffer.from(bytes).toString("utf8");
      const truncated = text.length > maxChars;
      return {
        meta: { ...meta, sizeBytes: bytes.byteLength },
        content: truncated ? text.slice(0, maxChars) : text,
        truncated,
      };
    } catch {
      return null;
    }
  }
}

function classifyExtension(ext: string): AttachmentMeta["type"] {
  if (!ext) return "text";
  if (TEXT_EXTENSIONS.has(ext)) {
    if (
      ["json", "yaml", "yml", "toml", "ini", "cfg", "env"].some(
        (c) => ext === c,
      )
    ) {
      return "config";
    }
    if (["md", "mdx", "txt", "rst", "adoc", "org"].some((t) => ext === t)) {
      return "text";
    }
    return "code";
  }
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "binary";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
