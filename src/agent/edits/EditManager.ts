import * as path from "path";
import * as vscode from "vscode";

export interface ProposedEdit {
  operation?: "write" | "delete" | "move";
  filePath: string;
  content?: string;
  targetPath?: string;
  reason?: string;
}

export interface EditProposal {
  id: string;
  objective: string;
  edits: ProposedEdit[];
  createdAt: string;
}

export interface AppliedTransaction {
  id: string;
  objective: string;
  backupsPath: string;
  createdAt: string;
}

interface EditState {
  pendingProposal: EditProposal | null;
  lastApplied: AppliedTransaction | null;
}

interface FileSnapshot {
  exists: boolean;
  isDirectory: boolean;
  content?: string;
}

type UndoAction =
  | {
      type: "write";
      path: string;
      before: FileSnapshot;
    }
  | {
      type: "delete";
      path: string;
      before: FileSnapshot;
    }
  | {
      type: "move";
      from: string;
      to: string;
      fromBefore: FileSnapshot;
      toBefore: FileSnapshot;
    };

export class EditManager {
  public constructor(
    private readonly editsPath: string,
    private readonly snapshotsDir: string,
  ) {}

  public async setPendingProposal(
    objective: string,
    edits: ProposedEdit[],
  ): Promise<EditProposal> {
    const state = await this.load();
    const proposal: EditProposal = {
      id: crypto.randomUUID(),
      objective,
      edits,
      createdAt: new Date().toISOString(),
    };
    state.pendingProposal = proposal;
    await this.save(state);
    return proposal;
  }

  public async getPendingProposal(): Promise<EditProposal | null> {
    const state = await this.load();
    return state.pendingProposal;
  }

  public async clearPendingProposal(): Promise<void> {
    const state = await this.load();
    state.pendingProposal = null;
    await this.save(state);
  }

  /**
   * Accept a single file from the pending proposal — apply it and remove from pending.
   */
  public async acceptFile(filePath: string): Promise<boolean> {
    const state = await this.load();
    const proposal = state.pendingProposal;
    if (!proposal) return false;

    const normalized = path.resolve(filePath);
    const idx = proposal.edits.findIndex(
      (e) => path.resolve(e.filePath) === normalized,
    );
    if (idx === -1) return false;

    const edit = proposal.edits[idx];
    const op = edit.operation ?? "write";

    if (op === "write") {
      const fp = this.normalizeAndAssertInWorkspace(edit.filePath);
      await this.ensureParentDir(fp);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(fp),
        Buffer.from(edit.content ?? "", "utf8"),
      );
    } else if (op === "delete") {
      const fp = this.normalizeAndAssertInWorkspace(edit.filePath);
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(fp), {
          recursive: true,
          useTrash: true,
        });
      } catch {
        // Already deleted or doesn't exist
      }
    }

    // Remove from pending
    proposal.edits.splice(idx, 1);
    if (proposal.edits.length === 0) {
      state.pendingProposal = null;
    }
    await this.save(state);
    return true;
  }

  /**
   * Reject a single file from the pending proposal — just remove it without applying.
   */
  public async rejectFile(filePath: string): Promise<boolean> {
    const state = await this.load();
    const proposal = state.pendingProposal;
    if (!proposal) return false;

    const normalized = path.resolve(filePath);
    const idx = proposal.edits.findIndex(
      (e) => path.resolve(e.filePath) === normalized,
    );
    if (idx === -1) return false;

    proposal.edits.splice(idx, 1);
    if (proposal.edits.length === 0) {
      state.pendingProposal = null;
    }
    await this.save(state);
    return true;
  }

  public async applyPending(): Promise<AppliedTransaction | null> {
    const state = await this.load();
    const proposal = state.pendingProposal;
    if (!proposal || proposal.edits.length === 0) {
      return null;
    }

    const undoActions: UndoAction[] = [];

    for (const edit of proposal.edits) {
      const op = edit.operation ?? "write";
      if (op === "write") {
        const filePath = this.normalizeAndAssertInWorkspace(edit.filePath);
        const before = await this.captureSnapshot(filePath);
        await this.ensureParentDir(filePath);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(filePath),
          Buffer.from(edit.content ?? "", "utf8"),
        );
        undoActions.push({
          type: "write",
          path: filePath,
          before,
        });
        continue;
      }

      if (op === "delete") {
        const filePath = this.normalizeAndAssertInWorkspace(edit.filePath);
        const before = await this.captureSnapshot(filePath);
        if (before.exists) {
          await vscode.workspace.fs.delete(vscode.Uri.file(filePath), {
            recursive: true,
            useTrash: true,
          });
        }
        undoActions.push({
          type: "delete",
          path: filePath,
          before,
        });
        continue;
      }

      if (op === "move") {
        if (!edit.targetPath) {
          continue;
        }

        const from = this.normalizeAndAssertInWorkspace(edit.filePath);
        const to = this.normalizeAndAssertInWorkspace(edit.targetPath);
        const fromBefore = await this.captureSnapshot(from);
        const toBefore = await this.captureSnapshot(to);

        if (!fromBefore.exists) {
          continue;
        }

        await this.ensureParentDir(to);
        if (toBefore.exists) {
          await vscode.workspace.fs.delete(vscode.Uri.file(to), {
            recursive: true,
            useTrash: true,
          });
        }

        await vscode.workspace.fs.rename(
          vscode.Uri.file(from),
          vscode.Uri.file(to),
          {
            overwrite: false,
          },
        );

        undoActions.push({
          type: "move",
          from,
          to,
          fromBefore,
          toBefore,
        });
      }
    }

    const txId = crypto.randomUUID();
    const backupsPath = path.join(this.snapshotsDir, `${txId}.json`);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(backupsPath),
      Buffer.from(JSON.stringify({ proposal, undoActions }, null, 2), "utf8"),
    );

    const applied: AppliedTransaction = {
      id: txId,
      objective: proposal.objective,
      backupsPath,
      createdAt: new Date().toISOString(),
    };

    state.pendingProposal = null;
    state.lastApplied = applied;
    await this.save(state);

    return applied;
  }

  public async revertLastApplied(): Promise<AppliedTransaction | null> {
    const state = await this.load();
    const last = state.lastApplied;
    if (!last) {
      return null;
    }

    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.file(last.backupsPath),
    );
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      undoActions?: UndoAction[];
      backups?: Record<string, string>;
    };

    const undoActions =
      parsed.undoActions ??
      Object.entries(parsed.backups ?? {}).map(
        ([filePath, content]): UndoAction => ({
          type: "write",
          path: filePath,
          before: {
            exists: true,
            isDirectory: false,
            content,
          },
        }),
      );

    for (let i = undoActions.length - 1; i >= 0; i -= 1) {
      const action = undoActions[i];

      if (action.type === "write") {
        await this.restoreSnapshot(action.path, action.before);
        continue;
      }

      if (action.type === "delete") {
        await this.restoreSnapshot(action.path, action.before);
        continue;
      }

      if (action.type === "move") {
        const fromExists = await this.pathExists(action.from);
        const toExists = await this.pathExists(action.to);

        if (!fromExists && toExists) {
          await this.ensureParentDir(action.from);
          await vscode.workspace.fs.rename(
            vscode.Uri.file(action.to),
            vscode.Uri.file(action.from),
            { overwrite: false },
          );
        }

        await this.restoreSnapshot(action.from, action.fromBefore);
        await this.restoreSnapshot(action.to, action.toBefore);
      }
    }

    state.lastApplied = null;
    await this.save(state);
    return last;
  }

  private normalizeAndAssertInWorkspace(filePath: string): string {
    const normalized = path.normalize(filePath);
    const folders = vscode.workspace.workspaceFolders ?? [];
    const inWorkspace = folders.some((folder) => {
      const root = path.normalize(folder.uri.fsPath) + path.sep;
      return (
        normalized === path.normalize(folder.uri.fsPath) ||
        normalized.startsWith(root)
      );
    });

    if (!inWorkspace) {
      throw new Error(`Refusing to edit outside workspace: ${normalized}`);
    }

    return normalized;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch {
      return false;
    }
  }

  private async captureSnapshot(filePath: string): Promise<FileSnapshot> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        return {
          exists: true,
          isDirectory: true,
        };
      }

      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(filePath),
      );
      return {
        exists: true,
        isDirectory: false,
        content: Buffer.from(bytes).toString("utf8"),
      };
    } catch {
      return {
        exists: false,
        isDirectory: false,
      };
    }
  }

  private async restoreSnapshot(
    filePath: string,
    snapshot: FileSnapshot,
  ): Promise<void> {
    const exists = await this.pathExists(filePath);

    if (!snapshot.exists) {
      if (exists) {
        await vscode.workspace.fs.delete(vscode.Uri.file(filePath), {
          recursive: true,
          useTrash: true,
        });
      }
      return;
    }

    if (snapshot.isDirectory) {
      if (!exists) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(filePath));
      }
      return;
    }

    await this.ensureParentDir(filePath);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(snapshot.content ?? "", "utf8"),
    );
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
  }

  private async load(): Promise<EditState> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(this.editsPath),
      );
      const raw = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(raw) as EditState;
      return {
        pendingProposal: parsed.pendingProposal ?? null,
        lastApplied: parsed.lastApplied ?? null,
      };
    } catch {
      return { pendingProposal: null, lastApplied: null };
    }
  }

  private async save(state: EditState): Promise<void> {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(this.editsPath),
      Buffer.from(JSON.stringify(state, null, 2), "utf8"),
    );
  }
}
