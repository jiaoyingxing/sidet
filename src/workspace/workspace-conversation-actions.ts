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
import { WorkspaceLeafNavigation } from "./workspace-leaf-navigation";
import type { WorkspaceController } from "./workspace-controller";

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
}

export class WorkspaceConversationActions {
  constructor(private readonly options: WorkspaceConversationActionsOptions) {}

  async openCreateDraftNotePreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.openAssistantPreview(
      targetLeaf,
      "当前没有可保存的 Sidet 对话。",
      (leaf) => this.options.agentActionPreview.buildCreateNoteFromLatestAssistant(
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

  async buildWebpageAttachment(
    url: string,
    options?: { timeoutMs?: number }
  ): Promise<WebpageMessageAttachment> {
    return this.options.webpageContext.buildWebpageAttachment(url, options);
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
