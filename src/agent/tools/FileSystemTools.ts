import * as path from "path";
import * as vscode from "vscode";

import type { AgentTool } from "./BaseTool";
import { firstString, stringifyError } from "./BaseTool";
import type {
  TaskToolCall,
  TaskToolObservation,
} from "../runtime/TaskProtocols";
import type { StreamBroadcaster } from "../runtime/StreamBroadcaster";

export interface FileToolContext {
  resolvePath(value: string): string | null;
  normalizeDisplay(filePath: string): string;
}

/**
 * write_file — Write/overwrite a file with full content.
 * Unlike create_file (which rejects empty content), this overwrites existing files.
 * This is the Copilot-style "write full file" tool.
 */
export class WriteFileTool implements AgentTool {
  readonly name = "write_file";
  readonly description = "Write or overwrite a file with new content";
  readonly parameterHints = "{filePath, content}";

  constructor(
    private readonly ctx: FileToolContext,
    private readonly broadcaster: StreamBroadcaster,
  ) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const filePath = firstString(call.args.filePath, call.args.path);
    const content =
      typeof call.args.content === "string" ? call.args.content : "";
    if (!filePath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "No file path provided for write_file.",
        },
      ];
    }
    const resolved = this.ctx.resolvePath(filePath);
    if (!resolved) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Path "${filePath}" is outside the workspace.`,
        },
      ];
    }
    try {
      const uri = vscode.Uri.file(resolved);
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(resolved)),
      );
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      const lineCount = content.split("\n").length;
      this.broadcaster.emitFilePatched(path.basename(resolved), lineCount);
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Wrote ${lineCount} lines to ${this.ctx.normalizeDisplay(resolved)}`,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Failed to write file: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * replace_in_file — Targeted search-and-replace within a file.
 * Like Copilot's edit capability: find exact text and replace it.
 * Supports fuzzy whitespace matching for model-generated edits.
 */
export class ReplaceInFileTool implements AgentTool {
  readonly name = "replace_in_file";
  readonly description = "Replace specific text in an existing file";
  readonly parameterHints = "{filePath, oldText, newText}";

  constructor(
    private readonly ctx: FileToolContext,
    private readonly broadcaster: StreamBroadcaster,
  ) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const filePath = firstString(call.args.filePath, call.args.path);
    const oldText = firstString(
      call.args.oldText,
      call.args.search,
      call.args.old,
      call.args.find,
    );
    const newText =
      typeof call.args.newText === "string"
        ? call.args.newText
        : typeof call.args.replace === "string"
          ? call.args.replace
          : typeof call.args.replacement === "string"
            ? call.args.replacement
            : undefined;

    if (!filePath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "replace_in_file requires filePath.",
        },
      ];
    }
    if (oldText === undefined) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "replace_in_file requires oldText.",
        },
      ];
    }
    if (newText === undefined) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "replace_in_file requires newText.",
        },
      ];
    }

    const resolved = this.ctx.resolvePath(filePath);
    if (!resolved) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Path "${filePath}" is outside workspace.`,
        },
      ];
    }

    try {
      const uri = vscode.Uri.file(resolved);
      const raw = await vscode.workspace.fs.readFile(uri);
      let content = Buffer.from(raw).toString("utf8");

      let effectiveOld = oldText;
      if (!content.includes(oldText)) {
        // Fuzzy whitespace matching
        const normalizeLine = (line: string) =>
          line.replace(/^\s+/, (ws) => ws.replace(/\t/g, "  ")).trimEnd();
        const normalizedContent = content
          .split("\n")
          .map(normalizeLine)
          .join("\n");
        const normalizedSearch = oldText
          .split("\n")
          .map(normalizeLine)
          .join("\n");
        if (normalizedContent.includes(normalizedSearch)) {
          content = normalizedContent;
          effectiveOld = normalizedSearch;
        } else {
          return [
            {
              tool: call.tool,
              ok: false,
              summary: `Text not found in ${this.ctx.normalizeDisplay(resolved)}. The oldText must match exactly.`,
              detail: `Searched for:\n${oldText.slice(0, 200)}`,
            },
          ];
        }
      }

      const newContent = content.replace(effectiveOld, newText);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(newContent, "utf8"));
      this.broadcaster.emitFilePatched(
        path.basename(resolved),
        newContent.split("\n").length,
      );
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Replaced text in ${this.ctx.normalizeDisplay(resolved)}`,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * grep_search — Regex or literal search across workspace files.
 * Like Copilot's grep_search: returns matching lines with file:line context.
 */
export class GrepSearchTool implements AgentTool {
  readonly name = "grep_search";
  readonly description = "Search files with regex or literal pattern";
  readonly parameterHints = "{pattern, path?, isRegex?, includePattern?}";

  constructor(private readonly ctx: FileToolContext) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const pattern = firstString(
      call.args.pattern,
      call.args.query,
      call.args.search,
    );
    if (!pattern) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "grep_search requires a pattern.",
        },
      ];
    }

    const includeGlob =
      firstString(call.args.includePattern, call.args.include) ?? "**/*";
    const excludeGlob =
      "**/{node_modules,dist,.git,build,out,.next,coverage}/**";
    const isRegex = call.args.isRegex === true;

    try {
      let regex: RegExp;
      try {
        regex = isRegex
          ? new RegExp(pattern, "gim")
          : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gim");
      } catch {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Invalid regex pattern: ${pattern}`,
          },
        ];
      }

      const files = await vscode.workspace.findFiles(
        includeGlob,
        excludeGlob,
        500,
      );
      const results: string[] = [];
      let matchCount = 0;

      for (const file of files) {
        if (matchCount >= 100) break;
        try {
          const raw = await vscode.workspace.fs.readFile(file);
          const content = Buffer.from(raw).toString("utf8");
          // Skip binary-looking files
          if (content.includes("\0")) continue;

          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (matchCount >= 100) break;
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              results.push(
                `${this.ctx.normalizeDisplay(file.fsPath)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`,
              );
              matchCount++;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      return [
        {
          tool: call.tool,
          ok: results.length > 0,
          summary:
            results.length > 0
              ? `Found ${results.length} match(es) for "${pattern}".`
              : `No matches found for "${pattern}".`,
          detail: results.join("\n").slice(0, 8000),
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `grep_search failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}
