import type { AgentTool } from "./BaseTool";
import { firstString, stringifyError } from "./BaseTool";
import type {
  TaskToolCall,
  TaskToolObservation,
} from "../runtime/TaskProtocols";
import type { GitService } from "../../platform/git/GitService";

export interface GitToolContext {
  readonly workspaceRoot: string | null;
}

/**
 * git_commit — Stage and commit changes.
 * Copilot can create commits as part of its workflow.
 */
export class GitCommitTool implements AgentTool {
  readonly name = "git_commit";
  readonly description = "Stage files and create a git commit";
  readonly parameterHints = "{message, files?}";

  constructor(
    private readonly ctx: GitToolContext,
    private readonly git: GitService,
  ) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const message = firstString(call.args.message, call.args.msg);
    if (!message) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "git_commit requires a message.",
        },
      ];
    }

    try {
      const isRepo = await this.git.isGitRepository();
      if (!isRepo) {
        return [
          { tool: call.tool, ok: false, summary: "Not a git repository." },
        ];
      }

      // Stage specified files or all changes
      const files = Array.isArray(call.args.files)
        ? (call.args.files as string[])
        : call.args.files && typeof call.args.files === "string"
          ? [call.args.files]
          : null;

      if (files && files.length > 0) {
        await this.git.stageFiles(files);
      } else {
        await this.git.stageAll();
      }

      await this.git.commit(message);
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Committed: "${message.slice(0, 80)}"${files ? ` (${files.length} file(s))` : " (all changes)"}`,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `git_commit failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * git_log — Show recent commit history.
 */
export class GitLogTool implements AgentTool {
  readonly name = "git_log";
  readonly description = "Show recent git commit history";
  readonly parameterHints = "{count?}";

  constructor(
    private readonly ctx: GitToolContext,
    private readonly git: GitService,
  ) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    try {
      const isRepo = await this.git.isGitRepository();
      if (!isRepo) {
        return [
          { tool: call.tool, ok: false, summary: "Not a git repository." },
        ];
      }

      const count =
        typeof call.args.count === "number"
          ? Math.min(call.args.count, 20)
          : 10;
      const log = await this.git.getLog(count);
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Retrieved ${log.length} commit(s).`,
          detail: log
            .map(
              (c) =>
                `${c.hash.slice(0, 8)} ${c.date} ${c.message.slice(0, 100)}`,
            )
            .join("\n"),
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `git_log failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * git_file_history — Show recent commit history for a file.
 */
export class GitFileHistoryTool implements AgentTool {
  readonly name = "git_file_history";
  readonly description = "Show recent git history for a file";
  readonly parameterHints = "{filePath|path, count?}";

  constructor(
    private readonly ctx: GitToolContext,
    private readonly git: GitService,
  ) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const filePath = firstString(call.args.filePath, call.args.path);
    if (!filePath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "git_file_history requires a filePath.",
        },
      ];
    }

    try {
      const isRepo = await this.git.isGitRepository();
      if (!isRepo) {
        return [
          { tool: call.tool, ok: false, summary: "Not a git repository." },
        ];
      }

      const count =
        typeof call.args.count === "number"
          ? Math.min(Math.max(call.args.count, 1), 20)
          : 10;
      const history = await this.git.getFileHistory(filePath, count);
      return [
        {
          tool: call.tool,
          ok: history.length > 0,
          summary:
            history.length > 0
              ? `Loaded ${history.length} commit(s) for ${filePath}.`
              : `No git history found for ${filePath}.`,
          detail: history
            .map(
              (entry) =>
                `${entry.hash.slice(0, 8)} ${entry.date} ${entry.author} ${entry.message.slice(0, 120)}`,
            )
            .join("\n"),
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `git_file_history failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * git_blame — Show blame for a file or line.
 */
export class GitBlameTool implements AgentTool {
  readonly name = "git_blame";
  readonly description = "Show git blame details for a file or line";
  readonly parameterHints = "{filePath|path, line?}";

  constructor(
    private readonly ctx: GitToolContext,
    private readonly git: GitService,
  ) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const filePath = firstString(call.args.filePath, call.args.path);
    if (!filePath) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: "git_blame requires a filePath.",
        },
      ];
    }

    const line =
      typeof call.args.line === "number" && Number.isFinite(call.args.line)
        ? Math.max(1, Math.floor(call.args.line))
        : undefined;

    try {
      const isRepo = await this.git.isGitRepository();
      if (!isRepo) {
        return [
          { tool: call.tool, ok: false, summary: "Not a git repository." },
        ];
      }

      const blame = await this.git.getFileBlame(filePath, line);
      return [
        {
          tool: call.tool,
          ok: Boolean(blame && blame.length > 0),
          summary:
            blame && blame.length > 0
              ? line
                ? `Loaded blame for ${filePath}:${line}.`
                : `Loaded blame for ${filePath}.`
              : `No blame information found for ${filePath}.`,
          detail:
            blame
              ?.slice(0, line ? 1 : 20)
              .map(
                (entry) =>
                  `${entry.lineNumber}: ${entry.commit.slice(0, 8)} ${entry.author} ${entry.summary || "(no summary)"} | ${entry.text}`,
              )
              .join("\n") ?? "",
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `git_blame failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * git_status — Show working tree status.
 */
export class GitStatusTool implements AgentTool {
  readonly name = "git_status";
  readonly description = "Show current git working tree status";
  readonly parameterHints = "{}";

  constructor(
    private readonly ctx: GitToolContext,
    private readonly git: GitService,
  ) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    try {
      const isRepo = await this.git.isGitRepository();
      if (!isRepo) {
        return [
          { tool: call.tool, ok: false, summary: "Not a git repository." },
        ];
      }

      const status = await this.git.getStatus();
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Branch: ${status.branch}, ${status.staged} staged, ${status.modified} modified, ${status.untracked} untracked.`,
          detail: status.files
            .slice(0, 50)
            .map((f) => `${f.status} ${f.path}`)
            .join("\n"),
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `git_status failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}

/**
 * git_branch — Create, list, or switch branches.
 */
export class GitBranchTool implements AgentTool {
  readonly name = "git_branch";
  readonly description = "Create, list, or switch git branches";
  readonly parameterHints = "{action: 'list'|'create'|'checkout', name?}";

  constructor(
    private readonly ctx: GitToolContext,
    private readonly git: GitService,
  ) {}

  async execute(call: TaskToolCall): Promise<TaskToolObservation[]> {
    const action = firstString(call.args.action) ?? "list";
    const name = firstString(call.args.name, call.args.branch);

    try {
      const isRepo = await this.git.isGitRepository();
      if (!isRepo) {
        return [
          { tool: call.tool, ok: false, summary: "Not a git repository." },
        ];
      }

      if (action === "list") {
        const branches = await this.git.getBranches();
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `${branches.length} branch(es) found.`,
            detail: branches.join("\n"),
          },
        ];
      }

      if (!name) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `git_branch ${action} requires a branch name.`,
          },
        ];
      }

      if (action === "create") {
        await this.git.createBranch(name);
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `Created and switched to branch "${name}".`,
          },
        ];
      }

      if (action === "checkout") {
        await this.git.checkout(name);
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `Switched to branch "${name}".`,
          },
        ];
      }

      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Unknown git_branch action: ${action}`,
        },
      ];
    } catch (err) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `git_branch failed: ${stringifyError(err)}`,
        },
      ];
    }
  }
}
