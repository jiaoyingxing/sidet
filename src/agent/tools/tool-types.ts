
export const AGENT_TOOL_NAMES = [
  "search_notes",
  "read_note",
  "note_links",
  "web_research"
] as const;

export type AgentToolName = typeof AGENT_TOOL_NAMES[number];

export type AgentToolStatus = "ok" | "error";

export interface AgentToolInvocation {
  tool: AgentToolName;
  query: string | null;
  path: string | null;
  heading: string | null;
  limit: number | null;
}

export interface AgentToolExecutionResult {
  tool: AgentToolName;
  status: AgentToolStatus;
  content: string;
}

export type AgentToolResultBlock = AgentToolExecutionResult;
