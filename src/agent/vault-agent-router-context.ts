import {
  ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
  ALL_KNOWLEDGE_BASES_SELECTION,
  MAX_AGENT_BUILT_IN_SKILLS,
  MAX_AGENT_ROUTER_CONTEXT_CHARS,
  MAX_AGENT_USER_SKILLS
} from "../constants";
import type { MessageAttachment, MessageKnowledgeBaseRoutingInfo } from "../types";
import { findRelevantBuiltInSkills } from "./skills/builtin-skills";
import { formatContextBundleBlock, trimContextTextToBudget, type ContextBundleSection } from "./context-bundle";
import { buildAgentRouterContextBundle } from "./prompts/router-context-prompts";
import type { UserSkillIndex } from "./skills/user-skills";
import type { WikiKnowledgeIndex } from "./wiki/wiki-memory-index";
import {
  buildKnowledgeBaseRouteLine,
  formatWikiMatchContent,
  getWikiKindLabel
} from "./wiki/vault-agent-wiki-formatting";

interface VaultAgentRouterContextBuilderOptions {
  wikiKnowledgeIndex: WikiKnowledgeIndex;
  userSkillIndex: UserSkillIndex;
}

export interface VaultAgentPreSendContextResult {
  requestContext: string | null;
  knowledgeBaseRouting: MessageKnowledgeBaseRoutingInfo | null;
}

export class VaultAgentRouterContextBuilder {
  constructor(private readonly options: VaultAgentRouterContextBuilderOptions) {}

  async build(
    text: string,
    attachments: MessageAttachment[],
    selectedKnowledgeBaseIndexPath: string | null = null
  ): Promise<VaultAgentPreSendContextResult> {
    const isAllKnowledgeBasesSelected = selectedKnowledgeBaseIndexPath === ALL_KNOWLEDGE_BASES_SELECTION;
    const selectedKnowledgeBase = selectedKnowledgeBaseIndexPath && !isAllKnowledgeBasesSelected
      ? this.options.wikiKnowledgeIndex.findKnowledgeBaseByIndexPath(selectedKnowledgeBaseIndexPath)
      : null;
    const [wikiMatches, builtInSkillCards, userSkillCards] = await Promise.all([
      selectedKnowledgeBase || isAllKnowledgeBasesSelected
        ? this.options.wikiKnowledgeIndex.findRelevantEntries(
            text,
            attachments,
            selectedKnowledgeBase?.rootPath ?? null
          )
        : Promise.resolve([]),
      Promise.resolve(findRelevantBuiltInSkills(text, attachments, MAX_AGENT_BUILT_IN_SKILLS)),
      this.options.userSkillIndex.findRelevantSkills(text, attachments, MAX_AGENT_USER_SKILLS)
    ]);
    const knowledgeBases = selectedKnowledgeBase
      ? [selectedKnowledgeBase]
      : isAllKnowledgeBasesSelected
        ? this.options.wikiKnowledgeIndex.findKnowledgeBases()
      : wikiMatches.length > 0
        ? this.options.wikiKnowledgeIndex.findKnowledgeBases()
        : [];
    const skillCards = [...userSkillCards, ...builtInSkillCards];
    const knowledgeBaseRouting: MessageKnowledgeBaseRoutingInfo | null =
      selectedKnowledgeBase || isAllKnowledgeBasesSelected
        ? {
            mode: isAllKnowledgeBasesSelected ? "all" : "single",
            displayName: selectedKnowledgeBase?.displayName ?? ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
            resultCount: wikiMatches.length,
            hits: wikiMatches.slice(0, 4).map((match) => ({
              path: match.file.path,
              basename: match.file.basename,
              kindLabel: getWikiKindLabel(match)
            }))
          }
        : null;

    if (wikiMatches.length === 0 && skillCards.length === 0) {
      return {
        requestContext: null,
        knowledgeBaseRouting
      };
    }

    const skillRouteLines = skillCards.flatMap((card, index) => {
      const lines = [
        `${index + 1}. ${card.name}`,
        `适用：${card.useWhen}`,
        `边界：${card.constraints.join("；")}`
      ];
      if (card.protocol?.length) {
        lines.push(`协议：${card.protocol.join("；")}`);
      }
      lines.push(`来源：${card.sourcePath ? `${card.source} · [[${card.sourcePath}]]` : card.source}`);
      return lines;
    });
    const knowledgeBaseRouteLines = knowledgeBases.map((knowledgeBase, index) =>
      buildKnowledgeBaseRouteLine(knowledgeBase, index)
    );
    const selectedKnowledgeBaseNote = isAllKnowledgeBasesSelected
      ? `1. ${ALL_KNOWLEDGE_BASES_DISPLAY_NAME}；范围：仅在已识别知识库内做关键词检索。`
      : null;
    const wikiRouteLines = wikiMatches.map((match, index) => {
      const matched = match.matchedTerms.slice(0, 8).join(" / ") || "标题或路径相关";
      return `${index + 1}. [[${match.file.path}]]；类型：${getWikiKindLabel(match)}；匹配：${matched}；读取：${match.routeHint}`;
    });
    const wikiSections: ContextBundleSection[] = wikiMatches.map((match, index) => ({
      heading: `${index + 1}. ${match.file.basename}`,
      metadata: [
        { label: "路径", value: match.file.path },
        { label: "类型", value: getWikiKindLabel(match) }
      ],
      content: formatWikiMatchContent(match)
    }));

    const bundle = buildAgentRouterContextBundle({
      skillRouteLines,
      knowledgeBaseRouteLines,
      selectedKnowledgeBaseNote,
      wikiRouteLines,
      wikiSections,
      truncated: wikiMatches.some((match) => match.truncated)
    });

    return {
      requestContext: trimContextTextToBudget(formatContextBundleBlock(bundle), MAX_AGENT_ROUTER_CONTEXT_CHARS).text,
      knowledgeBaseRouting
    };
  }
}
