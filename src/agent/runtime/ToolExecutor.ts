import * as path from "path";
import * as vscode from "vscode";

import type { WorkspaceScanner } from "../indexing/WorkspaceScanner.js";
import type { VerificationRunner } from "../verification/VerificationRunner.js";
import type { GitService } from "../../platform/git/GitService.js";
import type {
  WebSearchService,
  WebSearchResponse,
} from "../search/WebSearchService.js";
import type { StreamBroadcaster } from "./StreamBroadcaster.js";
import type { TerminalExecResult } from "../terminal/TerminalExecutor.js";
import type { TaskToolCall, TaskToolObservation } from "./TaskProtocols.js";
import {
  isSafeTerminalCommand,
  estimateCommandTimeout,
} from "./TaskProtocols.js";
import { ToolCooling } from "../context/ToolCooling.js";

import {
  WriteFileTool,
  ReplaceInFileTool,
  GrepSearchTool,
  GetDefinitionsTool,
  GetReferencesTool,
  GetDocumentSymbolsTool,
  RenameSymbolTool,
  GitCommitTool,
  GitLogTool,
  GitBlameTool,
  GitFileHistoryTool,
  GitStatusTool,
  GitBranchTool,
} from "../tools/index.js";
import type { AgentTool } from "../tools/index.js";
import { ToolRegistry } from "../tooling/ToolRegistry.js";

/**
 * Adapter interface that AgentRuntime implements to provide services
 * needed by tool execution without coupling ToolExecutor to the runtime.
 */
export interface ToolExecutorContext {
  readonly workspaceRoot: string | null;
  readonly allowTerminalExecution: boolean;
  isToolEnabled(tool: string): boolean;
  resolvePath(value: string): string | null;
  normalizeDisplay(filePath: string): string;
  buildWorkspaceInventory(
    limit: number,
  ): Promise<{ totalFiles: number; listedFiles: string[] }>;
  executeTerminalCommand(
    command: string,
    opts: {
      cwd?: string;
      timeoutMs?: number;
      visible?: boolean;
      purpose?: "tool" | "verification" | "manual";
      objective?: string;
    },
  ): Promise<TerminalExecResult | null>;
  researchWeb(query: string): Promise<WebSearchResponse>;
  mcpSummary(): Promise<string>;
  collectVerificationCommands(
    objective: string,
    args?: Record<string, unknown>,
  ): Promise<string[]>;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Encapsulates all agent tool dispatch logic.
 *
 * Extracted from `AgentRuntime` so that tool handling can be tested,
 * extended, and maintained independently of the orchestrator.
 */
export class ToolExecutor {
  private lastTerminalResult: TerminalExecResult | null = null;
  private readonly cooling: ToolCooling;

  /** Tool name → handler function registry. */
  private readonly handlers: Map<
    string,
    (
      call: TaskToolCall,
      objective: string,
      signal?: AbortSignal,
    ) => Promise<TaskToolObservation[]>
  >;

  public constructor(
    private readonly ctx: ToolExecutorContext,
    private readonly scanner: WorkspaceScanner,
    private readonly verifier: VerificationRunner,
    private readonly gitService: GitService,
    private readonly webSearch: WebSearchService,
    private readonly broadcaster: StreamBroadcaster,
    sharedToolRegistry?: ToolRegistry,
    cooling?: ToolCooling,
  ) {
    this.cooling = cooling ?? new ToolCooling();
    this.toolRegistry = sharedToolRegistry ?? new ToolRegistry();
    this.registerDefaultSchemas();
    // Instantiate modular tools
    const fileCtx = {
      resolvePath: (p: string) => ctx.resolvePath(p),
      normalizeDisplay: (p: string) => ctx.normalizeDisplay(p),
    };
    const lspCtx = fileCtx;
    const gitCtx = { workspaceRoot: ctx.workspaceRoot };

    const modularTools: AgentTool[] = [
      new WriteFileTool(fileCtx, broadcaster),
      new ReplaceInFileTool(fileCtx, broadcaster),
      new GrepSearchTool(fileCtx),
      new GetDefinitionsTool(lspCtx),
      new GetReferencesTool(lspCtx),
      new GetDocumentSymbolsTool(lspCtx),
      new RenameSymbolTool(lspCtx),
      new GitCommitTool(gitCtx, gitService),
      new GitLogTool(gitCtx, gitService),
      new GitBlameTool(gitCtx, gitService),
      new GitFileHistoryTool(gitCtx, gitService),
      new GitStatusTool(gitCtx, gitService),
      new GitBranchTool(gitCtx, gitService),
    ];

    this.handlers = new Map([
      ["workspace_scan", (c, o, s) => this.handleWorkspaceScan(c)],
      ["read_files", (c, o, s) => this.handleReadFiles(c, s)],
      ["create_file", (c) => this.handleCreateFile(c)],
      ["create_directory", (c) => this.handleCreateDirectory(c)],
      ["delete_file", (c) => this.handleDeleteFile(c)],
      ["search_files", (c, o, s) => this.handleSearchFiles(c, s)],
      ["list_dir", (c) => this.handleListDir(c)],
      ["run_terminal", (c, o) => this.handleRunTerminal(c, o)],
      [
        "run_verification",
        (c, o, s) => this.runVerificationWorkflow(o, s, c.args),
      ],
      ["web_search", (c, o) => this.handleWebSearch(c, o)],
      ["git_diff", (c) => this.handleGitDiff(c)],
      ["mcp_status", () => this.handleMcpStatus()],
      ["diagnostics", () => this.handleDiagnostics()],
      ["batch_edit", (c) => this.handleBatchEdit(c)],
      ["rename_file", (c) => this.handleRenameFile(c)],
      ["find_references", (c, o, s) => this.handleFindReferences(c, s)],
      ["file_search", (c) => this.handleFileSearch(c)],
      ["get_problems", (c) => Promise.resolve(this.handleGetProblems(c))],
      [
        "get_terminal_output",
        () => Promise.resolve(this.handleGetTerminalOutput()),
      ],
    ]);

    // Register modular tools into the handler map

    // Register modular tools into the handler map
    for (const tool of modularTools) {
      this.handlers.set(tool.name, (c, o, s) => tool.execute(c, o, s));
    }
  }

  private readonly toolRegistry: ToolRegistry;

  private registerDefaultSchemas(): void {
    // run_terminal requires a command string
    this.toolRegistry.register(
      "run_terminal",
      {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      "Execute a shell command in the workspace.",
      "Tool `run_terminal` args: { command: string } — provide a single shell command string. Example: { command: 'npm test' } or { command: 'pnpm run build' }. Avoid destructive operations; prefer read-only, build, or test commands.",
    );

    // read_files accepts either a single path or a paths array
    this.toolRegistry.register(
      "read_files",
      {
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          {
            type: "object",
            properties: { paths: { type: "array", items: { type: "string" } } },
            required: ["paths"],
          },
        ],
      },
      "Read bounded sections of files.",
      "Tool `read_files` args: { path: string } or { paths: string[] } — request small snippets (e.g. function bodies or relevant sections). Example: { path: 'package.json' } or { paths: ['src/index.ts','README.md'] }.",
    );

    // create_file / write_file: require filePath/path and content
    this.toolRegistry.register(
      "create_file",
      {
        oneOf: [
          {
            type: "object",
            properties: {
              filePath: { type: "string" },
              content: { type: "string" },
            },
            required: ["filePath", "content"],
          },
          {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        ],
      },
      "Create a new file with provided content.",
      "Tool `create_file` args: { filePath: string, content: string } — create a new file. Example: { filePath: 'src/newFile.ts', content: 'export default function() { return 1 }' }.",
    );

    this.toolRegistry.register(
      "write_file",
      {
        oneOf: [
          {
            type: "object",
            properties: {
              filePath: { type: "string" },
              content: { type: "string" },
            },
            required: ["filePath", "content"],
          },
          {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        ],
      },
      "Overwrite a file with provided content.",
      "Tool `write_file` args: { filePath: string, content: string } — overwrite an existing file. Example: { filePath: 'src/index.ts', content: '...' } — avoid accidental deletion of important content.",
    );

    // git_commit requires message
    this.toolRegistry.register(
      "git_commit",
      {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      "Create a git commit with the provided message.",
      "Tool `git_commit` args: { message: string } — provide a concise, descriptive commit message.",
    );

    // Additional tool schemas and prompts
    this.toolRegistry.register(
      "workspace_scan",
      {
        type: "object",
        properties: {
          limit: { type: "integer" },
          includeGlobs: { type: "array", items: { type: "string" } },
          excludeGlobs: { type: "array", items: { type: "string" } },
        },
      },
      "Scan workspace for files",
      "Tool `workspace_scan` args: { limit?: number, includeGlobs?: string[], excludeGlobs?: string[] } — return a bounded list of files. Example: { limit: 20, includeGlobs: ['src/**/*.ts'] }.",
    );

    this.toolRegistry.register(
      "create_directory",
      {
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          {
            type: "object",
            properties: { directory: { type: "string" } },
            required: ["directory"],
          },
        ],
      },
      "Create a directory",
      "Tool `create_directory` args: { path: string } — create a directory inside the workspace. Example: { path: 'src/components' }.",
    );

    this.toolRegistry.register(
      "delete_file",
      {
        oneOf: [
          {
            type: "object",
            properties: { filePath: { type: "string" } },
            required: ["filePath"],
          },
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        ],
      },
      "Delete a file (destructive)",
      "Tool `delete_file` args: { filePath: string } — destructive action; requires explicit approval in default mode. Example: { filePath: 'dist/old.js' }.",
    );

    this.toolRegistry.register(
      "search_files",
      {
        oneOf: [
          {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          {
            type: "object",
            properties: { pattern: { type: "string" } },
            required: ["pattern"],
          },
        ],
      },
      "Search file contents",
      "Tool `search_files` args: { query: string } or { pattern: string } — prefer narrow queries and limit matches. Example: { query: 'TODO' } or { pattern: 'TODO' }.",
    );

    this.toolRegistry.register(
      "list_dir",
      {
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          {
            type: "object",
            properties: { directory: { type: "string" } },
            required: ["directory"],
          },
        ],
      },
      "List directory",
      "Tool `list_dir` args: { path: string } — list directory entries (files and folders). Example: { path: 'src' }.",
    );

    this.toolRegistry.register(
      "run_verification",
      {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["tests", "build", "lint", "typecheck"],
              },
            },
            required: ["kind"],
          },
          {
            type: "object",
            properties: {
              commands: { type: "array", items: { type: "string" } },
            },
            required: ["commands"],
          },
        ],
      },
      "Run verification (tests/build/lint)",
      "Tool `run_verification` args: { kind: 'tests'|'build'|'lint'|'typecheck' } or { commands: string[] } — run safe verification commands. Example: { kind: 'tests' } or { commands: ['npm test'] }.",
    );

    this.toolRegistry.register(
      "web_search",
      {
        type: "object",
        properties: {
          query: { type: "string" },
          recencyDays: { type: "integer" },
          maxResults: { type: "integer" },
        },
        required: ["query"],
      },
      "Perform a web search",
      "Tool `web_search` args: { query: string, recencyDays?: number, maxResults?: number } — return summarized search results with citations. Example: { query: 'typescript promises examples', maxResults: 3 }.",
    );

    this.toolRegistry.register(
      "git_diff",
      {
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          { type: "object", properties: { cached: { type: "boolean" } } },
        ],
      },
      "Show git diff",
      "Tool `git_diff` args: { path?: string, cached?: boolean } — return the diff for working tree changes or a file. Example: { path: 'src/index.ts' } or { cached: true }.",
    );

    this.toolRegistry.register(
      "mcp_status",
      { type: "object" },
      "Get MCP servers status",
      "Tool `mcp_status` args: none — returns configured MCP server health and details.",
    );

    this.toolRegistry.register(
      "diagnostics",
      { type: "object", properties: { path: { type: "string" } } },
      "Run diagnostics (VS Code diagnostics)",
      "Tool `diagnostics` args: { path?: string } — return current diagnostics for a file or workspace. Example: { path: 'src/app.ts' }.",
    );

    this.toolRegistry.register(
      "batch_edit",
      {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                search: { type: "string" },
                replace: { type: "string" },
              },
              required: ["filePath"],
            },
          },
        },
        required: ["edits"],
      },
      "Apply multiple edits",
      "Tool `batch_edit` args: { edits: [{ filePath:string, search:string, replace:string }] } — apply multiple in-file replacements. Example: { edits: [{ filePath: 'src/a.ts', search: 'foo', replace: 'bar' }] }.",
    );

    this.toolRegistry.register(
      "rename_file",
      {
        type: "object",
        properties: {
          oldPath: { type: "string" },
          newPath: { type: "string" },
        },
        required: ["oldPath", "newPath"],
      },
      "Rename a file",
      "Tool `rename_file` args: { oldPath: string, newPath: string } — rename/move a file within the workspace. Example: { oldPath: 'src/old.ts', newPath: 'src/new.ts' }.",
    );

    this.toolRegistry.register(
      "find_references",
      {
        type: "object",
        properties: { symbol: { type: "string" }, query: { type: "string" } },
        required: ["symbol"],
      },
      "Find references of a symbol",
      "Tool `find_references` args: { symbol: string } — locate usages of a symbol across the workspace. Example: { symbol: 'MyClass' }.",
    );

    this.toolRegistry.register(
      "file_search",
      {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
      "Search for files by glob",
      "Tool `file_search` args: { pattern: string } — glob pattern (e.g. **/*.ts) to find matching files. Example: { pattern: '**/*.test.ts' }.",
    );

    this.toolRegistry.register(
      "get_problems",
      { type: "object", properties: { filePath: { type: "string" } } },
      "Get diagnostics/problems",
      "Tool `get_problems` args: { filePath?: string } — return diagnostics for a file or workspace. Example: { filePath: 'src/index.ts' }.",
    );

    this.toolRegistry.register(
      "get_terminal_output",
      { type: "object" },
      "Get last terminal output",
      "Tool `get_terminal_output` args: none — returns the last captured terminal output.",
    );

    this.toolRegistry.register(
      "replace_in_file",
      {
        type: "object",
        properties: {
          filePath: { type: "string" },
          search: { type: "string" },
          replace: { type: "string" },
        },
        required: ["filePath", "search", "replace"],
      },
      "Replace text in a file",
      "Tool `replace_in_file` args: { filePath: string, search: string, replace: string } — replace occurrences of search with replacement in the given file. Example: { filePath: 'src/a.ts', search: 'var x', replace: 'const x' }.",
    );

    this.toolRegistry.register(
      "grep_search",
      {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
      "Grep-style search",
      "Tool `grep_search` args: { pattern: string } — search file contents for the pattern. Example: { pattern: 'TODO|FIXME' }.",
    );

    this.toolRegistry.register(
      "get_definitions",
      {
        type: "object",
        properties: {
          filePath: { type: "string" },
          line: { type: "integer" },
          character: { type: "integer" },
        },
        required: ["filePath", "line", "character"],
      },
      "LSP: go to definition",
      "Tool `get_definitions` args: { filePath: string, line: number, character: number } — return definition locations.",
    );

    this.toolRegistry.register(
      "get_references",
      {
        type: "object",
        properties: {
          filePath: { type: "string" },
          line: { type: "integer" },
          character: { type: "integer" },
          includeDeclaration: { type: "boolean" },
        },
        required: ["filePath", "line", "character"],
      },
      "LSP: find references",
      "Tool `get_references` args: { filePath: string, line: number, character: number, includeDeclaration?: boolean } — return symbol usages.",
    );

    this.toolRegistry.register(
      "get_document_symbols",
      {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
      "LSP: document symbols",
      "Tool `get_document_symbols` args: { filePath: string } — return top-level symbols in the document.",
    );

    this.toolRegistry.register(
      "rename_symbol",
      {
        type: "object",
        properties: {
          filePath: { type: "string" },
          line: { type: "integer" },
          character: { type: "integer" },
          newName: { type: "string" },
        },
        required: ["filePath", "line", "character", "newName"],
      },
      "LSP: rename symbol",
      "Tool `rename_symbol` args: { filePath: string, line: number, character: number, newName: string } — perform a safe rename refactor.",
    );

    this.toolRegistry.register(
      "git_log",
      {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer" } },
      },
      "Git log",
      "Tool `git_log` args: { path?: string, limit?: number } — return recent commits or file history.",
    );

    this.toolRegistry.register(
      "git_blame",
      {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
      "Git blame",
      "Tool `git_blame` args: { filePath: string } — show blame annotations for a file.",
    );

    this.toolRegistry.register(
      "git_file_history",
      {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
      "Git file history",
      "Tool `git_file_history` args: { filePath: string } — list commits that touched a file.",
    );

    this.toolRegistry.register(
      "git_status",
      { type: "object" },
      "Git status",
      "Tool `git_status` args: none — summarize working tree state.",
    );

    this.toolRegistry.register(
      "git_branch",
      { type: "object", properties: { name: { type: "string" } } },
      "Git branch operations",
      "Tool `git_branch` args: { name?: string } — list or create/switch branches depending on context.",
    );
  }

  public getLastTerminalResult(): TerminalExecResult | null {
    return this.lastTerminalResult;
  }

  public setLastTerminalResult(result: TerminalExecResult | null): void {
    this.lastTerminalResult = result;
  }

  // ── Batch executor ─────────────────────────────────────────────

  public async executeToolCalls(
    toolCalls: TaskToolCall[],
    objective: string,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]> {
    this.cooling.resetTurn();
    const limitedCalls = toolCalls.slice(0, 5);
    const settled = await Promise.allSettled(
      limitedCalls.map((call) =>
        this.executeSingleToolCall(call, objective, signal),
      ),
    );

    const observations: TaskToolObservation[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        observations.push(...result.value);
        return;
      }

      observations.push({
        tool: limitedCalls[index].tool,
        ok: false,
        summary: `Tool execution failed: ${stringifyError(result.reason)}`,
        detail: limitedCalls[index].reason,
      });
    });

    // Notify model about silently dropped tool calls
    for (let i = 5; i < toolCalls.length; i++) {
      observations.push({
        tool: toolCalls[i].tool,
        ok: false,
        summary: `Tool call dropped: agent issued too many calls in one turn (max 5). Re-issue this call in the next iteration.`,
        detail: toolCalls[i].reason,
      });
    }

    return observations;
  }

  // ── Single tool dispatch ───────────────────────────────────────

  public async executeSingleToolCall(
    call: TaskToolCall,
    objective: string,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]> {
    if (!this.ctx.isToolEnabled(call.tool)) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Tool "${call.tool}" is disabled in tool settings.`,
          detail: "The user has disabled this tool. Use a different approach.",
        },
      ];
    }

    // Cooling gate: check rate limits and failure state
    const coolingCheck = this.cooling.check(call.tool);
    if (!coolingCheck.allowed) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: coolingCheck.reason ?? "Tool on cooldown.",
          detail: "Wait for the next turn or use a different tool.",
        },
      ];
    }

    if (signal?.aborted) {
      throw new Error("__TASK_CANCELLED__");
    }

    const handler = this.handlers.get(call.tool);
    if (!handler) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "Unsupported tool call.",
        },
      ];
    }

    // Validate arguments against the tool registry schema if present
    try {
      const validation = this.toolRegistry.validate(call.tool, call.args ?? {});
      if (!validation.ok) {
        this.cooling.recordFailure(call.tool);
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Tool argument validation failed: ${validation.errors.join("; ")}`,
            detail:
              "Please re-issue the tool call with arguments matching the tool schema.",
          },
        ];
      }
    } catch (err) {
      // Non-fatal: if validator throws, proceed to handler execution
    }

    try {
      const results = await handler(call, objective, signal);
      const anyFailed = results.some((r) => !r.ok);
      if (anyFailed) {
        this.cooling.recordFailure(call.tool);
      } else {
        this.cooling.recordSuccess(call.tool);
      }
      return results;
    } catch (err) {
      this.cooling.recordFailure(call.tool);
      throw err;
    }
  }

  // ── Tool handlers ──────────────────────────────────────────────

  private async handleWorkspaceScan(
    call: TaskToolCall,
  ): Promise<TaskToolObservation[]> {
    const inventory = await this.ctx.buildWorkspaceInventory(250);
    const fileList = inventory.listedFiles.slice(0, 30);
    const hasExistingCode = inventory.totalFiles > 0;
    const preamble = hasExistingCode
      ? `Found ${inventory.totalFiles} existing file(s). IMPORTANT: This workspace already has code. Read and adapt to existing files — do NOT recreate them.`
      : `Empty workspace with ${inventory.totalFiles} file(s). You may create new files as needed.`;
    return [
      {
        tool: call.tool,
        ok: true,
        summary: preamble,
        detail: fileList.join("\n"),
      },
    ];
  }

  private async handleReadFiles(
    call: TaskToolCall,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]> {
    const requestedPaths = ToolExecutor.extractStringList(
      call.args.paths,
      call.args.files,
      call.args.filePaths,
      call.args.path,
    );
    const resolvedPaths = requestedPaths
      .map((item) => this.ctx.resolvePath(item))
      .filter((item): item is string => Boolean(item));
    const snippets = await this.scanner.readContextSnippets(
      resolvedPaths.slice(0, 8),
      6000,
      signal,
    );
    return [
      {
        tool: call.tool,
        ok: snippets.length > 0,
        summary:
          snippets.length > 0
            ? `Read ${snippets.length} file(s).`
            : "No readable files were returned.",
        detail: snippets
          .map(
            (snippet) =>
              `File: ${this.ctx.normalizeDisplay(snippet.path)}\n${snippet.content}`,
          )
          .join("\n\n")
          .slice(0, 8000),
      },
    ];
  }

  private async handleCreateFile(
    call: TaskToolCall,
  ): Promise<TaskToolObservation[]> {
    const filePath = ToolExecutor.firstString(
      call.args.filePath,
      call.args.path,
    );
    const content = ToolExecutor.firstString(call.args.content) ?? "";
    if (!filePath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "No file path was provided for create_file.",
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
    if (content.trim().length === 0) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "create_file requires non-empty content.",
          detail:
            "Use create_directory for folders, then provide the actual file contents for code files.",
        },
      ];
    }
    try {
      const uri = vscode.Uri.file(resolved);
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(resolved)),
      );
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Created file: ${this.ctx.normalizeDisplay(resolved)}`,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Failed to create file: ${stringifyError(err)}`,
        },
      ];
    }
  }

  private async handleCreateDirectory(
    call: TaskToolCall,
  ): Promise<TaskToolObservation[]> {
    const dirPath = ToolExecutor.firstString(
      call.args.path,
      call.args.filePath,
    );
    if (!dirPath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "No directory path was provided for create_directory.",
        },
      ];
    }
    const resolved = this.ctx.resolvePath(dirPath);
    if (!resolved) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Path "${dirPath}" is outside the workspace.`,
        },
      ];
    }
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(resolved));
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Created directory: ${this.ctx.normalizeDisplay(resolved)}`,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Failed to create directory: ${stringifyError(err)}`,
        },
      ];
    }
  }

  private async handleDeleteFile(
    call: TaskToolCall,
  ): Promise<TaskToolObservation[]> {
    const filePath = ToolExecutor.firstString(
      call.args.filePath,
      call.args.path,
    );
    if (!filePath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "No file path was provided for delete_file.",
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
      await vscode.workspace.fs.delete(uri);
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Deleted file: ${this.ctx.normalizeDisplay(resolved)}`,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Failed to delete file: ${stringifyError(err)}`,
        },
      ];
    }
  }

  private async handleSearchFiles(
    call: TaskToolCall,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]> {
    const query =
      ToolExecutor.firstString(
        call.args.query,
        call.args.pattern,
        call.args.search,
      ) ?? "";
    if (!query) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "No search query was provided.",
        },
      ];
    }
    const results = await this.scanner.searchFileContents(
      query,
      8,
      3000,
      signal,
    );
    return [
      {
        tool: call.tool,
        ok: results.length > 0,
        summary:
          results.length > 0
            ? `Found matches in ${results.length} file(s).`
            : "No matches found.",
        detail: results
          .map(
            (r) =>
              `File: ${this.ctx.normalizeDisplay(r.path)}\n${r.matches.join("\n---\n")}`,
          )
          .join("\n\n")
          .slice(0, 5000),
      },
    ];
  }

  private async handleListDir(
    call: TaskToolCall,
  ): Promise<TaskToolObservation[]> {
    const dirPath =
      ToolExecutor.firstString(
        call.args.path,
        call.args.directory,
        call.args.dir,
      ) ?? ".";
    const resolved = this.ctx.resolvePath(dirPath);
    if (!resolved) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Path "${dirPath}" is outside the workspace.`,
        },
      ];
    }
    try {
      const uri = vscode.Uri.file(resolved);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const listing = entries
        .slice(0, 50)
        .map(([name, type]) =>
          type === vscode.FileType.Directory ? `${name}/` : name,
        )
        .join("\n");
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Listed ${entries.length} entries in ${this.ctx.normalizeDisplay(resolved)}.`,
          detail: listing,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Failed to list directory: ${stringifyError(err)}`,
        },
      ];
    }
  }

  private async handleRunTerminal(
    call: TaskToolCall,
    objective: string,
  ): Promise<TaskToolObservation[]> {
    const command = ToolExecutor.firstString(call.args.command, call.args.cmd);
    if (!command) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "No terminal command was provided.",
        },
      ];
    }

    if (!isSafeTerminalCommand(command) && !this.ctx.allowTerminalExecution) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "Terminal execution is disabled for unsafe commands.",
          detail: command,
        },
      ];
    }

    this.broadcaster.emitTerminalRun(command);
    const terminalTimeout = estimateCommandTimeout(command);
    const result = await this.ctx.executeTerminalCommand(command, {
      cwd: this.ctx.workspaceRoot ?? undefined,
      timeoutMs: terminalTimeout,
      purpose: "tool",
      objective,
    });
    if (result) {
      this.lastTerminalResult = result;
    }
    this.broadcaster.emitTerminalOutput(
      result?.command ?? command,
      result ? result.output.slice(0, 5000) : "",
      result?.exitCode ?? null,
    );
    return [
      {
        tool: call.tool,
        ok: result !== null && result.exitCode === 0,
        summary: result
          ? result.interactivePrompt
            ? `Stopped at an interactive prompt after ${result.durationMs}ms.`
            : result.timedOut
              ? `Timed out after ${result.durationMs}ms.`
              : `Exit ${result.exitCode ?? "unknown"} in ${result.durationMs}ms.`
          : "Terminal command was blocked.",
        detail: result ? result.output.slice(0, 5000) : command,
      },
    ];
  }

  private async handleWebSearch(
    call: TaskToolCall,
    objective: string,
  ): Promise<TaskToolObservation[]> {
    const query = ToolExecutor.firstString(call.args.query) ?? objective;
    const result = await this.ctx.researchWeb(query);
    return [
      {
        tool: call.tool,
        ok: true,
        summary: `Web search returned ${result.results.length} result(s).`,
        detail: this.webSearch.formatResult(result).slice(0, 5000),
      },
    ];
  }

  private async handleGitDiff(
    call: TaskToolCall,
  ): Promise<TaskToolObservation[]> {
    const filePath = ToolExecutor.firstString(
      call.args.filePath,
      call.args.path,
    );
    if (filePath) {
      const diff = await this.gitService.getFileDiff(
        this.ctx.resolvePath(filePath) ?? filePath,
      );
      return [
        {
          tool: call.tool,
          ok: diff !== null,
          summary: diff
            ? `Loaded diff for ${this.ctx.normalizeDisplay(diff.path)}.`
            : "No diff available.",
          detail: diff?.diff.slice(0, 5000),
        },
      ];
    }

    const diffSummary = await this.gitService.getDiffSummary();
    return [
      {
        tool: call.tool,
        ok: diffSummary.isGitRepo,
        summary: diffSummary.summary,
        detail: JSON.stringify(diffSummary, null, 2).slice(0, 5000),
      },
    ];
  }

  private async handleMcpStatus(): Promise<TaskToolObservation[]> {
    const summary = await this.ctx.mcpSummary();
    return [
      {
        tool: "mcp_status",
        ok: true,
        summary: "Loaded MCP connection summary.",
        detail: summary.slice(0, 5000),
      },
    ];
  }

  private async handleDiagnostics(): Promise<TaskToolObservation[]> {
    const toolHints = (() => {
      try {
        const regs = this.toolRegistry.list();
        const toolLines = regs
          .slice(0, 10)
          .map((r) => `- ${r.name}: ${r.prompt ?? r.description ?? ""}`);
        return toolLines.join("\n").slice(0, 1200);
      } catch {
        return "";
      }
    })();
    const diagnostics = this.verifier.runDiagnostics(toolHints);
    return [
      {
        tool: "diagnostics",
        ok: !diagnostics.hasErrors,
        summary: diagnostics.summary,
        detail: JSON.stringify(diagnostics, null, 2),
      },
    ];
  }

  private async handleRenameFile(
    call: TaskToolCall,
  ): Promise<TaskToolObservation[]> {
    const oldPath = ToolExecutor.firstString(
      call.args.oldPath,
      call.args.filePath,
      call.args.from,
      call.args.path,
    );
    const newPath = ToolExecutor.firstString(
      call.args.newPath,
      call.args.to,
      call.args.destination,
      call.args.target,
    );

    if (!oldPath || !newPath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "rename_file requires both oldPath and newPath.",
        },
      ];
    }

    const resolvedOld = this.ctx.resolvePath(oldPath);
    const resolvedNew = this.ctx.resolvePath(newPath);
    if (!resolvedOld || !resolvedNew) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "Path resolves outside workspace.",
        },
      ];
    }

    try {
      const oldUri = vscode.Uri.file(resolvedOld);
      const newUri = vscode.Uri.file(resolvedNew);
      const parentDir = path.dirname(resolvedNew);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentDir));
      await vscode.workspace.fs.rename(oldUri, newUri, {
        overwrite: false,
      });
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Renamed ${this.ctx.normalizeDisplay(resolvedOld)} → ${this.ctx.normalizeDisplay(resolvedNew)}`,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Failed to rename: ${stringifyError(err)}`,
        },
      ];
    }
  }

  private async handleFindReferences(
    call: TaskToolCall,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]> {
    const symbol = ToolExecutor.firstString(
      call.args.symbol,
      call.args.query,
      call.args.name,
      call.args.pattern,
    );
    if (!symbol) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "find_references requires a symbol name.",
        },
      ];
    }

    const searchResults = await this.scanner.searchFileContents(
      symbol,
      30,
      3000,
      signal,
    );
    if (!searchResults || searchResults.length === 0) {
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `No references found for "${symbol}".`,
        },
      ];
    }

    const formatted = searchResults
      .map(
        (r: { path: string; matches: string[] }) =>
          `${this.ctx.normalizeDisplay(r.path)}:\n${r.matches.join("\n")}`,
      )
      .join("\n\n");

    return [
      {
        tool: call.tool,
        ok: true,
        summary: `Found ${searchResults.length} file(s) with references to "${symbol}".`,
        detail: formatted.slice(0, 6000),
      },
    ];
  }

  private async handleFileSearch(
    call: TaskToolCall,
  ): Promise<TaskToolObservation[]> {
    const pattern = ToolExecutor.firstString(
      call.args.pattern,
      call.args.glob,
      call.args.query,
      call.args.name,
    );
    if (!pattern) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "file_search requires a pattern (e.g. **/*.ts).",
        },
      ];
    }

    try {
      const files = await vscode.workspace.findFiles(
        pattern,
        "**/{node_modules,dist,.git,build,out,.next}/**",
        50,
      );

      if (files.length === 0) {
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `No files matching "${pattern}".`,
          },
        ];
      }

      const paths = files.map((f) => this.ctx.normalizeDisplay(f.fsPath));
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Found ${files.length} file(s) matching "${pattern}".`,
          detail: paths.join("\n"),
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `file_search failed: ${stringifyError(err)}`,
        },
      ];
    }
  }

  private handleGetTerminalOutput(): TaskToolObservation[] {
    const lastResult = this.lastTerminalResult;
    if (!lastResult) {
      return [
        {
          tool: "get_terminal_output",
          ok: true,
          summary: "No recent terminal output available.",
        },
      ];
    }

    return [
      {
        tool: "get_terminal_output",
        ok: lastResult.exitCode === 0,
        summary: `Last command: "${lastResult.command}" (exit ${lastResult.exitCode ?? "unknown"})`,
        detail: lastResult.output.slice(0, 6000),
      },
    ];
  }

  // ── Private handler methods ────────────────────────────────────

  private async handleBatchEdit(
    call: TaskToolCall,
  ): Promise<TaskToolObservation[]> {
    const editList = Array.isArray(call.args.edits) ? call.args.edits : [];
    if (editList.length === 0) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "No edits provided for batch_edit.",
        },
      ];
    }

    const results: string[] = [];
    let successCount = 0;
    let failCount = 0;

    for (const edit of editList.slice(0, 20)) {
      const filePath = ToolExecutor.firstString(edit.filePath, edit.path);
      const search = ToolExecutor.firstString(
        edit.search,
        edit.oldText,
        edit.find,
      );
      const replace = ToolExecutor.firstString(
        edit.replace,
        edit.newText,
        edit.replacement,
      );

      if (!filePath || search === null || search === undefined) {
        results.push(`SKIP: Missing filePath or search text`);
        failCount++;
        continue;
      }

      const resolved = this.ctx.resolvePath(filePath);
      if (!resolved) {
        results.push(`FAIL: ${filePath} — outside workspace`);
        failCount++;
        continue;
      }

      try {
        const uri = vscode.Uri.file(resolved);
        const raw = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(raw).toString("utf8");

        // Normalize whitespace per-line for fuzzy matching when exact
        // match is not found (handles model-generated whitespace drift).
        let effectiveContent = content;
        let effectiveSearch = search;
        if (!content.includes(search)) {
          const normalizeLine = (line: string) =>
            line.replace(/^\s+/, (ws) => ws.replace(/\t/g, "  ")).trimEnd();
          const normalizedContent = content
            .split("\n")
            .map(normalizeLine)
            .join("\n");
          const normalizedSearch = search
            .split("\n")
            .map(normalizeLine)
            .join("\n");
          if (normalizedContent.includes(normalizedSearch)) {
            effectiveContent = normalizedContent;
            effectiveSearch = normalizedSearch;
          } else {
            results.push(
              `FAIL: ${this.ctx.normalizeDisplay(resolved)} — search text not found`,
            );
            failCount++;
            continue;
          }
        }

        // Use replaceAll to handle all occurrences, not just the first
        const newContent = effectiveContent.replaceAll(
          effectiveSearch,
          replace ?? "",
        );
        await vscode.workspace.fs.writeFile(
          uri,
          Buffer.from(newContent, "utf8"),
        );
        results.push(`OK: ${this.ctx.normalizeDisplay(resolved)}`);
        successCount++;

        this.broadcaster.emitFilePatched(
          path.basename(resolved),
          newContent.split("\n").length,
        );
      } catch (err) {
        results.push(
          `FAIL: ${this.ctx.normalizeDisplay(resolved)} — ${stringifyError(err)}`,
        );
        failCount++;
      }
    }

    return [
      {
        tool: call.tool,
        ok: successCount > 0,
        summary: `Batch edit: ${successCount} succeeded, ${failCount} failed out of ${editList.length} edit(s).`,
        detail: results.join("\n"),
      },
    ];
  }

  private handleGetProblems(call: TaskToolCall): TaskToolObservation[] {
    const filePath = ToolExecutor.firstString(
      call.args.filePath,
      call.args.path,
      call.args.file,
    );

    const allDiagnostics: string[] = [];
    let errorCount = 0;
    let warningCount = 0;

    if (filePath) {
      // Scoped to a specific file
      const resolved = this.ctx.resolvePath(filePath);
      if (resolved) {
        const uri = vscode.Uri.file(resolved);
        const diags = vscode.languages.getDiagnostics(uri);
        for (const d of diags.slice(0, 50)) {
          const severity =
            d.severity === vscode.DiagnosticSeverity.Error
              ? "ERROR"
              : d.severity === vscode.DiagnosticSeverity.Warning
                ? "WARN"
                : "INFO";
          if (d.severity === vscode.DiagnosticSeverity.Error) errorCount++;
          if (d.severity === vscode.DiagnosticSeverity.Warning) warningCount++;
          allDiagnostics.push(
            `[${severity}] ${this.ctx.normalizeDisplay(resolved)}:${d.range.start.line + 1}: ${d.message}`,
          );
        }
      }
    } else {
      // All workspace diagnostics
      const diagnosticCollection = vscode.languages.getDiagnostics();
      for (const [uri, diags] of diagnosticCollection) {
        for (const d of diags.slice(0, 20)) {
          const severity =
            d.severity === vscode.DiagnosticSeverity.Error
              ? "ERROR"
              : d.severity === vscode.DiagnosticSeverity.Warning
                ? "WARN"
                : "INFO";
          if (d.severity === vscode.DiagnosticSeverity.Error) errorCount++;
          if (d.severity === vscode.DiagnosticSeverity.Warning) warningCount++;
          allDiagnostics.push(
            `[${severity}] ${this.ctx.normalizeDisplay(uri.fsPath)}:${d.range.start.line + 1}: ${d.message}`,
          );
        }
      }
    }

    return [
      {
        tool: call.tool,
        ok: errorCount === 0,
        summary: `${errorCount} error(s), ${warningCount} warning(s) found.`,
        detail:
          allDiagnostics.length > 0
            ? allDiagnostics.slice(0, 100).join("\n")
            : "No problems found.",
      },
    ];
  }

  private async runVerificationWorkflow(
    objective: string,
    signal?: AbortSignal,
    args?: Record<string, unknown>,
  ): Promise<TaskToolObservation[]> {
    const observations: TaskToolObservation[] = [];

    // Always start with VS Code diagnostics
    const toolHints = (() => {
      try {
        const regs = this.toolRegistry.list();
        const toolLines = regs
          .slice(0, 10)
          .map((r) => `- ${r.name}: ${r.prompt ?? r.description ?? ""}`);
        return toolLines.join("\n").slice(0, 1200);
      } catch {
        return "";
      }
    })();
    const diagnostics = this.verifier.runDiagnostics(toolHints);
    observations.push({
      tool: "run_verification",
      ok: !diagnostics.hasErrors,
      summary: `Diagnostics: ${diagnostics.summary}`,
      detail: JSON.stringify(diagnostics, null, 2),
    });

    const commands = await this.ctx.collectVerificationCommands(
      objective,
      args,
    );
    if (commands.length === 0) {
      return observations;
    }

    const checkAborted = () => {
      if (signal?.aborted) {
        throw new Error("__TASK_CANCELLED__");
      }
    };

    for (const command of commands.slice(0, 3)) {
      checkAborted();
      this.broadcaster.emitProgress("Verification", command, "\u25CB");
      const result = await this.ctx.executeTerminalCommand(command, {
        cwd: this.ctx.workspaceRoot ?? undefined,
        timeoutMs: 120_000,
        purpose: "verification",
        objective,
      });

      if (!result) {
        observations.push({
          tool: "run_verification",
          ok: false,
          summary: `Blocked verification command: ${command}`,
        });
        continue;
      }

      observations.push({
        tool: "run_verification",
        ok: result.exitCode === 0,
        summary: `${command} exited with ${result.exitCode ?? "unknown"}.`,
        detail: result.output.slice(0, 5000),
      });
    }

    return observations;
  }

  // ── Static utilities ───────────────────────────────────────────

  public static extractStringList(...values: unknown[]): string[] {
    const output: string[] = [];
    for (const value of values) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          output.push(trimmed);
        }
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim()) {
            output.push(item.trim());
          }
        }
      }
    }
    return output;
  }

  public static firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return undefined;
  }
}
