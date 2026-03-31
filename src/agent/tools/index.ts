/**
 * Re-exports for all modular tool implementations.
 */
export type { AgentTool } from "./BaseTool";
export { stringifyError, firstString, extractStringList } from "./BaseTool";

export {
  WriteFileTool,
  ReplaceInFileTool,
  GrepSearchTool,
} from "./FileSystemTools";
export type { FileToolContext } from "./FileSystemTools";

export {
  GetDefinitionsTool,
  GetReferencesTool,
  GetDocumentSymbolsTool,
  RenameSymbolTool,
} from "./LSPTools";
export type { LSPToolContext } from "./LSPTools";

export {
  GitCommitTool,
  GitLogTool,
  GitStatusTool,
  GitBranchTool,
} from "./GitTools";
export type { GitToolContext } from "./GitTools";
