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
 * 30 秒按四个 vault 只读工具的成本粗略兜底，待大库 / 移动端真实测量后调整，不视为永久参数。
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
 * 联网工具是只读的，但会主动访问外部网络；超时沿用现役联网总预算 120 秒，
 * 不为单次工具另造一个没有测量依据的数值。
 */
const WEB_RESEARCH_TOOL_TIMEOUT_MS = 120_000;

/**
 * 工具契约的唯一注册表：工具名来自 `AGENT_TOOL_NAMES`，新增工具时必须同时补定义。
 * 输出裁剪仍由工具循环的 4000 字结果预算负责，这里不维护第二份输出上限。
 */
export const AGENT_TOOL_DEFINITIONS: Record<AgentToolName, AgentToolDefinition> = {
  search_notes: defineReadOnlyTool("search_notes"),
  read_note: defineReadOnlyTool("read_note"),
  note_links: defineReadOnlyTool("note_links"),
  wiki_memory: defineReadOnlyTool("wiki_memory"),
  web_research: {
    name: "web_research",
    readOnly: true,
    sideEffectScope: "network",
    timeoutMs: WEB_RESEARCH_TOOL_TIMEOUT_MS
  }
};

/**
 * 本轮可用工具表：自动联网关闭时整表剔除 `web_research`，模型既看不到工具，
 * 循环也会按未注册跳过；不采用“先给工具再拒绝调用”的两段式开关。
 */
export function resolveAgentToolDefinitions(options: {
  webResearch: boolean;
}): Partial<Record<AgentToolName, AgentToolDefinition>> {
  if (options.webResearch) {
    return AGENT_TOOL_DEFINITIONS;
  }
  const vaultOnly: Partial<Record<AgentToolName, AgentToolDefinition>> = {
    ...AGENT_TOOL_DEFINITIONS
  };
  delete vaultOnly.web_research;
  return vaultOnly;
}

export function getAgentToolDefinition(name: AgentToolName): AgentToolDefinition {
  return AGENT_TOOL_DEFINITIONS[name];
}
