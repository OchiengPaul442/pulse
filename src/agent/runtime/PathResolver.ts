import * as path from "path";
import * as vscode from "vscode";

/**
 * Workspace path resolution and normalisation.
 *
 * Extracted from `AgentRuntime` to isolate file-path logic into a
 * single responsibility class.
 */
export class PathResolver {
  private readonly workspaceRoot: vscode.Uri | undefined;

  public constructor(workspaceRoot?: vscode.Uri) {
    this.workspaceRoot = workspaceRoot;
  }

  /** Convert a relative value to an absolute workspace path. */
  public resolve(value: string): string | null {
    if (!value.trim()) {
      return null;
    }

    if (path.isAbsolute(value)) {
      return value;
    }

    if (!this.workspaceRoot) {
      return null;
    }

    return path.join(this.workspaceRoot.fsPath, value);
  }

  /** Convert an absolute path to a workspace-relative display path. */
  public normalizeDisplay(filePath: string): string {
    if (this.workspaceRoot && path.isAbsolute(filePath)) {
      const relative = path.relative(this.workspaceRoot.fsPath, filePath);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      ) {
        return relative;
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
    const absolute = path.isAbsolute(value)
      ? value
      : this.workspaceRoot
        ? path.join(this.workspaceRoot.fsPath, value)
        : value;

    if (this.workspaceRoot) {
      const relative = path.relative(this.workspaceRoot.fsPath, absolute);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      ) {
        return relative;
      }
    }

    return absolute;
  }

  /** Get the workspace root URI (may be undefined if no workspace is open). */
  public getRoot(): vscode.Uri | undefined {
    return this.workspaceRoot;
  }

  /** Get the workspace root filesystem path, or undefined. */
  public getRootFsPath(): string | undefined {
    return this.workspaceRoot?.fsPath;
  }
}
