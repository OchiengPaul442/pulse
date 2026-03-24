/**
 * Lightweight git integration using VS Code's built-in git extension API.
 * Provides workspace git awareness, diff summaries, and change tracking.
 */
import * as vscode from "vscode";

export interface GitFileChange {
  path: string;
  relativePath: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  insertions?: number;
  deletions?: number;
}

export interface GitDiffSummary {
  isGitRepo: boolean;
  branch: string;
  changedFiles: GitFileChange[];
  totalInsertions: number;
  totalDeletions: number;
  summary: string;
}

export interface GitFileDiff {
  path: string;
  diff: string;
}

/**
 * Git service wrapping VS Code's built-in SCM API for change detection.
 */
export class GitService {
  /**
   * Check whether the current workspace root is inside a git repository.
   */
  public async isGitRepository(): Promise<boolean> {
    const gitExt = this.getGitExtension();
    if (!gitExt) {
      return false;
    }
    return gitExt.repositories.length > 0;
  }

  /**
   * Get a summary of all changes in the repository (staged + unstaged + untracked).
   */
  public async getDiffSummary(): Promise<GitDiffSummary> {
    const gitExt = this.getGitExtension();
    if (!gitExt || gitExt.repositories.length === 0) {
      return {
        isGitRepo: false,
        branch: "",
        changedFiles: [],
        totalInsertions: 0,
        totalDeletions: 0,
        summary: "Not a git repository.",
      };
    }

    const repo = gitExt.repositories[0];
    const branch = repo.state.HEAD?.name ?? "detached";
    const changes: GitFileChange[] = [];

    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    // Merge working tree changes, index changes, and untracked
    const allChanges = [
      ...repo.state.workingTreeChanges,
      ...repo.state.indexChanges,
    ];

    // Deduplicate by path
    const seen = new Set<string>();
    for (const change of allChanges) {
      const fsPath = change.uri.fsPath;
      if (seen.has(fsPath)) continue;
      seen.add(fsPath);

      const relativePath = workspaceRoot
        ? fsPath.replace(workspaceRoot, "").replace(/^[/\\]/, "")
        : fsPath;

      changes.push({
        path: fsPath,
        relativePath,
        status: mapGitStatus(change.status),
      });
    }

    const totalInsertions = 0; // Line-level counts require diffstat parsing
    const totalDeletions = 0;

    const summary =
      changes.length === 0
        ? "No uncommitted changes."
        : `${changes.length} changed file(s) on branch ${branch}.`;

    return {
      isGitRepo: true,
      branch,
      changedFiles: changes,
      totalInsertions,
      totalDeletions,
      summary,
    };
  }

  /**
   * Get the unified diff for a specific file (working tree vs HEAD).
   */
  public async getFileDiff(filePath: string): Promise<GitFileDiff | null> {
    const gitExt = this.getGitExtension();
    if (!gitExt || gitExt.repositories.length === 0) {
      return null;
    }

    const repo = gitExt.repositories[0];
    try {
      const diff = await repo.diffWith("HEAD", filePath);
      return { path: filePath, diff };
    } catch {
      return null;
    }
  }

  /**
   * Refresh the git SCM view — useful after agent edits.
   */
  public async refreshScm(): Promise<void> {
    try {
      await vscode.commands.executeCommand("git.refresh");
    } catch {
      // git extension may not be available
    }
  }

  /**
   * Open the VS Code diff editor for a modified file.
   */
  public async openDiffForFile(fileUri: vscode.Uri): Promise<void> {
    try {
      await vscode.commands.executeCommand("git.openChange", fileUri);
    } catch {
      // Fallback: just open the file
      await vscode.window.showTextDocument(fileUri);
    }
  }

  /**
   * Open the VS Code Source Control view panel.
   */
  public async showSourceControlView(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.view.scm");
    } catch {
      // SCM view may not be available
    }
  }

  /**
   * Get the VS Code built-in git extension API.
   */
  private getGitExtension(): GitExtensionApi | null {
    const extension = vscode.extensions.getExtension("vscode.git");
    if (!extension?.isActive) {
      return null;
    }
    const gitApi = extension.exports?.getAPI?.(1);
    return gitApi ?? null;
  }
}

/**
 * Map VS Code's git Status enum to a readable status string.
 */
function mapGitStatus(status: number): GitFileChange["status"] {
  // VS Code git extension Status enum values:
  // 0 = INDEX_MODIFIED, 1 = INDEX_ADDED, 2 = INDEX_DELETED
  // 3 = INDEX_RENAMED, 4 = INDEX_COPIED
  // 5 = MODIFIED, 6 = DELETED, 7 = UNTRACKED
  // 8 = IGNORED, 9 = INTENT_TO_ADD
  switch (status) {
    case 0:
    case 5:
      return "modified";
    case 1:
    case 9:
      return "added";
    case 2:
    case 6:
      return "deleted";
    case 3:
    case 4:
      return "renamed";
    case 7:
      return "untracked";
    default:
      return "modified";
  }
}

/**
 * Minimal type definitions for the VS Code built-in git extension API.
 * These mirror the public API surface used by extensions.
 */
interface GitExtensionApi {
  repositories: GitRepository[];
}

interface GitRepository {
  state: GitRepositoryState;
  diffWith(ref: string, path: string): Promise<string>;
}

interface GitRepositoryState {
  HEAD: { name?: string } | undefined;
  workingTreeChanges: GitChange[];
  indexChanges: GitChange[];
}

interface GitChange {
  uri: vscode.Uri;
  status: number;
}
