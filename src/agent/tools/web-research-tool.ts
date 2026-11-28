import type { ResearchPage, ResearchRoundResult } from "../web-search/research-agent";
import { sanitizeFencedText } from "../web-search/sidet-protocol";

/** 单次工具结果的硬上限；与工具循环的结果预算分开，防止单次超大结果撑爆协议块。 */
const MAX_WEB_RESEARCH_TOOL_CHARS = 4_000;

function formatSourceLine(page: ResearchPage): string {
  const title = sanitizeFencedText(
    page.title.replace(/\s+/g, " ").trim()
  ).slice(0, 200);
  const url = sanitizeFencedText(page.url.trim()).slice(0, 500);
  return `[${page.sourceIndex}] ${title || "（无标题）"} — ${url}`;
}

/**
 * 自动联网工具的模型侧结果：来源编号列表 + 证据正文。
 *
 * 编号沿用检索轮次的 `sourceIndex`，与最终回答的 `[n]` 角标和来源 footer 对齐；
 * 内容是纯文本，由工具循环包进 ```sidet-tool-result```，因此正文里的三反引号
 * 必须先转义，避免破坏外层协议块。
 */
export function buildWebResearchToolContent(
  result: Pick<ResearchRoundResult, "evidenceText">,
  pages: ResearchPage[]
): string {
  const lines: string[] = ["sources:"];

  if (pages.length === 0) {
    lines.push("- 本轮没有读到网页正文。");
  } else {
    for (const page of pages) {
      lines.push(formatSourceLine(page));
    }
  }

  lines.push(
    "---",
    sanitizeFencedText(result.evidenceText.trim() || "本轮没有形成可用证据。")
  );
  const content = lines.join("\n");
  return content.length > MAX_WEB_RESEARCH_TOOL_CHARS
    ? `${content.slice(0, MAX_WEB_RESEARCH_TOOL_CHARS - 1)}…`
    : content;
}
