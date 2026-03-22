import * as vscode from "vscode";

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
  lastResult?: string;
}

interface SessionsFile {
  activeSessionId: string | null;
  sessions: SessionRecord[];
}

export class SessionStore {
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
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(this.sessionsPath),
      );
      const raw = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(raw) as SessionsFile;
      return {
        activeSessionId: parsed.activeSessionId ?? null,
        sessions: parsed.sessions ?? [],
      };
    } catch {
      return { activeSessionId: null, sessions: [] };
    }
  }

  private async save(state: SessionsFile): Promise<void> {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(this.sessionsPath),
      Buffer.from(JSON.stringify(state, null, 2), "utf8"),
    );
  }
}
