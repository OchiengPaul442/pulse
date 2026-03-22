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

const BUILTIN_SKILLS: SkillManifest[] = [
  {
    id: "planning",
    name: "Planning",
    description:
      "Breaks objectives into executable steps, assumptions, and validation checks.",
    keywords: ["plan", "roadmap", "design", "strategy", "approach"],
    tools: ["planner.createPlan"],
  },
  {
    id: "editing",
    name: "Editing",
    description:
      "Produces minimal workspace-scoped file edits with apply/revert safeguards.",
    keywords: ["edit", "refactor", "fix", "implement", "create", "update"],
    tools: ["editManager.setPendingProposal", "editManager.applyPending"],
  },
  {
    id: "diagnostics",
    name: "Diagnostics",
    description:
      "Uses active diagnostics and verification checks to reduce regressions.",
    keywords: ["error", "bug", "diagnostic", "verify", "test"],
    tools: ["verificationRunner.runDiagnostics"],
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
      .map((skill) => ({
        skill,
        score: scoreSkill(skill, normalized),
      }))
      .sort((a, b) => b.score - a.score);

    const positive = scored.filter((row) => row.score > 0);
    const picked = (positive.length > 0 ? positive : scored)
      .slice(0, Math.max(limit, 1))
      .map((row) => row.skill);

    return {
      primary: picked[0] ?? null,
      selected: picked,
    };
  }

  public summarizeSelection(selection: SkillSelection): string {
    if (selection.selected.length === 0) {
      return "No active skills.";
    }

    return selection.selected
      .map((skill, index) => {
        const marker = index === 0 ? "*" : "-";
        return `${marker} ${skill.name}: ${skill.description}`;
      })
      .join("\n");
  }
}

function scoreSkill(skill: SkillManifest, objectiveLower: string): number {
  let score = 0;
  for (const keyword of skill.keywords) {
    if (objectiveLower.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}
