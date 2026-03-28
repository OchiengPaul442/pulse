/**
 * Centralized permission policy for Pulse agent actions.
 *
 * Three modes mirror modern coding-agent patterns:
 *  - "full"     → auto-approve everything (like Copilot "Autopilot" / bypass)
 *  - "default"  → auto-approve safe reads, prompt for writes/sensitive ops
 *  - "strict"   → prompt for every action including reads
 *
 * Session-level overrides and per-action trust-once are supported.
 */

export type PermissionMode = "full" | "default" | "strict";

export type ActionCategory =
  | "file_read"
  | "file_write"
  | "file_delete"
  | "file_move"
  | "terminal_exec"
  | "git_read"
  | "git_write"
  | "network_request"
  | "package_install"
  | "multi_file_edit"
  | "destructive"
  | "mcp_tool_call";

export interface PermissionRequest {
  action: ActionCategory;
  description: string;
  detail?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  trustedForSession: boolean;
}

export interface PermissionAuditEntry {
  timestamp: string;
  action: ActionCategory;
  description: string;
  allowed: boolean;
  reason: string;
  mode: PermissionMode;
}

/** Actions considered sensitive that need approval in "default" mode. */
const SENSITIVE_ACTIONS: ReadonlySet<ActionCategory> = new Set([
  "file_delete",
  "git_write",
  "network_request",
  "package_install",
  "destructive",
]);

/**
 * Actions that are always safe (auto-approved even in "default" mode).
 * In default mode, the agent auto-approves reads, writes, edits, terminal
 * commands, file moves, and MCP calls — matching GitHub Copilot behavior.
 * Only destructive/external operations still require explicit approval.
 */
const SAFE_ACTIONS: ReadonlySet<ActionCategory> = new Set([
  "file_read",
  "file_write",
  "file_move",
  "terminal_exec",
  "multi_file_edit",
  "mcp_tool_call",
  "git_read",
]);

export function classifyAction(description: string): ActionCategory {
  const lower = description.toLowerCase();

  if (
    /\b(commit|push|merge|rebase|reset|checkout|stash|branch|cherry.?pick)\b/.test(
      lower,
    )
  ) {
    return "git_write";
  }
  if (/\b(git\s+(log|status|diff|show|blame))\b/.test(lower)) {
    return "git_read";
  }
  if (
    /\b(npm\s+install|yarn\s+add|pip\s+install|pnpm\s+add|cargo\s+add|go\s+get)\b/.test(
      lower,
    )
  ) {
    return "package_install";
  }
  if (/\b(rm\s+-rf|rmdir|del\s+\/|drop\s+table|truncate)\b/.test(lower)) {
    return "destructive";
  }
  if (/\b(exec|shell|terminal|spawn|run\s+command|command)\b/.test(lower)) {
    return "terminal_exec";
  }
  if (/\b(fetch|http|api|request|download|upload)\b/.test(lower)) {
    return "network_request";
  }
  if (/\bdelete\b/.test(lower)) {
    return "file_delete";
  }
  if (/\b(move|rename)\b/.test(lower)) {
    return "file_move";
  }
  if (/\b(write|create|edit|modify|update)\b/.test(lower)) {
    return "file_write";
  }

  return "file_read";
}

export class PermissionPolicy {
  private mode: PermissionMode;
  private readonly sessionTrusted = new Set<ActionCategory>();
  private readonly auditLog: PermissionAuditEntry[] = [];

  public constructor(mode: PermissionMode = "default") {
    this.mode = mode;
  }

  public getMode(): PermissionMode {
    return this.mode;
  }

  public setMode(mode: PermissionMode): void {
    this.mode = mode;
    // Clear session-level trusts when switching modes
    this.sessionTrusted.clear();
  }

  /**
   * Evaluate whether an action should proceed.
   * Returns `allowed: true` if auto-approved, or `allowed: false` to signal
   * that the UI layer should ask the user.
   *
   * The caller (UI) is expected to call `recordDecision` after the user
   * approves or rejects.
   */
  public evaluate(request: PermissionRequest): PermissionDecision {
    // Full mode → auto-approve everything
    if (this.mode === "full") {
      const decision: PermissionDecision = {
        allowed: true,
        reason: "Full access mode — auto-approved.",
        trustedForSession: true,
      };
      this.log(request, decision);
      return decision;
    }

    // Session override → already trusted
    if (this.sessionTrusted.has(request.action)) {
      const decision: PermissionDecision = {
        allowed: true,
        reason: `Trusted for session (${request.action}).`,
        trustedForSession: true,
      };
      this.log(request, decision);
      return decision;
    }

    // Strict mode → ask for everything
    if (this.mode === "strict") {
      return {
        allowed: false,
        reason: `Strict mode — approval required for ${request.action}.`,
        trustedForSession: false,
      };
    }

    // Default mode → auto-approve safe actions, prompt for sensitive
    if (SAFE_ACTIONS.has(request.action)) {
      const decision: PermissionDecision = {
        allowed: true,
        reason: `Safe action (${request.action}) — auto-approved.`,
        trustedForSession: false,
      };
      this.log(request, decision);
      return decision;
    }

    if (SENSITIVE_ACTIONS.has(request.action)) {
      return {
        allowed: false,
        reason: `Sensitive action (${request.action}) — approval required.`,
        trustedForSession: false,
      };
    }

    // Unknown category defaults to allowed in default mode
    const decision: PermissionDecision = {
      allowed: true,
      reason: "Default mode — action category not restricted.",
      trustedForSession: false,
    };
    this.log(request, decision);
    return decision;
  }

  /**
   * Record a user decision (approve/deny) and optionally trust for the session.
   */
  public recordDecision(
    request: PermissionRequest,
    allowed: boolean,
    trustForSession = false,
  ): void {
    if (allowed && trustForSession) {
      this.sessionTrusted.add(request.action);
    }
    this.log(request, {
      allowed,
      reason: allowed ? "User approved." : "User denied.",
      trustedForSession: trustForSession,
    });
  }

  public trustActionForSession(action: ActionCategory): void {
    this.sessionTrusted.add(action);
  }

  public clearSessionTrust(): void {
    this.sessionTrusted.clear();
  }

  public getAuditLog(): readonly PermissionAuditEntry[] {
    return this.auditLog;
  }

  public getAuditLogSlice(limit = 50): PermissionAuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  private log(request: PermissionRequest, decision: PermissionDecision): void {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action: request.action,
      description: request.description,
      allowed: decision.allowed,
      reason: decision.reason,
      mode: this.mode,
    });

    // Keep audit log bounded
    if (this.auditLog.length > 500) {
      this.auditLog.splice(0, this.auditLog.length - 500);
    }
  }
}

/**
 * Map the legacy approval mode names to the new permission model.
 */
export function fromLegacyApprovalMode(
  legacy: "strict" | "balanced" | "fast",
): PermissionMode {
  switch (legacy) {
    case "fast":
      return "full";
    case "strict":
      return "strict";
    case "balanced":
    default:
      return "default";
  }
}

/**
 * Map the new permission mode to the legacy config value for backward compat.
 */
export function toLegacyApprovalMode(
  mode: PermissionMode,
): "strict" | "balanced" | "fast" {
  switch (mode) {
    case "full":
      return "fast";
    case "strict":
      return "strict";
    case "default":
    default:
      return "balanced";
  }
}
