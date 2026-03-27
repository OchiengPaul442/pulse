export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  tools: string[];
}

export interface SkillSelection {
  primary: SkillManifest | null;
  selected: SkillManifest[];
}

interface ScoredSkill {
  skill: SkillManifest;
  score: number;
}

const BUILTIN_SKILLS: SkillManifest[] = [
  {
    id: "planning",
    name: "Planning",
    description:
      "Breaks objectives into executable steps, assumptions, and validation checks.",
    keywords: [
      "plan",
      "roadmap",
      "design",
      "strategy",
      "approach",
      "architect",
    ],
    tools: ["planner.createPlan"],
  },
  {
    id: "editing",
    name: "Editing",
    description:
      "Produces minimal workspace-scoped file edits with apply/revert safeguards.",
    keywords: [
      "edit",
      "refactor",
      "fix",
      "implement",
      "create",
      "update",
      "write",
      "modify",
      "change",
      "add",
      "remove",
      "rename",
      "rewrite",
      "move",
    ],
    tools: ["editManager.setPendingProposal", "editManager.applyPending"],
  },
  {
    id: "diagnostics",
    name: "Diagnostics",
    description:
      "Uses active diagnostics and verification checks to reduce regressions.",
    keywords: [
      "error",
      "bug",
      "diagnostic",
      "verify",
      "test",
      "lint",
      "typecheck",
    ],
    tools: ["verificationRunner.runDiagnostics"],
  },
  {
    id: "codeReading",
    name: "Code Reading",
    description:
      "Reads and analyzes source files to understand structure, find issues, and gather context.",
    keywords: [
      "read",
      "understand",
      "analyze",
      "review",
      "find",
      "search",
      "look",
      "explore",
      "inspect",
      "check",
      "scan",
      "what",
      "how",
      "where",
      "show",
      "explain",
      "describe",
      "project",
      "codebase",
      "structure",
    ],
    tools: ["scanner.findRelevantFiles", "scanner.readContextSnippets"],
  },
  {
    id: "terminal",
    name: "Terminal Commands",
    description:
      "Runs shell commands for builds, tests, installs, and other terminal operations.",
    keywords: [
      "run",
      "execute",
      "build",
      "compile",
      "install",
      "npm",
      "yarn",
      "test",
      "script",
      "command",
      "terminal",
      "shell",
    ],
    tools: ["terminal.execute"],
  },
  {
    id: "git",
    name: "Git Operations",
    description:
      "Manages source control: diffs, commits, branches, and history.",
    keywords: [
      "git",
      "commit",
      "branch",
      "merge",
      "diff",
      "push",
      "pull",
      "stash",
      "rebase",
      "history",
      "log",
      "blame",
    ],
    tools: ["gitService.getDiffSummary", "gitService.refreshScm"],
  },
  {
    id: "mcp",
    name: "MCP Integration",
    description:
      "Validates MCP transport readiness and reports configuration health.",
    keywords: ["mcp", "tool", "server", "integration", "context protocol"],
    tools: ["mcpManager.listServerStatus"],
  },
  {
    id: "research",
    name: "Research",
    description:
      "Uses online search to gather current documentation, facts, and external references.",
    keywords: [
      "search",
      "web",
      "online",
      "latest",
      "docs",
      "internet",
      "documentation",
    ],
    tools: ["webSearch.search"],
  },
  {
    id: "memory",
    name: "Memory",
    description:
      "Applies episodic memory and user preferences to improve continuity.",
    keywords: ["remember", "history", "session", "memory", "preference"],
    tools: ["memoryStore.latestEpisodes", "memoryStore.setPreference"],
  },
];

export class SkillRegistry {
  private readonly skills = [...BUILTIN_SKILLS];

  public list(): SkillManifest[] {
    return [...this.skills];
  }

  public selectForObjective(objective: string, limit = 3): SkillSelection {
    const normalized = objective.toLowerCase();
    const scored = this.skills
      .map((skill) => ({ skill, score: scoreSkill(skill, normalized) }))
      .sort((a, b) => b.score - a.score);

    const highConfidence = scored.filter((row) => row.score >= 0.9);
    const fallback = scored.filter((row) => row.score >= 0.45);
    const picked =
      highConfidence.length > 0
        ? highConfidence
        : fallback.length > 0
          ? fallback
          : scored;

    const selected = picked
      .slice(0, Math.max(limit, 1))
      .map((row) => row.skill);

    return {
      primary: highConfidence[0]?.skill ?? selected[0] ?? null,
      selected,
    };
  }

  public summarizeSelection(selection: SkillSelection): string {
    if (selection.selected.length === 0) {
      return "No active skills.";
    }

    const lines = selection.selected.map((skill, index) => {
      const marker = index === 0 ? "*" : "-";
      return `${marker} ${skill.name}: ${skill.description}`;
    });

    const shortcuts = this.buildOptionalShortcuts(selection);
    if (shortcuts.length > 0) {
      lines.push(`Shortcuts: ${shortcuts.join(" | ")}`);
    }

    return lines.join("\n");
  }

  public buildOptionalShortcuts(selection: SkillSelection): string[] {
    const labels = new Set<string>();

    for (const skill of selection.selected) {
      for (const tool of skill.tools) {
        const label = shortcutForTool(tool);
        if (label) {
          labels.add(label);
        }
      }
    }

    return [...labels];
  }
}

function scoreSkill(skill: SkillManifest, objectiveLower: string): number {
  let matched = 0;
  let exactMatches = 0;

  for (const keyword of skill.keywords) {
    if (!matchesKeyword(objectiveLower, keyword)) {
      continue;
    }

    matched += 1;
    if (objectiveLower.includes(keyword.toLowerCase())) {
      exactMatches += 1;
    }
  }

  const hasSkillId = matchesKeyword(objectiveLower, skill.id);
  const hasSkillName = matchesKeyword(objectiveLower, skill.name.toLowerCase());
  const coverage =
    skill.keywords.length > 0 ? matched / skill.keywords.length : 0;
  const focusBonus = hasSkillId || hasSkillName ? 0.45 : 0;
  const exactBonus = exactMatches > 0 ? 0.15 : 0;
  const score =
    coverage * 0.5 + Math.min(0.3, matched * 0.12) + focusBonus + exactBonus;

  return Math.min(1, Number(score.toFixed(2)));
}

function matchesKeyword(text: string, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function shortcutForTool(tool: string): string | null {
  if (tool.includes("planner.createPlan")) {
    return "plan";
  }
  if (tool.includes("editManager")) {
    return "edit";
  }
  if (tool.includes("verificationRunner")) {
    return "verify";
  }
  if (tool.includes("scanner.readContextSnippets")) {
    return "read";
  }
  if (tool.includes("scanner.findRelevantFiles")) {
    return "scan";
  }
  if (tool.includes("terminal.execute")) {
    return "terminal";
  }
  if (tool.includes("gitService")) {
    return "git";
  }
  if (tool.includes("mcpManager")) {
    return "mcp";
  }
  if (tool.includes("webSearch")) {
    return "web";
  }
  if (tool.includes("memoryStore")) {
    return "memory";
  }

  return null;
}
