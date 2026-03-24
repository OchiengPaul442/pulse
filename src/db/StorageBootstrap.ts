import * as vscode from "vscode";
import * as path from "path";

import type { Logger } from "../platform/vscode/Logger";

export interface StorageState {
  storageDir: string;
  dbPath: string;
  tracesDir: string;
  snapshotsDir: string;
  sessionsPath: string;
  memoriesPath: string;
  editsPath: string;
  improvementPath: string;
}

export async function bootstrapStorage(
  context: vscode.ExtensionContext,
  logger: Logger,
): Promise<StorageState> {
  const storageDir = context.globalStorageUri.fsPath;
  const tracesDir = path.join(storageDir, "traces");
  const snapshotsDir = path.join(storageDir, "snapshots");
  const dbPath = path.join(storageDir, "db.sqlite");
  const sessionsPath = path.join(storageDir, "sessions.json");
  const memoriesPath = path.join(storageDir, "memories.json");
  const editsPath = path.join(storageDir, "edits.json");
  const improvementPath = path.join(storageDir, "improvement.json");

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(storageDir));
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(tracesDir));
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(snapshotsDir));

  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(dbPath));
  } catch {
    // Phase 0 bootstrap creates the database file; schema migration is added in Phase 1.
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(dbPath),
      new Uint8Array(),
    );
  }

  await ensureJsonFile(sessionsPath, { activeSessionId: null, sessions: [] });
  await ensureJsonFile(memoriesPath, {
    workspaceFacts: [],
    episodic: [],
    preferences: {},
  });
  await ensureJsonFile(editsPath, { pendingProposal: null, lastApplied: null });
  await ensureJsonFile(improvementPath, { outcomes: [] });

  logger.info(`Storage initialized at ${storageDir}`);

  return {
    storageDir,
    dbPath,
    tracesDir,
    snapshotsDir,
    sessionsPath,
    memoriesPath,
    editsPath,
    improvementPath,
  };
}

async function ensureJsonFile(
  filePath: string,
  initialValue: unknown,
): Promise<void> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
  } catch {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(JSON.stringify(initialValue, null, 2), "utf8"),
    );
  }
}
