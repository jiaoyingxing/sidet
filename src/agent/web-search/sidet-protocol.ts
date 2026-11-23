import type { WebSearchResult } from "../../context/web-search-service";
import type { WebpageMessageAttachment } from "../../types";
import { trimContextTextToBudget } from "../context-bundle";
export {
  buildSidetDirectAnswerContext,
  buildSidetWebSearchContinuationRepairContext,
  buildSidetWebSearchFinalAnswerContext,
  buildSidetWebSearchFinalAnswerRepairContext,
  buildSidetWebSearchInstructionContext,
  buildSidetWebSearchRoutingContext,
  buildSidetWebSearchRoutingRepairContext
} from "../prompts/web-search-prompts";

export interface SidetSearchInstruction {
  intent: string;
  round: number | null;
  queries: string[];
  reason: string | null;
}

export interface SidetFetchInstruction {
  round: number | null;
  picks: number[];
  reason: string | null;
}

export interface SidetDirectInstruction {
  reason: string | null;
}

const DIRECT_BLOCK_PATTERN = /```sidet-direct\s*\n([\s\S]*?)```/i;
const SEARCH_BLOCK_PATTERN = /```sidet-search\s*\n([\s\S]*?)```/i;
const FETCH_BLOCK_PATTERN = /```sidet-fetch\s*\n([\s\S]*?)```/i;
const PROTOCOL_BLOCK_PATTERN = /```sidet-(?:direct|search|search-result|fetch|web-context)\s*\n[\s\S]*?```/gi;
const WEB_CONTEXT_CONTENT_BUDGET_CHARS = 60_000;

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

function collectOrderedValues(
  fields: Record<string, string>,
  prefix: string,
  allowBare = false
): string[] {
  const values = Object.entries(fields)
    .filter(([key]) => key === prefix || key.startsWith(prefix))
    .map(([key, value]) => {
      const suffix = key.slice(prefix.length);
      const order = suffix.length === 0
        ? (allowBare ? 0 : Number.MAX_SAFE_INTEGER)
        : Number.parseInt(suffix, 10);
      return {
        order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
        value: value.trim()
      };
    })
    .filter((item) => item.value.length > 0)
    .sort((left, right) => left.order - right.order)
    .map((item) => item.value);

  return Array.from(new Set(values));
}

function collectOrderedNumbers(fields: Record<string, string>, prefix: string): number[] {
  const values = Object.entries(fields)
    .filter(([key]) => key === prefix || key.startsWith(prefix))
    .map(([key, value]) => {
      const suffix = key.slice(prefix.length);
      const order = suffix.length === 0 ? 0 : Number.parseInt(suffix, 10);
      return {
        order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
        value: parsePositiveInt(value)
      };
    })
    .filter((item) => item.value !== null)
    .sort((left, right) => left.order - right.order)
    .map((item) => item.value as number);

  return Array.from(new Set(values));
}

export function parseSidetDirectBlock(markdown: string): SidetDirectInstruction | null {
  const match = markdown.match(DIRECT_BLOCK_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const fields = parseHeaderFields(match[1].trim());
  return {
    reason: fields.reason?.trim() || null
  };
}

export function parseSidetSearchBlock(markdown: string): SidetSearchInstruction | null {
  const match = markdown.match(SEARCH_BLOCK_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const fields = parseHeaderFields(match[1].trim());
  const queries = collectOrderedValues(fields, "query", true);
  if (queries.length === 0) {
    return null;
  }

  return {
    intent: fields.intent?.trim() || "web_search",
    round: parsePositiveInt(fields.round),
    queries,
    reason: fields.reason?.trim() || null
  };
}

export function parseSidetFetchBlock(markdown: string): SidetFetchInstruction | null {
  const match = markdown.match(FETCH_BLOCK_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const fields = parseHeaderFields(match[1].trim());
  const picks = collectOrderedNumbers(fields, "pick");
  if (picks.length === 0) {
    return null;
  }

  return {
    round: parsePositiveInt(fields.round),
    picks,
    reason: fields.reason?.trim() || null
  };
}

export function buildSidetSearchResultBlock(
  round: number,
  selectedQuery: string,
  providerLabel: string,
  results: WebSearchResult[]
): string {
  const lines: string[] = [
    "```sidet-search-result",
    `round: ${round}`,
    `selectedQuery: ${selectedQuery}`,
    `provider: ${providerLabel}`,
    `resultCount: ${results.length}`,
    "---"
  ];

  results.forEach((result, index) => {
    lines.push(
      `[${index + 1}]`,
      `title: ${result.title}`,
      `url: ${result.url}`,
      `host: ${result.host}`,
      `snippet: ${result.snippet || "无"}`,
      ""
    );
  });

  lines.push("```");
  return lines.join("\n");
}

export function buildSidetWebContextBlock(
  round: number,
  sources: Array<Pick<WebpageMessageAttachment, "name" | "url" | "content"> & { snippet?: string }>
): string {
  const lines: string[] = [
    "```sidet-web-context",
    `round: ${round}`,
    `sourceCount: ${sources.length}`,
    "---"
  ];
  let remainingContentBudget = WEB_CONTEXT_CONTENT_BUDGET_CHARS;

  sources.forEach((source, index) => {
    const content = source.content.trim() || "无正文";
    const boundedContent = remainingContentBudget > 0
      ? trimContextTextToBudget(
          content,
          remainingContentBudget,
          "[本轮网页正文过长，已截断]"
        ).text
      : "[本轮网页正文过长，已截断]";
    remainingContentBudget = Math.max(
      0,
      remainingContentBudget - Math.min(content.length, remainingContentBudget)
    );
    lines.push(
      `[${index + 1}]`,
      `title: ${source.name}`,
      `url: ${source.url}`,
      `snippet: ${(source.snippet ?? "").trim() || "无"}`,
      "content:",
      boundedContent,
      ""
    );
  });

  lines.push("```");
  return lines.join("\n");
}

export function stripSidetProtocolBlocks(markdown: string): string {
  return markdown
    .replace(PROTOCOL_BLOCK_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
