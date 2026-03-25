import * as vscode from "vscode";

import type { ConversationMessage } from "../runtime/RuntimeTypes";

export interface SessionRecord {
  id: string;
  title: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  modelProfile: {
    planner: string;
    editor: string;
    fast: string;
  };
  messages?: ConversationMessage[];
  attachedFiles?: string[];
  lastResult?: string;
}

interface SessionsFile {
  activeSessionId: string | null;
  sessions: SessionRecord[];
}

export class SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly sessionsPath: string) {}

  public async createSession(
    objective: string,
    modelProfile: SessionRecord["modelProfile"],
  ): Promise<SessionRecord> {
    const state = await this.load();
    const now = new Date().toISOString();

    const record: SessionRecord = {
      id: crypto.randomUUID(),
      title: objective.slice(0, 80),
      objective,
      createdAt: now,
      updatedAt: now,
      modelProfile,
      messages: [],
      attachedFiles: [],
    };

    state.sessions.unshift(record);
    state.activeSessionId = record.id;
    await this.save(state);
    return record;
  }

  public async getActiveSession(): Promise<SessionRecord | null> {
    const state = await this.load();
    if (!state.activeSessionId) {
      return null;
    }

    return state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
  }

  public async getSession(sessionId: string): Promise<SessionRecord | null> {
    const state = await this.load();
    return state.sessions.find((session) => session.id === sessionId) ?? null;
  }

  public async setActiveSession(sessionId: string | null): Promise<void> {
    const state = await this.load();
    state.activeSessionId = sessionId;
    await this.save(state);
  }

  public async clearActiveSession(): Promise<void> {
    await this.setActiveSession(null);
  }

  public async deleteSession(sessionId: string): Promise<boolean> {
    const state = await this.load();
    const nextSessions = state.sessions.filter(
      (session) => session.id !== sessionId,
    );
    if (nextSessions.length === state.sessions.length) {
      return false;
    }

    state.sessions = nextSessions;
    if (state.activeSessionId === sessionId) {
      state.activeSessionId = null;
    }

    await this.save(state);
    return true;
  }

  public async appendMessage(
    sessionId: string,
    message: ConversationMessage,
  ): Promise<void> {
    const state = await this.load();
    const found = state.sessions.find((session) => session.id === sessionId);
    if (!found) {
      return;
    }

    found.messages = [...(found.messages ?? []), message];
    found.lastResult =
      message.role === "assistant" ? message.content : found.lastResult;
    found.updatedAt = new Date().toISOString();
    await this.save(state);
  }

  public async setAttachedFiles(
    sessionId: string,
    attachedFiles: string[],
  ): Promise<void> {
    const state = await this.load();
    const found = state.sessions.find((session) => session.id === sessionId);
    if (!found) {
      return;
    }

    found.attachedFiles = [...attachedFiles];
    found.updatedAt = new Date().toISOString();
    await this.save(state);
  }

  public async updateSessionResult(
    sessionId: string,
    result: string,
  ): Promise<void> {
    const state = await this.load();
    const found = state.sessions.find((s) => s.id === sessionId);
    if (!found) {
      return;
    }

    found.lastResult = result;
    found.updatedAt = new Date().toISOString();
    await this.save(state);
  }

  public async listSessions(): Promise<SessionRecord[]> {
    const state = await this.load();
    return state.sessions;
  }

  private async load(): Promise<SessionsFile> {
    const primary = await this.readStateFile(this.sessionsPath);
    if (primary) {
      return primary;
    }

    const backup = await this.readStateFile(this.getBackupPath());
    if (backup) {
      await this.save(backup);
      return backup;
    }

    return { activeSessionId: null, sessions: [] };
  }

  private async save(state: SessionsFile): Promise<void> {
    const normalized = this.normalizeState(state);
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => this.persistState(normalized));
    await this.writeQueue;
  }

  private async persistState(state: SessionsFile): Promise<void> {
    const primaryUri = vscode.Uri.file(this.sessionsPath);
    const backupUri = vscode.Uri.file(this.getBackupPath());
    const tempUri = vscode.Uri.file(this.getTempPath());
    const payload = Buffer.from(JSON.stringify(state, null, 2), "utf8");

    try {
      await vscode.workspace.fs.copy(primaryUri, backupUri, {
        overwrite: true,
      });
    } catch {
      // No previous file yet, nothing to back up.
    }

    await vscode.workspace.fs.writeFile(tempUri, payload);
    await vscode.workspace.fs.rename(tempUri, primaryUri, {
      overwrite: true,
    });
  }

  private async readStateFile(filePath: string): Promise<SessionsFile | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const raw = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(raw) as SessionsFile;
      return this.normalizeState(parsed);
    } catch {
      return null;
    }
  }

  private normalizeState(parsed: SessionsFile): SessionsFile {
    return {
      activeSessionId:
        typeof parsed.activeSessionId === "string"
          ? parsed.activeSessionId
          : null,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  }

  private getBackupPath(): string {
    return `${this.sessionsPath}.bak`;
  }

  private getTempPath(): string {
    return `${this.sessionsPath}.tmp`;
  }
}
