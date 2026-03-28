import { describe, expect, it } from "vitest";

import {
  PermissionPolicy,
  classifyAction,
  fromLegacyApprovalMode,
  toLegacyApprovalMode,
} from "../src/agent/permissions/PermissionPolicy";

describe("PermissionPolicy", () => {
  it("full mode auto-approves everything", () => {
    const policy = new PermissionPolicy("full");
    const result = policy.evaluate({
      action: "file_write",
      description: "Write a file",
    });
    expect(result.allowed).toBe(true);
  });

  it("full mode auto-approves destructive actions", () => {
    const policy = new PermissionPolicy("full");
    const result = policy.evaluate({
      action: "destructive",
      description: "rm -rf node_modules",
    });
    expect(result.allowed).toBe(true);
  });

  it("default mode auto-approves safe reads", () => {
    const policy = new PermissionPolicy("default");
    const result = policy.evaluate({
      action: "file_read",
      description: "Read a file",
    });
    expect(result.allowed).toBe(true);
  });

  it("default mode auto-approves writes", () => {
    const policy = new PermissionPolicy("default");
    const result = policy.evaluate({
      action: "file_write",
      description: "Write a file",
    });
    expect(result.allowed).toBe(true);
  });

  it("default mode requires approval for destructive actions", () => {
    const policy = new PermissionPolicy("default");
    const result = policy.evaluate({
      action: "destructive",
      description: "Drop table",
    });
    expect(result.allowed).toBe(false);
  });

  it("strict mode requires approval for reads", () => {
    const policy = new PermissionPolicy("strict");
    const result = policy.evaluate({
      action: "file_read",
      description: "Read a file",
    });
    expect(result.allowed).toBe(false);
  });

  it("session trust overrides default prompts for sensitive actions", () => {
    const policy = new PermissionPolicy("default");
    policy.trustActionForSession("file_delete");
    const result = policy.evaluate({
      action: "file_delete",
      description: "Delete a file",
    });
    expect(result.allowed).toBe(true);
  });

  it("setMode clears session trust", () => {
    const policy = new PermissionPolicy("default");
    policy.trustActionForSession("file_delete");
    policy.setMode("default");
    const result = policy.evaluate({
      action: "file_delete",
      description: "Delete a file",
    });
    expect(result.allowed).toBe(false);
  });

  it("records decisions and keeps audit log bounded", () => {
    const policy = new PermissionPolicy("default");
    for (let i = 0; i < 510; i++) {
      policy.evaluate({ action: "file_read", description: `Read ${i}` });
    }
    expect(policy.getAuditLog().length).toBeLessThanOrEqual(500);
  });

  it("recordDecision with trustForSession enables future auto-approve for sensitive actions", () => {
    const policy = new PermissionPolicy("default");
    const req = {
      action: "package_install" as const,
      description: "Install lodash",
    };
    expect(policy.evaluate(req).allowed).toBe(false);
    policy.recordDecision(req, true, true);
    expect(policy.evaluate(req).allowed).toBe(true);
  });
});

describe("classifyAction", () => {
  it("classifies git commit as git_write", () => {
    expect(classifyAction("git commit -m fix")).toBe("git_write");
  });

  it("classifies git log as git_read", () => {
    expect(classifyAction("git log --oneline")).toBe("git_read");
  });

  it("classifies npm install as package_install", () => {
    expect(classifyAction("npm install lodash")).toBe("package_install");
  });

  it("classifies rm -rf as destructive", () => {
    expect(classifyAction("rm -rf /tmp")).toBe("destructive");
  });

  it("classifies write as file_write", () => {
    expect(classifyAction("write a new config file")).toBe("file_write");
  });

  it("classifies unknown as file_read", () => {
    expect(classifyAction("check something")).toBe("file_read");
  });
});

describe("legacy mode mapping", () => {
  it("maps fast to full", () => {
    expect(fromLegacyApprovalMode("fast")).toBe("full");
  });

  it("maps balanced to default", () => {
    expect(fromLegacyApprovalMode("balanced")).toBe("default");
  });

  it("maps strict to strict", () => {
    expect(fromLegacyApprovalMode("strict")).toBe("strict");
  });

  it("maps full back to fast", () => {
    expect(toLegacyApprovalMode("full")).toBe("fast");
  });

  it("maps default back to balanced", () => {
    expect(toLegacyApprovalMode("default")).toBe("balanced");
  });
});
