import { App, TFolder } from "obsidian";
import { MAX_AGENT_CONTEXT_CHARS } from "../constants";
import {
  type ContextDraftResult
} from "./context-bundle";
import { VaultAgentDraftBuilders } from "./vault-agent-draft-builders";
import { VaultAgentKnowledgeBaseFiles } from "./knowledge/vault-agent-knowledge-base-files";
import { UserSkillIndex } from "./skills/user-skills";
import { WikiKnowledgeIndex } from "./wiki/wiki-memory-index";
import {
  VaultAgentRouterContextBuilder,
  type VaultAgentPreSendContextResult
} from "./vault-agent-router-context";
import {
  VaultAgentKnowledgeBaseSearchBuilder,
  type VaultAgentKnowledgeBaseSearchResult
} from "./knowledge/vault-agent-knowledge-base-search";
import { VaultAgentWikiMaintenancePromptBuilder } from "./wiki/vault-agent-wiki-maintenance";
import type { ConversationRecord, MarkdownMessageAttachment, MessageAttachment } from "../types";
import type { WikiKnowledgeBaseInfo, WikiKnowledgeMatch } from "./wiki/wiki-memory-index";
import type { SelectedKnowledgeBaseState } from "../workspace/workspace-controller";

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: text.slice(0, maxChars).trimEnd(),
    truncated: true
  };
}

function isWikiMaintenancePlanMarkdown(markdown: string): boolean {
  return /^#\s*Wiki\s*维护计划\s*$/m.test(markdown.replace(/\r\n/g, "\n"));
}

export class VaultAgentService {
  private readonly wikiKnowledgeIndex: WikiKnowledgeIndex;
  private readonly userSkillIndex: UserSkillIndex;
  private readonly draftBuilders: VaultAgentDraftBuilders;
  private readonly knowledgeBaseFiles: VaultAgentKnowledgeBaseFiles;
  private readonly routerContextBuilder: VaultAgentRouterContextBuilder;
  private readonly knowledgeBaseSearchBuilder: VaultAgentKnowledgeBaseSearchBuilder;
  private readonly wikiMaintenancePromptBuilder: VaultAgentWikiMaintenancePromptBuilder;

  constructor(app: App) {
    this.wikiKnowledgeIndex = new WikiKnowledgeIndex(app);
    this.userSkillIndex = new UserSkillIndex(app);
    this.draftBuilders = new VaultAgentDraftBuilders();
    this.knowledgeBaseFiles = new VaultAgentKnowledgeBaseFiles(app);
    this.routerContextBuilder = new VaultAgentRouterContextBuilder({
      wikiKnowledgeIndex: this.wikiKnowledgeIndex,
      userSkillIndex: this.userSkillIndex
    });
    this.knowledgeBaseSearchBuilder = new VaultAgentKnowledgeBaseSearchBuilder({
      wikiKnowledgeIndex: this.wikiKnowledgeIndex
    });
    this.wikiMaintenancePromptBuilder = new VaultAgentWikiMaintenancePromptBuilder({
      app,
      wikiKnowledgeIndex: this.wikiKnowledgeIndex,
      isWikiMaintenancePlanMarkdown,
      normalizeText,
      clipText,
      maxAgentContextChars: MAX_AGENT_CONTEXT_CHARS
    });
  }

  async buildPreSendAgentContext(
    text: string,
    attachments: MessageAttachment[],
    selectedKnowledgeBase: SelectedKnowledgeBaseState | WikiKnowledgeBaseInfo | null = null
  ): Promise<VaultAgentPreSendContextResult> {
    const selectedKnowledgeBaseIndexPath =
      selectedKnowledgeBase && "mode" in selectedKnowledgeBase
        ? selectedKnowledgeBase.indexPath
        : selectedKnowledgeBase?.indexPath ?? null;
    return this.routerContextBuilder.build(text, attachments, selectedKnowledgeBaseIndexPath ?? null);
  }

  async buildKnowledgeBaseSearchReply(
    text: string,
    attachments: MessageAttachment[],
    selectedKnowledgeBase: SelectedKnowledgeBaseState | WikiKnowledgeBaseInfo | null
  ): Promise<VaultAgentKnowledgeBaseSearchResult | null> {
    const selectedKnowledgeBaseIndexPath =
      selectedKnowledgeBase && "mode" in selectedKnowledgeBase
        ? selectedKnowledgeBase.indexPath
        : selectedKnowledgeBase?.indexPath ?? null;
    return this.knowledgeBaseSearchBuilder.build(text, attachments, selectedKnowledgeBaseIndexPath ?? null);
  }

  findKnowledgeBases(): WikiKnowledgeBaseInfo[] {
    return this.wikiKnowledgeIndex.findKnowledgeBases();
  }

  async searchWikiMemory(query: string): Promise<WikiKnowledgeMatch[]> {
    return this.wikiKnowledgeIndex.findRelevantEntries(query, [], null);
  }

  findKnowledgeBaseByIndexPath(indexPath: string): WikiKnowledgeBaseInfo | null {
    return this.wikiKnowledgeIndex.findKnowledgeBaseByIndexPath(indexPath);
  }

  primeKnowledgeBasesFromMetadataCache(): boolean {
    return this.wikiKnowledgeIndex.primeKnowledgeBasesFromMetadataCache();
  }

  async refreshKnowledgeBases(): Promise<boolean> {
    return this.wikiKnowledgeIndex.refreshKnowledgeBases();
  }

  buildMemoryCandidateDraft(conversation: ConversationRecord): ContextDraftResult {
    return this.draftBuilders.buildMemoryCandidateDraft(conversation);
  }

  async buildWikiMaintenancePlanFromConversationPrompt(
    conversation: ConversationRecord,
    userBoundary?: string
  ): Promise<string> {
    return this.wikiMaintenancePromptBuilder.buildFromConversation(conversation, userBoundary);
  }

  async buildWikiMaintenancePlanFromMarkdownPrompt(
    attachment: MarkdownMessageAttachment,
    userBoundary?: string
  ): Promise<string> {
    return this.wikiMaintenancePromptBuilder.buildFromMarkdown(attachment, userBoundary);
  }

  buildWikiExecutionDraftRequestContext(conversation: ConversationRecord): string {
    return this.wikiMaintenancePromptBuilder.buildExecutionDraftRequestContext(conversation);
  }

  async createKnowledgeBaseIndexForFolder(folder: TFolder): Promise<{ path: string; created: boolean }> {
    return this.knowledgeBaseFiles.createIndexForFolder(folder);
  }

  async repairMalformedWikiNotes(): Promise<{ scanned: number; repaired: string[]; indexCreated: boolean }> {
    return this.knowledgeBaseFiles.repairMalformedWikiNotes();
  }

  buildSkillPrompt(conversation: ConversationRecord): string {
    return this.draftBuilders.buildSkillPrompt(conversation);
  }

  buildDraftNotePreviewDraft(conversation: ConversationRecord): ContextDraftResult {
    return this.draftBuilders.buildDraftNotePreviewDraft(conversation);
  }
}
