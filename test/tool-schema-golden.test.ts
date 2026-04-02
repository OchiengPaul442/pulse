import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/agent/tooling/ToolRegistry";

describe("ToolRegistry golden schema compliance", () => {
  it("validates run_terminal schema examples", () => {
    const tr = new ToolRegistry();
    tr.register(
      "run_terminal",
      {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      "Run terminal",
      "run_terminal",
    );

    expect(tr.validate("run_terminal", { command: "npm test" }).ok).toBe(true);
    expect(tr.validate("run_terminal", { cmd: 123 }).ok).toBe(false);
  });

  it("validates read_files schema examples", () => {
    const tr = new ToolRegistry();
    tr.register(
      "read_files",
      {
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          {
            type: "object",
            properties: { paths: { type: "array", items: { type: "string" } } },
            required: ["paths"],
          },
        ],
      },
      "Read files",
      "read_files",
    );

    expect(tr.validate("read_files", { path: "README.md" }).ok).toBe(true);
    expect(
      tr.validate("read_files", { paths: ["src/index.ts", "package.json"] }).ok,
    ).toBe(true);
    expect(tr.validate("read_files", { paths: ["a", 1] }).ok).toBe(false);
  });

  it("validates create_file / write_file schemas", () => {
    const tr = new ToolRegistry();
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: {
            filePath: { type: "string" },
            content: { type: "string" },
          },
          required: ["filePath", "content"],
        },
        {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      ],
    };

    tr.register("create_file", schema, "create", "create");
    tr.register("write_file", schema, "write", "write");

    expect(
      tr.validate("create_file", { filePath: "src/new.ts", content: "x" }).ok,
    ).toBe(true);
    expect(
      tr.validate("write_file", { path: "src/existing.ts", content: "y" }).ok,
    ).toBe(true);
    expect(tr.validate("create_file", { filePath: "a" }).ok).toBe(false);
  });

  it("validates run_verification and web_search schemas", () => {
    const tr = new ToolRegistry();
    tr.register(
      "run_verification",
      {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["tests", "build", "lint", "typecheck"],
              },
            },
            required: ["kind"],
          },
          {
            type: "object",
            properties: {
              commands: { type: "array", items: { type: "string" } },
            },
            required: ["commands"],
          },
        ],
      },
      "verify",
      "run_verification",
    );

    tr.register(
      "web_search",
      {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      "search",
      "web_search",
    );

    expect(tr.validate("run_verification", { kind: "tests" }).ok).toBe(true);
    expect(tr.validate("run_verification", { commands: ["npm test"] }).ok).toBe(
      true,
    );
    expect(tr.validate("run_verification", { kind: "unknown" }).ok).toBe(false);

    expect(tr.validate("web_search", { query: "typescript" }).ok).toBe(true);
    expect(tr.validate("web_search", { query: 123 }).ok).toBe(false);
  });

  it("validates rename and file_search schemas", () => {
    const tr = new ToolRegistry();
    tr.register(
      "rename_file",
      {
        type: "object",
        properties: {
          oldPath: { type: "string" },
          newPath: { type: "string" },
        },
        required: ["oldPath", "newPath"],
      },
      "rename",
      "rename",
    );

    tr.register(
      "file_search",
      {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
      "file_search",
      "file_search",
    );

    expect(tr.validate("rename_file", { oldPath: "a", newPath: "b" }).ok).toBe(
      true,
    );
    expect(tr.validate("rename_file", { oldPath: "a" }).ok).toBe(false);

    expect(tr.validate("file_search", { pattern: "**/*.ts" }).ok).toBe(true);
    expect(tr.validate("file_search", { pattern: 1 }).ok).toBe(false);
  });

  it("validates LSP and symbol-related schemas", () => {
    const tr = new ToolRegistry();
    tr.register(
      "get_definitions",
      {
        type: "object",
        properties: {
          filePath: { type: "string" },
          line: { type: "integer" },
          character: { type: "integer" },
        },
        required: ["filePath", "line", "character"],
      },
      "get_definitions",
      "get_definitions",
    );

    tr.register(
      "get_references",
      {
        type: "object",
        properties: {
          filePath: { type: "string" },
          line: { type: "integer" },
          character: { type: "integer" },
          includeDeclaration: { type: "boolean" },
        },
        required: ["filePath", "line", "character"],
      },
      "get_references",
      "get_references",
    );

    tr.register(
      "get_document_symbols",
      {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
      "get_document_symbols",
      "get_document_symbols",
    );

    tr.register(
      "rename_symbol",
      {
        type: "object",
        properties: {
          filePath: { type: "string" },
          line: { type: "integer" },
          character: { type: "integer" },
          newName: { type: "string" },
        },
        required: ["filePath", "line", "character", "newName"],
      },
      "rename_symbol",
      "rename_symbol",
    );

    expect(
      tr.validate("get_definitions", {
        filePath: "src/a.ts",
        line: 10,
        character: 2,
      }).ok,
    ).toBe(true);
    expect(tr.validate("get_definitions", { filePath: "a" }).ok).toBe(false);

    expect(
      tr.validate("get_references", {
        filePath: "src/a.ts",
        line: 1,
        character: 0,
      }).ok,
    ).toBe(true);
    expect(
      tr.validate("get_references", {
        filePath: "src/a.ts",
        line: "one",
        character: 0,
      }).ok,
    ).toBe(false);

    expect(
      tr.validate("get_document_symbols", { filePath: "README.md" }).ok,
    ).toBe(true);
    expect(tr.validate("get_document_symbols", {}).ok).toBe(false);

    expect(
      tr.validate("rename_symbol", {
        filePath: "src/a.ts",
        line: 1,
        character: 2,
        newName: "x",
      }).ok,
    ).toBe(true);
  });

  it("validates git-related schemas", () => {
    const tr = new ToolRegistry();
    tr.register(
      "git_commit",
      {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      "git_commit",
      "git_commit",
    );
    tr.register(
      "git_diff",
      {
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          {
            type: "object",
            properties: { cached: { type: "boolean" } },
            required: ["cached"],
          },
        ],
      },
      "git_diff",
      "git_diff",
    );
    tr.register("git_status", { type: "object" }, "git_status", "git_status");
    tr.register(
      "git_log",
      {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer" } },
      },
      "git_log",
      "git_log",
    );
    tr.register(
      "git_blame",
      {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
      "git_blame",
      "git_blame",
    );

    expect(tr.validate("git_commit", { message: "fix: tests" }).ok).toBe(true);
    expect(tr.validate("git_commit", { msg: "no" }).ok).toBe(false);

    expect(tr.validate("git_diff", { path: "src/index.ts" }).ok).toBe(true);
    expect(tr.validate("git_diff", { cached: true }).ok).toBe(true);

    expect(tr.validate("git_status", {}).ok).toBe(true);
    expect(tr.validate("git_log", { limit: 5 }).ok).toBe(true);
    expect(tr.validate("git_blame", { filePath: "src/a.ts" }).ok).toBe(true);
  });

  it("validates file and workspace operations", () => {
    const tr = new ToolRegistry();
    tr.register(
      "batch_edit",
      {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                search: { type: "string" },
                replace: { type: "string" },
              },
              required: ["filePath"],
            },
          },
        },
        required: ["edits"],
      },
      "batch_edit",
      "batch_edit",
    );
    tr.register(
      "replace_in_file",
      {
        type: "object",
        properties: {
          filePath: { type: "string" },
          search: { type: "string" },
          replace: { type: "string" },
        },
        required: ["filePath", "search", "replace"],
      },
      "replace_in_file",
      "replace_in_file",
    );
    tr.register(
      "grep_search",
      {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
      "grep_search",
      "grep_search",
    );
    tr.register(
      "list_dir",
      {
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          {
            type: "object",
            properties: { directory: { type: "string" } },
            required: ["directory"],
          },
        ],
      },
      "list_dir",
      "list_dir",
    );
    tr.register(
      "create_directory",
      {
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          {
            type: "object",
            properties: { directory: { type: "string" } },
            required: ["directory"],
          },
        ],
      },
      "create_directory",
      "create_directory",
    );
    tr.register(
      "delete_file",
      {
        oneOf: [
          {
            type: "object",
            properties: { filePath: { type: "string" } },
            required: ["filePath"],
          },
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        ],
      },
      "delete_file",
      "delete_file",
    );
    tr.register(
      "workspace_scan",
      {
        type: "object",
        properties: {
          limit: { type: "integer" },
          includeGlobs: { type: "array", items: { type: "string" } },
        },
      },
      "workspace_scan",
      "workspace_scan",
    );

    expect(
      tr.validate("batch_edit", {
        edits: [{ filePath: "src/a.ts", search: "x", replace: "y" }],
      }).ok,
    ).toBe(true);
    expect(
      tr.validate("replace_in_file", {
        filePath: "src/a.ts",
        search: "x",
        replace: "y",
      }).ok,
    ).toBe(true);
    expect(tr.validate("grep_search", { pattern: "TODO" }).ok).toBe(true);
    expect(tr.validate("list_dir", { path: "src" }).ok).toBe(true);
    expect(tr.validate("create_directory", { path: "src/new" }).ok).toBe(true);
    expect(tr.validate("delete_file", { filePath: "dist/old.js" }).ok).toBe(
      true,
    );
    expect(tr.validate("workspace_scan", { limit: 10 }).ok).toBe(true);
  });
});
