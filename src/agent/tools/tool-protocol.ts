import { AGENT_TOOL_NAMES } from "./tool-types";
import type {
  AgentToolExecutionResult,
  AgentToolInvocation,
  AgentToolName,
  AgentToolResultBlock,
  AgentToolStatus
} from "./tool-types";

/**
 * 只读工具协议（第一步）：
 *
 * ```sidet-tool
 * tool: search_notes | read_note | note_links | wiki_memory
 * query: ...
 * ```
 *
 * 字段沿用现役协议的单行 `key: value` 写法；一次回复只解析第一个工具块。
 * 未知工具、缺必填字段或空块都按 malformed 处理（parse 返回 null）。
 */
const TOOL_BLOCK_PATTERN = /```sidet-tool(?!-)[ \t]*\r?\n([\s\S]*?)```/i;
const TOOL_RESULT_BLOCK_PATTERN = /```sidet-tool-result[ \t]*\r?\n([\s\S]*?)```/i;

const TOOL_NAME_SET = new Set<string>(AGENT_TOOL_NAMES);

const REQUIRED_FIELD_BY_TOOL: Record<AgentToolName, "query" | "path"> = {
  search_notes: "query",
  read_note: "path",
  note_links: "path",
  wiki_memory: "query"
};

function parseHeaderFields(headerText: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of headerText.split("\n")) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }
    fields[match[1].toLowerCase()] = match[2]?.trim() ?? "";
  }
  return fields;
}

function parsePositiveInt(rawValue: string | undefined): number | null {
  const value = Number.parseInt(rawValue?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readField(fields: Record<string, string>, key: string): string | null {
  return fields[key]?.trim() || null;
}

export function isAgentToolName(value: string): value is AgentToolName {
  return TOOL_NAME_SET.has(value);
}

export function parseAgentToolInvocation(markdown: string): AgentToolInvocation | null {
  const match = markdown.match(TOOL_BLOCK_PATTERN);
  if (match?.[1] === undefined) {
    return null;
  }

  const fields = parseHeaderFields(match[1].trim());
  const toolValue = (fields.tool ?? "").trim().toLowerCase();
  if (!isAgentToolName(toolValue)) {
    return null;
  }

  const query = readField(fields, "query");
  const path = readField(fields, "path");
  const requiredField = REQUIRED_FIELD_BY_TOOL[toolValue];
  if (requiredField === "query" ? !query : !path) {
    return null;
  }

  return {
    tool: toolValue,
    query,
    path,
    heading: readField(fields, "heading"),
    limit: parsePositiveInt(fields.limit)
  };
}

export function isAgentToolInvocationMalformed(markdown: string): boolean {
  return TOOL_BLOCK_PATTERN.test(markdown) && parseAgentToolInvocation(markdown) === null;
}

export function parseAgentToolResultBlock(markdown: string): AgentToolResultBlock | null {
  const match = markdown.match(TOOL_RESULT_BLOCK_PATTERN);
  if (match?.[1] === undefined) {
    return null;
  }

  const lines = match[1].trim().split(/\r?\n/);
  const separatorIndex = lines.findIndex((line) => line.trim() === "---");
  if (separatorIndex < 0) {
    return null;
  }

  const fields = parseHeaderFields(lines.slice(0, separatorIndex).join("\n"));
  const toolValue = (fields.tool ?? "").trim().toLowerCase();
  const statusValue = (fields.status ?? "").trim().toLowerCase();
  const content = lines.slice(separatorIndex + 1).join("\n").trim();
  if (!isAgentToolName(toolValue) || !isAgentToolStatus(statusValue) || !content) {
    return null;
  }

  return {
    tool: toolValue,
    status: statusValue,
    content
  };
}

export function isAgentToolResultBlockMalformed(markdown: string): boolean {
  return TOOL_RESULT_BLOCK_PATTERN.test(markdown) && parseAgentToolResultBlock(markdown) === null;
}

function isAgentToolStatus(value: string): value is AgentToolStatus {
  return value === "ok" || value === "error";
}

export function buildAgentToolResultBlock(result: AgentToolExecutionResult): string {
  return [
    "```sidet-tool-result",
    `tool: ${result.tool}`,
    `status: ${result.status}`,
    "---",
    result.content.trimEnd(),
    "```"
  ].join("\n");
}
