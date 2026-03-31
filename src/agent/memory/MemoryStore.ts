import * as vscode from "vscode";

export interface EpisodicMemory {
  id: string;
  objective: string;
  summary: string;
  createdAt: string;
}

interface MemoryState {
  workspaceFacts: Array<{ key: string; value: string; confidence: number }>;
  episodic: EpisodicMemory[];
  preferences: Record<string, string>;
}

export class MemoryStore {
  private cache: MemoryState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly memoriesPath: string) {}

  public async addEpisode(objective: string, summary: string): Promise<void> {
    const state = await this.load();
    state.episodic.unshift({
      id: crypto.randomUUID(),
      objective,
      summary,
      createdAt: new Date().toISOString(),
    });
    state.episodic = state.episodic.slice(0, 80);
    await this.save(state);
  }

  public async setPreference(key: string, value: string): Promise<void> {
    const state = await this.load();
    state.preferences[key] = value;
    await this.save(state);
  }

  public async getPreference(key: string): Promise<string | undefined> {
    const state = await this.load();
    return state.preferences[key];
  }

  public async latestEpisodes(limit = 5): Promise<EpisodicMemory[]> {
    const state = await this.load();
    return state.episodic.slice(0, limit);
  }

  private async load(): Promise<MemoryState> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(this.memoriesPath),
      );
      const raw = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(raw) as MemoryState;
      this.cache = {
        workspaceFacts: parsed.workspaceFacts ?? [],
        episodic: parsed.episodic ?? [],
        preferences: parsed.preferences ?? {},
      };
      return this.cache;
    } catch {
      this.cache = { workspaceFacts: [], episodic: [], preferences: {} };
      return this.cache;
    }
  }

  private async save(state: MemoryState): Promise<void> {
    this.cache = state;
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() =>
        vscode.workspace.fs.writeFile(
          vscode.Uri.file(this.memoriesPath),
          Buffer.from(JSON.stringify(state, null, 2), "utf8"),
        ),
      );
    await this.writeQueue;
  }
}
