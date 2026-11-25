import type { AgentToolName } from "./tool-types";

export type AgentToolSideEffectScope =
  | "none"
  | "session"
  | "workspace"
  | "git"
  | "network"
  | "system";

export interface AgentToolDefinition {
  name: AgentToolName;
  readOnly: boolean;
  sideEffectScope: AgentToolSideEffectScope;
  timeoutMs: number;
}

/**
 * 执行超时是首版安全网，不是性能预算：只负责避免单个工具无限期占住有界循环。
 * 30 秒按当前四个只读工具的成本粗略兜底，待大库 / 移动端真实测量后调整，不视为永久参数。
 */
const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 30_000;

function defineReadOnlyTool(name: AgentToolName): AgentToolDefinition {
  return {
    name,
    readOnly: true,
    sideEffectScope: "none",
    timeoutMs: DEFAULT_AGENT_TOOL_TIMEOUT_MS
  };
}

/**
 * 工具契约的唯一注册表：工具名来自 `AGENT_TOOL_NAMES`，新增工具时必须同时补定义。
 * 输出裁剪仍由 `VaultToolService` 的 4000 字预算负责，这里不维护第二份输出上限。
 */
export const AGENT_TOOL_DEFINITIONS: Record<AgentToolName, AgentToolDefinition> = {
  search_notes: defineReadOnlyTool("search_notes"),
  read_note: defineReadOnlyTool("read_note"),
  note_links: defineReadOnlyTool("note_links"),
  wiki_memory: defineReadOnlyTool("wiki_memory")
};

export function getAgentToolDefinition(name: AgentToolName): AgentToolDefinition {
  return AGENT_TOOL_DEFINITIONS[name];
}
