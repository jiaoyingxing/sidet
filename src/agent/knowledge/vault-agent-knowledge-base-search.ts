import {
  ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
  ALL_KNOWLEDGE_BASES_SELECTION
} from "../../constants";
import type { MessageAttachment, MessageKnowledgeBaseRoutingInfo } from "../../types";
import type { WikiKnowledgeIndex, WikiKnowledgeMatch } from "../wiki/wiki-memory-index";
import { getWikiKindLabel } from "../wiki/vault-agent-wiki-formatting";

interface VaultAgentKnowledgeBaseSearchBuilderOptions {
  wikiKnowledgeIndex: WikiKnowledgeIndex;
}

export interface VaultAgentKnowledgeBaseSearchResult {
  responseMarkdown: string;
  knowledgeBaseRouting: MessageKnowledgeBaseRoutingInfo;
}

export class VaultAgentKnowledgeBaseSearchBuilder {
  constructor(private readonly options: VaultAgentKnowledgeBaseSearchBuilderOptions) {}

  async build(
    text: string,
    attachments: MessageAttachment[],
    selectedKnowledgeBaseIndexPath: string | null
  ): Promise<VaultAgentKnowledgeBaseSearchResult | null> {
    const isAllKnowledgeBasesSelected = selectedKnowledgeBaseIndexPath === ALL_KNOWLEDGE_BASES_SELECTION;
    const selectedKnowledgeBase = selectedKnowledgeBaseIndexPath && !isAllKnowledgeBasesSelected
      ? this.options.wikiKnowledgeIndex.findKnowledgeBaseByIndexPath(selectedKnowledgeBaseIndexPath)
      : null;

    if (!selectedKnowledgeBase && !isAllKnowledgeBasesSelected) {
      return null;
    }

    const wikiMatches = await this.options.wikiKnowledgeIndex.findRelevantEntries(
      text,
      attachments,
      selectedKnowledgeBase?.rootPath ?? null
    );
    const routing: MessageKnowledgeBaseRoutingInfo = {
      mode: isAllKnowledgeBasesSelected ? "all" : "single",
      displayName: selectedKnowledgeBase?.displayName ?? ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
      status: "complete",
      resultCount: wikiMatches.length,
      hits: wikiMatches.slice(0, 4).map((match) => ({
        path: match.file.path,
        basename: match.file.basename,
        kindLabel: getWikiKindLabel(match)
      }))
    };

    return {
      responseMarkdown: this.buildResponseMarkdown(routing, wikiMatches),
      knowledgeBaseRouting: routing
    };
  }

  private buildResponseMarkdown(
    routing: MessageKnowledgeBaseRoutingInfo,
    wikiMatches: WikiKnowledgeMatch[]
  ): string {
    const lines: string[] = [
      "# 知识库检索结果",
      "",
      `- 范围：${routing.displayName}`,
      `- 命中：${routing.resultCount} 篇`
    ];

    if (wikiMatches.length === 0) {
      lines.push(
        "",
        "当前没有找到直接相关的笔记。",
        "",
        "可以换一个更具体的词，或直接写概念名、文件名或英文原词。"
      );
      return lines.join("\n");
    }

    lines.push("", "## 命中结果", "");
    const visibleMatches = wikiMatches.slice(0, routing.hits.length);
    for (const [index, match] of visibleMatches.entries()) {
      lines.push(
        `### ${index + 1}. [[${match.file.path}]]`,
        `- 类型：${getWikiKindLabel(match)}`,
        `- 匹配：${match.matchedTerms.slice(0, 8).join(" / ") || "标题或路径相关"}`
      );
      const matchedFragments = buildMatchedFragmentLines(match);
      if (matchedFragments.length > 0) {
        lines.push(`- 命中片段：${matchedFragments.join(" / ")}`);
      } else {
        const excerpt = buildExcerptLine(match);
        if (excerpt) {
          lines.push(`- 摘录：${excerpt}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

function buildMatchedFragmentLines(match: WikiKnowledgeMatch): string[] {
  return match.matchedFragments
    .map((fragment) => singleLine(fragment))
    .filter(Boolean)
    .slice(0, 3);
}

function buildExcerptLine(match: WikiKnowledgeMatch): string | null {
  const excerpt = singleLine(match.excerpt);
  if (!excerpt) {
    return null;
  }
  return excerpt.length > 140
    ? `${excerpt.slice(0, 140).trimEnd()}...`
    : excerpt;
}

function singleLine(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}
