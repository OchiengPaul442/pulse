import { describe, expect, it, vi } from "vitest";

let lastWrittenData = "";
vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
  workspace: {
    fs: {
      readFile: vi.fn().mockRejectedValue(new Error("not found")),
      writeFile: vi.fn().mockImplementation((_uri: unknown, buf: Buffer) => {
        lastWrittenData = Buffer.from(buf).toString("utf8");
        return Promise.resolve();
      }),
    },
  },
}));

import { MemoryStore } from "../src/agent/memory/MemoryStore";

describe("MemoryStore", () => {
  it("serialises writes through the write queue", async () => {
    const store = new MemoryStore("/tmp/test-memories.json");

    // Ensure the cache is initialised before concurrent writes
    await store.latestEpisodes(1);

    // Fire two concurrent writes — they should not overwrite each other
    await Promise.all([
      store.addEpisode("Task A", "Did A"),
      store.setPreference("theme", "dark"),
    ]);

    // Both writes should have completed and state should be consistent
    const episodes = await store.latestEpisodes(5);
    expect(episodes.length).toBeGreaterThan(0);

    const currentPref = await store.getPreference("theme");
    expect(currentPref).toBe("dark");
  });

  it("creates default state when file does not exist", async () => {
    const store = new MemoryStore("/tmp/empty-memories.json");
    const episodes = await store.latestEpisodes();
    expect(episodes).toEqual([]);
  });

  it("caps episodes at 80", async () => {
    const store = new MemoryStore("/tmp/cap-test.json");
    for (let i = 0; i < 85; i++) {
      await store.addEpisode(`Task ${i}`, `Summary ${i}`);
    }
    const episodes = await store.latestEpisodes(100);
    expect(episodes.length).toBeLessThanOrEqual(80);
  });
});
