import * as path from "path";
import * as vscode from "vscode";

/**
 * Workspace path resolution and normalisation.
 *
 * Extracted from `AgentRuntime` to isolate file-path logic into a
 * single responsibility class.
 */
export class PathResolver {
  private readonly workspaceRoot:
    | vscode.Uri
    | undefined
    | (() => vscode.Uri | undefined);

  public constructor(
    workspaceRoot?: vscode.Uri | (() => vscode.Uri | undefined),
  ) {
    this.workspaceRoot = workspaceRoot;
  }

  private getCurrentWorkspaceRoot(): vscode.Uri | undefined {
    return typeof this.workspaceRoot === "function"
      ? this.workspaceRoot()
      : this.workspaceRoot;
  }

  /** Convert a relative value to an absolute workspace path. */
  public resolve(value: string): string | null {
    if (!value.trim()) {
      return null;
    }

    if (path.isAbsolute(value)) {
      return value;
    }

    const workspaceRoot = this.getCurrentWorkspaceRoot();
    if (!workspaceRoot) {
      return null;
    }

    return path.join(workspaceRoot.fsPath, value);
  }

  /** Convert an absolute path to a workspace-relative display path. */
  public normalizeDisplay(filePath: string): string {
    const workspaceRoot = this.getCurrentWorkspaceRoot();
    if (workspaceRoot && path.isAbsolute(filePath)) {
      const relative = path.relative(workspaceRoot.fsPath, filePath);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      ) {
        return relative.replace(/\\/g, "/");
      }
    }

    return filePath;
  }

  /** Resolve an attachment path, preferring absolute or falling back to workspace. */
  public resolveAttachment(value: string): string | null {
    if (path.isAbsolute(value)) {
      return value;
    }

    return this.resolve(value);
  }

  /** Normalise an attachment path to workspace-relative form for storage. */
  public normalizeAttachment(value: string): string {
    const workspaceRoot = this.getCurrentWorkspaceRoot();
    const absolute = path.isAbsolute(value)
      ? value
      : workspaceRoot
        ? path.join(workspaceRoot.fsPath, value)
        : value;

    if (workspaceRoot) {
      const relative = path.relative(workspaceRoot.fsPath, absolute);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      ) {
        return relative.replace(/\\/g, "/");
      }
    }

    return absolute;
  }

  /** Get the workspace root URI (may be undefined if no workspace is open). */
  public getRoot(): vscode.Uri | undefined {
    return this.getCurrentWorkspaceRoot();
  }

  /** Get the workspace root filesystem path, or undefined. */
  public getRootFsPath(): string | undefined {
    return this.getCurrentWorkspaceRoot()?.fsPath;
  }
}
