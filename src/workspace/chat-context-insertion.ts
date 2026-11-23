import { Notice, TFile, WorkspaceLeaf } from "obsidian";
import { CHAT_VIEW_TYPE } from "../constants";
import type { ActiveContextService } from "../context/active-context";
import type { VaultAgentService } from "../agent/vault-agent";
import type { ContextDraftResult } from "../agent/context-bundle";
import type { ConversationRecord } from "../types";

interface ChatContextInsertionOptions {
  activeContext: ActiveContextService;
  vaultAgent: VaultAgentService;
  resolveDraftTargetLeaf: (targetLeaf?: WorkspaceLeaf) => Promise<WorkspaceLeaf>;
  mergeContextIntoComposerDraft: (leaf: WorkspaceLeaf, result: { block: string; draft: string }) => boolean;
  getConversationForLeaf: (leaf: WorkspaceLeaf) => ConversationRecord | null;
  getNavigationChatLeaf: () => WorkspaceLeaf | null;
}

export class ChatContextInsertionService {
  constructor(private readonly options: ChatContextInsertionOptions) {}

  async insertCurrentNoteIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.insertDraft(
      () => this.options.activeContext.buildCurrentNoteDraft(),
      targetLeaf,
      (result) => result.truncated ? "已插入当前笔记（已截断）。" : "已插入当前笔记。"
    );
  }

  async insertCurrentSelectionIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.insertDraft(
      () => Promise.resolve(this.options.activeContext.buildCurrentSelectionDraft()),
      targetLeaf,
      (result) => result.truncated ? "已插入当前选区（已截断）。" : "已插入当前选区。"
    );
  }

  async insertMarkdownFileIntoDraft(file: TFile, targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.insertDraft(
      () => this.options.activeContext.buildMarkdownFileDraft(file),
      targetLeaf
    );
  }

  async insertMemoryCandidatePromptIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    try {
      const leaf = targetLeaf && targetLeaf.getViewState().type === CHAT_VIEW_TYPE
        ? targetLeaf
        : this.options.getNavigationChatLeaf();
      if (!leaf) {
        throw new Error("当前没有可生成记忆候选的 Sidet 对话。");
      }

      const conversation = this.options.getConversationForLeaf(leaf);
      if (!conversation) {
        throw new Error("当前标签页还没有对话可提炼。");
      }

      const result = this.options.vaultAgent.buildMemoryCandidateDraft(conversation);
      this.options.mergeContextIntoComposerDraft(leaf, result);
      new Notice(result.truncated ? "已生成记忆候选草稿（已截断）。" : "已生成记忆候选草稿。", 2600);
    } catch (error) {
      this.showContextError(error);
    }
  }

  async insertDraftNotePreviewPromptIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    try {
      const leaf = targetLeaf && targetLeaf.getViewState().type === CHAT_VIEW_TYPE
        ? targetLeaf
        : this.options.getNavigationChatLeaf();
      if (!leaf) {
        throw new Error("当前没有可生成草稿笔记的 Sidet 对话。");
      }

      const conversation = this.options.getConversationForLeaf(leaf);
      if (!conversation) {
        throw new Error("当前标签页还没有对话可整理。");
      }

      const result = this.options.vaultAgent.buildDraftNotePreviewDraft(conversation);
      this.options.mergeContextIntoComposerDraft(leaf, result);
      new Notice("已生成草稿笔记预览提示。", 2600);
    } catch (error) {
      this.showContextError(error);
    }
  }

  private async insertDraft(
    buildDraft: () => Promise<ContextDraftResult>,
    targetLeaf?: WorkspaceLeaf,
    noticeText?: (result: ContextDraftResult) => string
  ): Promise<void> {
    try {
      const result = await buildDraft();
      const leaf = await this.options.resolveDraftTargetLeaf(targetLeaf);
      this.options.mergeContextIntoComposerDraft(leaf, result);
      if (noticeText) {
        new Notice(noticeText(result), 2600);
      }
    } catch (error) {
      this.showContextError(error);
    }
  }

  private showContextError(error: unknown): void {
    const message = error instanceof Error ? error.message : "带入当前内容失败。";
    new Notice(message, 4000);
  }
}
