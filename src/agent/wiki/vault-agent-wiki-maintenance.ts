import { type App, TFile } from "obsidian";
import { DEFAULT_AGENT_WIKI_FOLDER } from "../../constants";
import type { MarkdownMessageAttachment, ConversationRecord } from "../../types";
import { WIKI_INDEX_FILE_NAME } from "./wiki-note-schema";
import type {
  WikiKnowledgeBaseInfo,
  WikiKnowledgeIndex,
  WikiKnowledgeMatch
} from "./wiki-memory-index";
import {
  buildWikiExecutionDraftRequestContext,
  buildWikiMaintenancePlanPrompt
} from "../prompts/wiki-maintenance-prompts";
import {
  buildKnowledgeBaseRouteLine,
  buildWikiMaintenanceCandidateLine
} from "./vault-agent-wiki-formatting";

interface VaultAgentWikiMaintenancePromptBuilderOptions {
  app: App;
  wikiKnowledgeIndex: WikiKnowledgeIndex;
  isWikiMaintenancePlanMarkdown: (markdown: string) => boolean;
  normalizeText: (text: string) => string;
  clipText: (text: string, maxChars: number) => { text: string; truncated: boolean };
  maxAgentContextChars: number;
}

export class VaultAgentWikiMaintenancePromptBuilder {
  constructor(private readonly options: VaultAgentWikiMaintenancePromptBuilderOptions) {}

  async buildFromConversation(conversation: ConversationRecord, userBoundary?: string): Promise<string> {
    const usefulMessageCount = conversation.messages.filter(
      (message) => message.text.trim() || message.attachments?.length
    ).length;
    if (usefulMessageCount === 0) {
      throw new Error("当前对话还没有可整理到知识库的内容。");
    }

    const sourceText = this.buildConversationMaintenanceSourceText(conversation);
    const sourceAttachments = conversation.messages.flatMap((message) => message.attachments ?? []);
    const titleHints = unique([
      conversation.title.trim(),
      ...sourceAttachments.map((attachment) => attachment.name.trim())
    ]).filter(Boolean);
    await this.options.wikiKnowledgeIndex.refreshKnowledgeBases();
    const knowledgeBases = this.options.wikiKnowledgeIndex.findKnowledgeBases();
    const candidates = await this.options.wikiKnowledgeIndex.findWriteCandidates(
      titleHints,
      sourceText,
      sourceAttachments
    );

    return this.buildWikiMaintenancePlan([
      "来源：本条消息之前的当前 Sidet 对话。",
      `来源对话：${conversation.title || "未命名对话"}`,
      `来源消息数：${usefulMessageCount}`,
      `用户需求与边界：${userBoundary?.trim() || "未填写；请按当前对话的高价值长期内容判断。"}`,
      ...this.buildKnowledgeBaseContextLines(knowledgeBases),
      ...this.buildWikiIndexContextLines(knowledgeBases),
      ...this.buildWikiCandidateContextLines(candidates)
    ]);
  }

  async buildFromMarkdown(attachment: MarkdownMessageAttachment, userBoundary?: string): Promise<string> {
    await this.options.wikiKnowledgeIndex.refreshKnowledgeBases();
    const knowledgeBases = this.options.wikiKnowledgeIndex.findKnowledgeBases();
    const candidates = await this.options.wikiKnowledgeIndex.findWriteCandidates(
      [attachment.name, attachment.path],
      attachment.content,
      [attachment]
    );

    return this.buildWikiMaintenancePlan([
      "来源：随本条消息附带的 Markdown 笔记。",
      `来源笔记：[[${attachment.path}]]`,
      `来源标题：${attachment.name}`,
      `用户需求与边界：${userBoundary?.trim() || "未填写；请按这篇笔记的高价值长期内容判断。"}`,
      ...this.buildKnowledgeBaseContextLines(knowledgeBases),
      ...this.buildWikiIndexContextLines(knowledgeBases),
      ...this.buildWikiCandidateContextLines(candidates)
    ]);
  }

  buildExecutionDraftRequestContext(conversation: ConversationRecord): string {
    const latestAssistantMessage = [...conversation.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.status === "done" && message.text.trim());
    if (!latestAssistantMessage || !this.options.isWikiMaintenancePlanMarkdown(latestAssistantMessage.text)) {
      throw new Error("最近一条 AI 回复不是可继续执行的 Wiki 维护计划。");
    }

    return buildWikiExecutionDraftRequestContext();
  }

  private buildWikiMaintenancePlan(sourceLines: string[]): string {
    return buildWikiMaintenancePlanPrompt(sourceLines);
  }

  private buildKnowledgeBaseContextLines(knowledgeBases: WikiKnowledgeBaseInfo[]): string[] {
    if (knowledgeBases.length === 0) {
      return [
        "已识别知识库：",
        `- 当前还没识别到默认知识库根；第一阶段仍要求默认库有 \`${DEFAULT_AGENT_WIKI_FOLDER}/${WIKI_INDEX_FILE_NAME}\`，并且只在同根目录内维护。`
      ];
    }

    return [
      "已识别知识库：",
      ...knowledgeBases.map((knowledgeBase, index) => `- ${buildKnowledgeBaseRouteLine(knowledgeBase, index)}；边界：不跨目录聚合。`)
    ];
  }

  private buildWikiIndexContextLines(knowledgeBases: WikiKnowledgeBaseInfo[]): string[] {
    const defaultKnowledgeBase = knowledgeBases.find((knowledgeBase) => knowledgeBase.indexPath === `${DEFAULT_AGENT_WIKI_FOLDER}/Index.md`);
    if (defaultKnowledgeBase) {
      return [
        "顶层路由页：",
        `- [[${defaultKnowledgeBase.indexPath}]] 已识别为默认知识库根页；它只负责主题入口、先读顺序和跨主题导航，不承接长正文。`
      ];
    }

    const indexPath = `${DEFAULT_AGENT_WIKI_FOLDER}/${WIKI_INDEX_FILE_NAME}`;
    const indexFile = this.options.app.vault.getAbstractFileByPath(indexPath);
    if (indexFile instanceof TFile && indexFile.extension === "md") {
      return [
        "顶层路由页：",
        `- [[${indexFile.path}]] 已存在，但当前还没被识别成默认知识库根；如果这不是预期，先检查路径和 Index 结构。`
      ];
    }

    return [
      "顶层路由页：",
      `- 当前尚未发现 \`${indexPath}\`；如果本轮已经开始形成多个主题入口，可建议补建。`
    ];
  }

  private buildWikiCandidateContextLines(candidates: WikiKnowledgeMatch[]): string[] {
    if (candidates.length === 0) {
      return [
        "脚本命中的现有 Wiki 候选：",
        "- 当前没有命中明显近邻；只有在确实没有合适承接目标时才建议新建。"
      ];
    }

    return [
      "脚本命中的现有 Wiki 候选：",
      ...candidates.map((candidate, index) => `- ${buildWikiMaintenanceCandidateLine(candidate, index)}`)
    ];
  }

  private buildConversationMaintenanceSourceText(conversation: ConversationRecord): string {
    const usefulMessages = conversation.messages.filter(
      (message) => message.text.trim() || (message.attachments?.length ?? 0) > 0
    );
    const lines = usefulMessages.slice(-12).flatMap((message) => {
      const chunks: string[] = [];
      const text = this.options.normalizeText(message.text);
      if (text) {
        chunks.push(`${message.role}: ${text}`);
      }
      for (const attachment of message.attachments ?? []) {
        if (attachment.type === "markdown") {
          chunks.push(`[markdown] ${attachment.name}\n${attachment.path}\n${attachment.content}`);
          continue;
        }
        if (attachment.type === "webpage") {
          chunks.push(`[webpage] ${attachment.name}\n${attachment.url}\n${attachment.content}`);
          continue;
        }
        chunks.push(`[image] ${attachment.name}`);
      }
      return chunks;
    });

    return this.options.clipText(lines.join("\n\n"), this.options.maxAgentContextChars).text;
  }
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
