export interface SidetResearchInstruction {
  question: string;
  reason: string | null;
}

const RESEARCH_BLOCK_PATTERN = /```sidet-research(?!-result)[ \t]*\r?\n([\s\S]*?)```/i;

/**
 * 历史消息里可能还躺着旧协议块。块名继续参与 strip，避免升级后把协议文本
 * 露给用户；解析与执行路径已经统一到 `sidet-research`。
 */
const PROTOCOL_BLOCK_PATTERN = /```sidet-(?:direct|search|search-result|fetch|web-context|tool-result|tool|research|research-result)\s*\n[\s\S]*?```/gi;

export interface BuildSidetResearchResultPage {
  sourceIndex: number;
  title: string;
  url: string;
}

export interface BuildSidetResearchResultBlockOptions {
  round: number;
  question: string;
  queries: string[];
  providerLabel: string;
  searchResultCount: number;
  sourceStart: number;
  pages: BuildSidetResearchResultPage[];
  evidenceText: string;
}

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

/** 协议块内容里不允许出现嵌套三反引号；工具结果与检索结果共用同一条转义规则。 */
export function sanitizeFencedText(text: string): string {
  return text.replace(/```/g, "'''");
}

function toSingleLine(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

export function parseSidetResearchBlock(markdown: string): SidetResearchInstruction | null {
  const match = markdown.match(RESEARCH_BLOCK_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const fields = parseHeaderFields(match[1].trim());
  const question = fields.question?.trim() || fields.query?.trim() || fields.q?.trim() || "";
  if (!question) {
    return null;
  }

  return {
    question,
    reason: fields.reason?.trim() || null
  };
}

export function buildSidetResearchResultBlock(
  options: BuildSidetResearchResultBlockOptions
): string {
  const lines: string[] = [
    "```sidet-research-result",
    `round: ${options.round}`,
    `question: ${toSingleLine(options.question)}`,
    `queries: ${options.queries.map(toSingleLine).join(" / ")}`,
    `provider: ${toSingleLine(options.providerLabel) || "Sidet"}`,
    `searchResultCount: ${options.searchResultCount}`,
    `sourceStart: ${options.sourceStart}`,
    `sourceCount: ${options.pages.length}`,
    "---",
    "sources:"
  ];

  if (options.pages.length === 0) {
    lines.push("- 本轮没有读到网页正文。");
  } else {
    for (const page of options.pages) {
      lines.push(`[${page.sourceIndex}] ${page.title} — ${page.url}`);
    }
  }

  lines.push(
    "---",
    sanitizeFencedText(options.evidenceText.trim() || "本轮没有形成可用证据。"),
    "```"
  );
  return lines.join("\n");
}

export function stripSidetProtocolBlocks(markdown: string): string {
  return markdown
    .replace(PROTOCOL_BLOCK_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
