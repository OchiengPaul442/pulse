import * as path from "path";
import * as vscode from "vscode";

export type ProjectType = "node" | "python" | "rust" | "go" | "unknown";
export type CommandEcosystem =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "dotnet"
  | "unknown";

/**
 * Detect project type, package manager, and command ecosystem.
 *
 * Extracted from `AgentRuntime` to isolate project-detection heuristics.
 */
export class ProjectDetector {
  private readonly packageScriptsCache = new Map<
    string,
    Record<string, string> | null
  >();

  /** Clear cached package.json scripts (e.g. after file edits are applied). */
  public clearCache(): void {
    this.packageScriptsCache.clear();
  }

  /** Check whether a file exists on disk (async). */
  public async fileExists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch {
      return false;
    }
  }

  /** Detect primary project type from workspace marker files. */
  public async detectProjectType(root: string): Promise<ProjectType> {
    const checks = await Promise.all([
      this.fileExists(path.join(root, "package.json")),
      this.fileExists(path.join(root, "pyproject.toml")),
      this.fileExists(path.join(root, "requirements.txt")),
      this.fileExists(path.join(root, "manage.py")),
      this.fileExists(path.join(root, "Cargo.toml")),
      this.fileExists(path.join(root, "go.mod")),
    ]);

    if (checks[0]) return "node";
    if (checks[1] || checks[2] || checks[3]) return "python";
    if (checks[4]) return "rust";
    if (checks[5]) return "go";
    return "unknown";
  }

  /** Detect ecosystem of a terminal command from its first token. */
  public detectCommandEcosystem(command: string): CommandEcosystem {
    const lower = command.trim().toLowerCase();

    if (/^(npm|pnpm|yarn|npx)\b/.test(lower)) return "node";
    if (/^(python|python3|pip|pip3|pytest|mypy|ruff|black)\b/.test(lower))
      return "python";
    if (/^cargo\b/.test(lower)) return "rust";
    if (/^go\b/.test(lower)) return "go";
    if (/^dotnet\b/.test(lower)) return "dotnet";
    return "unknown";
  }

  /** Check whether a command ecosystem is compatible with the current project type. */
  public isCommandCompatibleWithProject(
    projectType: ProjectType,
    commandEcosystem: CommandEcosystem,
  ): boolean {
    if (projectType === "unknown" || commandEcosystem === "unknown") {
      return true;
    }
    return projectType === commandEcosystem;
  }

  /** Check whether the objective explicitly references the ecosystem. */
  public objectiveAllowsCrossStack(
    objective: string,
    ecosystem: CommandEcosystem,
  ): boolean {
    const lower = objective.toLowerCase();
    if (!lower.trim() || ecosystem === "unknown") return false;

    const patterns: Record<string, RegExp> = {
      node: /\b(node|npm|pnpm|yarn|npx|next\.?js|react|vue|angular|vite|typescript|javascript)\b/,
      python: /\b(python|pip|django|flask|fastapi|pytest)\b/,
      rust: /\b(rust|cargo)\b/,
      go: /\b(golang|go\s+module|go\s+project|go\s+app|go)\b/,
      dotnet: /\b(dotnet|c#|asp\.?net|nuget)\b/,
    };

    return patterns[ecosystem]?.test(lower) ?? false;
  }

  /** Detect the package manager from lock-file presence. */
  public async detectPackageManager(
    workspaceRoot?: vscode.Uri,
  ): Promise<"npm" | "pnpm" | "yarn"> {
    if (!workspaceRoot) return "npm";

    const fsPath = workspaceRoot.fsPath;

    if (await this.fileExists(path.join(fsPath, "pnpm-lock.yaml")))
      return "pnpm";
    if (await this.fileExists(path.join(fsPath, "yarn.lock"))) return "yarn";
    return "npm";
  }

  /** Read package.json scripts with caching. */
  public async readPackageScripts(
    packageJsonPath: string,
  ): Promise<Record<string, string> | null> {
    if (this.packageScriptsCache.has(packageJsonPath)) {
      return this.packageScriptsCache.get(packageJsonPath) ?? null;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(packageJsonPath),
      );
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
        scripts?: Record<string, unknown>;
      };

      if (!parsed.scripts || typeof parsed.scripts !== "object") return null;

      const scripts = Object.fromEntries(
        Object.entries(parsed.scripts).flatMap(([name, value]) =>
          typeof value === "string" ? [[name, value]] : [],
        ),
      );
      this.packageScriptsCache.set(packageJsonPath, scripts);
      return scripts;
    } catch {
      this.packageScriptsCache.set(packageJsonPath, null);
      return null;
    }
  }

  /** Discover test/build/lint commands for a project. */
  public async collectVerificationCommands(
    root: string,
    objective?: string,
    args?: { check?: string; commands?: string[] },
  ): Promise<string[]> {
    if (args?.commands && args.commands.length > 0) {
      return args.commands;
    }

    const projectType = await this.detectProjectType(root);

    if (projectType === "node") {
      const scripts = await this.readPackageScripts(
        path.join(root, "package.json"),
      );
      if (scripts) {
        const commands: string[] = [];
        const pm = await this.detectPackageManager(vscode.Uri.file(root));

        if (scripts.test) commands.push(`${pm} test`);
        if (scripts.build) commands.push(`${pm} run build`);
        if (scripts.lint) commands.push(`${pm} run lint`);
        if (scripts.check) commands.push(`${pm} run check`);

        if (commands.length > 0) return commands;
      }
      return ["npm test", "npm run build"];
    }

    if (projectType === "python") {
      const commands: string[] = [];
      const hasDjangoManage = await this.fileExists(
        path.join(root, "manage.py"),
      );
      if (hasDjangoManage) {
        commands.push("python manage.py test");
      } else {
        commands.push("python -m pytest");
      }
      return commands;
    }

    if (projectType === "rust") return ["cargo test", "cargo build"];
    if (projectType === "go") return ["go test ./...", "go build ./..."];

    return [];
  }
}
