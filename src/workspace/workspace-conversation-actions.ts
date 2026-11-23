import { Notice, TFile, WorkspaceLeaf } from "obsidian";
import { CHAT_VIEW_TYPE } from "../constants";
import type { AgentActionPreview } from "../agent/actions/agent-action";
import { AgentActionPreviewService } from "../agent/actions/agent-action-preview";
import type { VaultAgentService } from "../agent/vault-agent";
import type { ConversationStore } from "../conversations/conversation-store";
import type { ActiveContextService } from "../context/active-context";
import type { WebpageContextService } from "../context/webpage-context";
import type { MarkdownExportService } from "../export/markdown-export";
import type {
  DialogPluginSettings,
  MarkdownMessageAttachment,
  MessageAttachment,
  WebpageMessageAttachment
} from "../types";
import { AgentActionPreviewModal } from "./agent-action-preview-modal";
import {
  parseDirectConversationKnowledgeCommand,
  parseDirectWikiPlanContinuationCommand
} from "./knowledge-command-routing";
import { WorkspaceLeafNavigation } from "./workspace-leaf-navigation";
import type { WorkspaceController } from "./workspace-controller";
import { WikiMemoryPromptModal, type WikiMemoryPromptOptions } from "./wiki-memory-prompt-modal";

interface WorkspaceConversationActionsOptions {
  controller: WorkspaceController;
  leafNavigation: WorkspaceLeafNavigation;
  activeContext: ActiveContextService;
  vaultAgent: VaultAgentService;
  exporter: MarkdownExportService;
  conversationStore: ConversationStore;
  agentActionPreview: AgentActionPreviewService;
  webpageContext: WebpageContextService;
  ensureConversationStoreReady: () => Promise<void>;
  sendMessageFromLeaf: (
    leaf: WorkspaceLeaf,
    text: string,
    attachments?: MessageAttachment[],
    options?: { requestContextPrefix?: string | null; replaceFromMessageId?: string | null }
  ) => Promise<void>;
  getSettings: () => DialogPluginSettings;
  resolveFreshKnowledgeConversationLeaf: (targetLeaf?: WorkspaceLeaf) => Promise<WorkspaceLeaf>;
}

function isWikiMaintenancePlanResponse(text: string): boolean {
  return /^#\s*Wiki\s*维护计划\s*$/m.test(text.replace(/\r\n/g, "\n"));
}

export class WorkspaceConversationActions {
  constructor(private readonly options: WorkspaceConversationActionsOptions) {}

  openWikiMemoryPrompt(targetLeaf?: WorkspaceLeaf, options: WikiMemoryPromptOptions = {}): void {
    try {
      const leaf = this.resolveChatLeaf(targetLeaf);
      if (!leaf) {
        throw new Error("当前没有可生成记忆的 Sidet 对话。");
      }
      new WikiMemoryPromptModal(this.options.controller, {
        kind: "conversation",
        leaf
      }, options).open();
    } catch (error) {
      const message = error instanceof Error ? error.message : "打开记忆生成失败。";
      new Notice(message, 4000);
    }
  }

  openWikiMemoryPromptForMarkdownFile(
    file: TFile,
    targetLeaf?: WorkspaceLeaf,
    options: WikiMemoryPromptOptions = {}
  ): void {
    try {
      if (file.extension !== "md") {
        throw new Error("只能整理 Markdown 笔记。");
      }
      new WikiMemoryPromptModal(this.options.controller, {
        kind: "markdown-file",
        file,
        targetLeaf
      }, options).open();
    } catch (error) {
      const message = error instanceof Error ? error.message : "打开记忆生成失败。";
      new Notice(message, 4000);
    }
  }

  tryHandleConversationKnowledgeCommandFromChat(
    leaf: WorkspaceLeaf,
    text: string,
    attachments: MessageAttachment[],
    options: WikiMemoryPromptOptions = {}
  ): boolean {
    if (attachments.length > 0) {
      return false;
    }

    const conversation = this.options.controller.getConversationForLeaf(leaf);
    const continueIntent = parseDirectWikiPlanContinuationCommand(text);
    const latestAssistantMessage = conversation?.messages
      .slice()
      .reverse()
      .find((message) => message.role === "assistant" && message.status === "done" && message.text.trim());
    if (continueIntent && latestAssistantMessage && isWikiMaintenancePlanResponse(latestAssistantMessage.text)) {
      options.onSubmitStart?.();
      void this.continueLatestWikiMaintenancePlan(leaf).then((didStart) => {
        if (!didStart) {
          options.onSubmitError?.();
        }
      });
      return true;
    }

    const intent = parseDirectConversationKnowledgeCommand(text);
    if (!intent) {
      return false;
    }

    const hasUsefulContent = conversation?.messages.some(
      (message) => message.text.trim() || (message.attachments?.length ?? 0) > 0
    ) ?? false;
    if (!conversation || !hasUsefulContent) {
      new Notice("当前对话还没有可整理到知识库的内容。", 4000);
      return true;
    }

    this.openWikiMemoryPrompt(leaf, {
      ...options,
      initialBoundary: intent.boundary ?? options.initialBoundary
    });
    return true;
  }

  async generateWikiMaintenancePlanFromConversation(
    leaf: WorkspaceLeaf,
    userBoundary?: string
  ): Promise<void> {
    await this.options.ensureConversationStoreReady();
    const conversation = this.options.controller.getConversationForLeaf(leaf);
    if (!conversation) {
      throw new Error("当前标签页还没有对话可整理。");
    }
    const prompt = await this.options.vaultAgent.buildWikiMaintenancePlanFromConversationPrompt(conversation, userBoundary);
    await this.options.sendMessageFromLeaf(leaf, prompt);
  }

  async generateWikiMaintenancePlanFromCurrentNote(
    targetLeaf?: WorkspaceLeaf,
    userBoundary?: string
  ): Promise<void> {
    try {
      const attachment = await this.options.activeContext.buildCurrentMarkdownAttachment();
      const leaf = await this.options.resolveFreshKnowledgeConversationLeaf(targetLeaf);
      const prompt = await this.options.vaultAgent.buildWikiMaintenancePlanFromMarkdownPrompt(attachment, userBoundary);
      await this.options.sendMessageFromLeaf(leaf, prompt, [attachment]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "整理当前笔记失败。";
      new Notice(message, 4000);
    }
  }

  async generateWikiMaintenancePlanFromMarkdownFile(
    file: TFile,
    targetLeaf?: WorkspaceLeaf,
    userBoundary?: string
  ): Promise<void> {
    try {
      const leaf = await this.options.resolveFreshKnowledgeConversationLeaf(targetLeaf);
      const attachment = await this.options.activeContext.buildMarkdownFileAttachment(file);
      const prompt = await this.options.vaultAgent.buildWikiMaintenancePlanFromMarkdownPrompt(attachment, userBoundary);
      await this.options.sendMessageFromLeaf(leaf, prompt, [attachment]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "整理笔记失败。";
      new Notice(message, 4000);
    }
  }

  async continueLatestWikiMaintenancePlan(targetLeaf?: WorkspaceLeaf): Promise<boolean> {
    try {
      await this.options.ensureConversationStoreReady();
      const leaf = this.resolveChatLeaf(targetLeaf);
      if (!leaf) {
        throw new Error("当前没有可继续执行的 Sidet 对话。");
      }

      const conversation = this.options.controller.getConversationForLeaf(leaf);
      if (!conversation) {
        throw new Error("当前标签页还没有对话可继续执行。");
      }

      const requestContextPrefix = this.options.vaultAgent.buildWikiExecutionDraftRequestContext(conversation);
      await this.options.sendMessageFromLeaf(leaf, "按计划生成写入草稿", [], {
        requestContextPrefix
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "继续执行 Wiki 维护计划失败。";
      new Notice(message, 4000);
      return false;
    }
  }

  async repairMalformedWikiNotes(): Promise<void> {
    try {
      const { scanned, repaired, indexCreated } = await this.options.vaultAgent.repairMalformedWikiNotes();
      if (repaired.length === 0 && !indexCreated) {
        new Notice(`已检查 ${scanned} 张 Sidet Wiki 卡片，未发现需要修复的格式。`, 5000);
        return;
      }

      if (repaired.length === 0 && indexCreated) {
        new Notice(`已补建 Sidet/Wiki/Index.md，并检查 ${scanned} 张 Sidet Wiki 卡片。`, 5000);
        return;
      }

      if (indexCreated) {
        new Notice(`已补建 Sidet/Wiki/Index.md，并修复 ${repaired.length}/${scanned} 张 Sidet Wiki 卡片。`, 5000);
        return;
      }

      new Notice(`已修复 ${repaired.length}/${scanned} 张 Sidet Wiki 卡片。`, 5000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "修复 Sidet Wiki 卡片失败。";
      new Notice(message, 4000);
    }
  }

  async generateSkillFromConversation(leaf: WorkspaceLeaf): Promise<void> {
    await this.options.ensureConversationStoreReady();
    const conversation = this.options.controller.getConversationForLeaf(leaf);
    if (!conversation) {
      throw new Error("当前标签页还没有对话可整理。");
    }
    const prompt = this.options.vaultAgent.buildSkillPrompt(conversation);
    await this.options.sendMessageFromLeaf(leaf, prompt);
  }

  async generateSkillFromCurrentConversation(targetLeaf?: WorkspaceLeaf): Promise<void> {
    try {
      const leaf = this.resolveChatLeaf(targetLeaf);
      if (!leaf) {
        throw new Error("当前没有可整理的 Sidet 对话。");
      }
      await this.generateSkillFromConversation(leaf);
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成 Skill 失败。";
      new Notice(message, 4000);
    }
  }

  async openCreateDraftNotePreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.openAssistantPreview(
      targetLeaf,
      "当前没有可保存的 Sidet 对话。",
      (leaf) => this.options.agentActionPreview.buildCreateNoteFromLatestAssistant(
        this.options.controller.getConversationForLeaf(leaf)
      )
    );
  }

  async openCreateMemoryCandidatePreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.openAssistantPreview(
      targetLeaf,
      "当前没有可保存的 Sidet 对话。",
      (leaf) => this.options.agentActionPreview.buildCreateMemoryCandidateFromLatestAssistant(
        this.options.controller.getConversationForLeaf(leaf)
      )
    );
  }

  async openCreateWikiMemoryPreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.openAssistantPreview(
      targetLeaf,
      "当前没有可保存的 Sidet 对话。",
      (leaf) => this.options.agentActionPreview.buildCreateWikiMemoryFromLatestAssistant(
        this.options.controller.getConversationForLeaf(leaf)
      )
    );
  }

  async openCreateSkillPreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.openAssistantPreview(
      targetLeaf,
      "当前没有可保存的 Sidet 对话。",
      (leaf) => this.options.agentActionPreview.buildCreateSkillFromLatestAssistant(
        this.options.controller.getConversationForLeaf(leaf)
      )
    );
  }

  async openCreateWebpageClipPreview(attachment: WebpageMessageAttachment): Promise<void> {
    try {
      const preview = await this.options.agentActionPreview.buildCreateNoteFromWebpageAttachment(attachment);
      new AgentActionPreviewModal(this.options.controller, preview).open();
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成网页剪藏预览失败。";
      new Notice(message, 4000);
    }
  }

  async openAppendLatestReplyPreview(file: TFile, targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.openAssistantPreview(
      targetLeaf,
      "当前没有可追加的 Sidet 对话。",
      (leaf) => this.options.agentActionPreview.buildAppendLatestAssistantToMarkdown(
        this.options.controller.getConversationForLeaf(leaf),
        file
      )
    );
  }

  async openReplaceCurrentSelectionPreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    try {
      await this.options.ensureConversationStoreReady();
      const leaf = this.resolveChatLeaf(targetLeaf);
      if (!leaf) {
        throw new Error("当前没有可用于替换的 Sidet 对话。");
      }

      const selection = this.options.activeContext.resolveCurrentSelectionTarget();
      const preview = await this.options.agentActionPreview.buildReplaceSelectionWithLatestAssistant(
        this.options.controller.getConversationForLeaf(leaf),
        selection.file,
        selection.text
      );
      new AgentActionPreviewModal(this.options.controller, preview).open();
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成动作预览失败。";
      new Notice(message, 4000);
    }
  }

  async openReplaceCurrentSectionPreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    try {
      await this.options.ensureConversationStoreReady();
      const leaf = this.resolveChatLeaf(targetLeaf);
      if (!leaf) {
        throw new Error("当前没有可用于替换的 Sidet 对话。");
      }

      const section = this.options.activeContext.resolveCurrentSectionTarget();
      const preview = await this.options.agentActionPreview.buildReplaceSectionWithLatestAssistant(
        this.options.controller.getConversationForLeaf(leaf),
        section.file,
        section.heading,
        section.headingLine,
        section.text
      );
      new AgentActionPreviewModal(this.options.controller, preview).open();
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成动作预览失败。";
      new Notice(message, 4000);
    }
  }

  async buildMarkdownFileAttachment(file: TFile): Promise<MarkdownMessageAttachment> {
    return this.options.activeContext.buildMarkdownFileAttachment(file);
  }

  async buildWebpageAttachment(url: string): Promise<WebpageMessageAttachment> {
    return this.options.webpageContext.buildWebpageAttachment(url);
  }

  async exportConversationForLeaf(leaf: WorkspaceLeaf): Promise<void> {
    await this.options.ensureConversationStoreReady();
    const conversation = this.options.controller.getConversationForLeaf(leaf);
    if (!conversation) {
      throw new Error("当前标签页还没有对话可导出。");
    }
    await this.options.exporter.exportConversation(
      conversation,
      this.options.getSettings(),
      this.options.controller.getConversationModelDisplayName(conversation.id)
    );
  }

  async exportConversationById(conversationId: string): Promise<void> {
    try {
      await this.options.ensureConversationStoreReady();
      const conversation = this.options.conversationStore.getConversation(conversationId);
      if (!conversation) {
        throw new Error("目标对话不存在。");
      }
      await this.options.exporter.exportConversation(
        conversation,
        this.options.getSettings(),
        this.options.controller.getConversationModelDisplayName(conversation.id)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "导出对话失败。";
      new Notice(message, 4000);
    }
  }

  private resolveChatLeaf(targetLeaf?: WorkspaceLeaf): WorkspaceLeaf | null {
    return targetLeaf && targetLeaf.getViewState().type === CHAT_VIEW_TYPE
      ? targetLeaf
      : this.options.leafNavigation.getNavigationChatLeaf();
  }

  private async openAssistantPreview(
    targetLeaf: WorkspaceLeaf | undefined,
    missingLeafMessage: string,
    buildPreview: (leaf: WorkspaceLeaf) => Promise<AgentActionPreview>
  ): Promise<void> {
    try {
      await this.options.ensureConversationStoreReady();
      const leaf = this.resolveChatLeaf(targetLeaf);
      if (!leaf) {
        throw new Error(missingLeafMessage);
      }

      const preview = await buildPreview(leaf);
      new AgentActionPreviewModal(this.options.controller, preview).open();
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成动作预览失败。";
      new Notice(message, 4000);
    }
  }
}
