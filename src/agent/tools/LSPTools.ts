import * as vscode from "vscode";

import type { AgentTool } from "./BaseTool";
import { firstString, stringifyError } from "./BaseTool";
import type {
  TaskToolCall,
  TaskToolObservation,
} from "../runtime/TaskProtocols";

export interface LSPToolContext {
  resolvePath(value: string): string | null;
  normalizeDisplay(filePath: string): string;
}

/**
 * get_definitions — Use VS Code's LSP to find where a symbol is defined.
 * Like Copilot's executeDefinitionProvider: accurate, language-aware.
 */
export class GetDefinitionsTool implements AgentTool {
  readonly name = "get_definitions";
  readonly description = "Find where a symbol is defined (LSP-backed)";
  readonly parameterHints = "{filePath, line, character} or {symbol, filePath}";

  constructor(private readonly ctx: LSPToolContext) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const filePath = firstString(
      call.args.filePath,
      call.args.path,
      call.args.file,
    );
    const symbol = firstString(call.args.symbol, call.args.name);

    if (!filePath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "get_definitions requires filePath.",
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
      let line = typeof call.args.line === "number" ? call.args.line : 0;
      let character =
        typeof call.args.character === "number" ? call.args.character : 0;

      // If symbol provided but no position, find the symbol in the file
      if (symbol && line === 0 && character === 0) {
        const raw = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(raw).toString("utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const col = lines[i].indexOf(symbol);
          if (col >= 0) {
            line = i;
            character = col;
            break;
          }
        }
      }

      const position = new vscode.Position(line, character);
      const definitions = await vscode.commands.executeCommand<
        vscode.Location[]
      >("vscode.executeDefinitionProvider", uri, position);

      if (!definitions || definitions.length === 0) {
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `No definitions found for symbol at ${this.ctx.normalizeDisplay(resolved)}:${line + 1}:${character + 1}`,
          },
        ];
      }

      const results = definitions.slice(0, 10).map((loc) => {
        const defPath = this.ctx.normalizeDisplay(loc.uri.fsPath);
        const defLine = loc.range.start.line + 1;
        return `${defPath}:${defLine}`;
      });

      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Found ${definitions.length} definition(s)${symbol ? ` for "${symbol}"` : ""}.`,
          detail: results.join("\n"),
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `get_definitions failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * get_references — Use VS Code's LSP to find all references to a symbol.
 * Accurate, language-aware. Replaces heuristic find_references for LSP-supported languages.
 */
export class GetReferencesTool implements AgentTool {
  readonly name = "get_references";
  readonly description = "Find all references to a symbol (LSP-backed)";
  readonly parameterHints = "{filePath, line, character} or {symbol, filePath}";

  constructor(private readonly ctx: LSPToolContext) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const filePath = firstString(
      call.args.filePath,
      call.args.path,
      call.args.file,
    );
    const symbol = firstString(call.args.symbol, call.args.name);

    if (!filePath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "get_references requires filePath.",
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
      let line = typeof call.args.line === "number" ? call.args.line : 0;
      let character =
        typeof call.args.character === "number" ? call.args.character : 0;

      if (symbol && line === 0 && character === 0) {
        const raw = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(raw).toString("utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const col = lines[i].indexOf(symbol);
          if (col >= 0) {
            line = i;
            character = col;
            break;
          }
        }
      }

      const position = new vscode.Position(line, character);
      const references = await vscode.commands.executeCommand<
        vscode.Location[]
      >("vscode.executeReferenceProvider", uri, position);

      if (!references || references.length === 0) {
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `No references found${symbol ? ` for "${symbol}"` : ""}.`,
          },
        ];
      }

      const results = references.slice(0, 30).map((loc) => {
        const refPath = this.ctx.normalizeDisplay(loc.uri.fsPath);
        const refLine = loc.range.start.line + 1;
        return `${refPath}:${refLine}`;
      });

      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Found ${references.length} reference(s)${symbol ? ` for "${symbol}"` : ""}.`,
          detail: results.join("\n"),
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `get_references failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * get_document_symbols — List all symbols in a file (functions, classes, variables).
 * Useful for understanding file structure before editing.
 */
export class GetDocumentSymbolsTool implements AgentTool {
  readonly name = "get_document_symbols";
  readonly description =
    "List all symbols (functions, classes, etc.) in a file";
  readonly parameterHints = "{filePath}";

  constructor(private readonly ctx: LSPToolContext) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const filePath = firstString(
      call.args.filePath,
      call.args.path,
      call.args.file,
    );
    if (!filePath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "get_document_symbols requires filePath.",
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
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", uri);

      if (!symbols || symbols.length === 0) {
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `No symbols found in ${this.ctx.normalizeDisplay(resolved)}.`,
          },
        ];
      }

      const formatSymbol = (sym: vscode.DocumentSymbol, indent = 0): string => {
        const prefix = "  ".repeat(indent);
        const kind = vscode.SymbolKind[sym.kind] ?? "Unknown";
        const line = sym.range.start.line + 1;
        let result = `${prefix}${kind}: ${sym.name} (line ${line})`;
        if (sym.children?.length) {
          for (const child of sym.children.slice(0, 20)) {
            result += "\n" + formatSymbol(child, indent + 1);
          }
        }
        return result;
      };

      const output = symbols
        .slice(0, 50)
        .map((s) => formatSymbol(s))
        .join("\n");
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Found ${symbols.length} top-level symbol(s) in ${this.ctx.normalizeDisplay(resolved)}.`,
          detail: output.slice(0, 6000),
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `get_document_symbols failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * rename_symbol — LSP-backed rename across the workspace.
 * Safe, language-aware rename that updates all references.
 */
export class RenameSymbolTool implements AgentTool {
  readonly name = "rename_symbol";
  readonly description = "Rename a symbol across the workspace (LSP-backed)";
  readonly parameterHints =
    "{filePath, line, character, newName} or {symbol, filePath, newName}";

  constructor(private readonly ctx: LSPToolContext) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const filePath = firstString(
      call.args.filePath,
      call.args.path,
      call.args.file,
    );
    const newName = firstString(
      call.args.newName,
      call.args.to,
      call.args.name,
    );
    const symbol = firstString(
      call.args.symbol,
      call.args.oldName,
      call.args.from,
    );

    if (!filePath || !newName) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "rename_symbol requires filePath and newName.",
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
      let line = typeof call.args.line === "number" ? call.args.line : 0;
      let character =
        typeof call.args.character === "number" ? call.args.character : 0;

      if (symbol && line === 0 && character === 0) {
        const raw = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(raw).toString("utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const col = lines[i].indexOf(symbol);
          if (col >= 0) {
            line = i;
            character = col;
            break;
          }
        }
      }

      const position = new vscode.Position(line, character);
      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        "vscode.executeDocumentRenameProvider",
        uri,
        position,
        newName,
      );

      if (!edit) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Rename not supported for this symbol${symbol ? ` ("${symbol}")` : ""}.`,
          },
        ];
      }

      const entries = edit.entries();
      const fileCount = entries.length;
      let totalEdits = 0;
      for (const [, edits] of entries) {
        totalEdits += edits.length;
      }

      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "Failed to apply rename edits.",
          },
        ];
      }

      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Renamed${symbol ? ` "${symbol}"` : ""} to "${newName}" — ${totalEdits} edit(s) across ${fileCount} file(s).`,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `rename_symbol failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}
