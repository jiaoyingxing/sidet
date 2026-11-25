import { Notice, type WorkspaceLeaf } from "obsidian";
import type { ChatLeafViewState, MessageAttachment } from "../types";
import type { EditingMessageState } from "./chat-view-message-actions";
import type { WorkspaceController } from "./workspace-controller";

export interface DraftMutationOptions {
  syncController?: boolean;
  suppressEchoToOrigin?: boolean;
  immediatePersistence?: boolean;
}

interface ChatViewDraftRuntimeOptions {
  controller: WorkspaceController;
  leaf: WorkspaceLeaf;
  getLocalDraft: () => string;
  setLocalDraftValue: (draft: string) => void;
  getDraftOrigin: () => string;
  getLastFocusComposerNonce: () => number;
  setLastFocusComposerNonce: (value: number) => void;
  getTextareaEl: () => HTMLTextAreaElement | null;
  getPreferredComposerTextarea: () => HTMLTextAreaElement | null;
  focusComposerTextarea: (textareaEl: HTMLTextAreaElement | null) => void;
  focusActiveComposerTextarea: () => void;
  scheduleViewportSync: () => void;
  syncComposerLayout: () => void;
  syncComposerButtons: () => void;
  getDraftAttachments: () => MessageAttachment[];
  clearDraftAttachments: () => void;
  setDraftAttachments: (attachments: MessageAttachment[]) => void;
  syncDraftAttachmentChips: () => void;
  addWebpageAttachmentFromUrl: (url: string) => Promise<void>;
  closeInlineSuggests: () => void;
  getEditingMessageState: () => EditingMessageState | null;
  hasEditingMessageState: () => boolean;
  setEditingMessageState: (state: EditingMessageState | null) => void;
  queueScrollIntent: (intent: "after-send" | "conversation-switch-or-initial-open") => void;
  clearPendingScrollIntent: () => void;
  getRequestContextPrefix?: () => string | null;
  showSendError: (error: unknown) => void;
}

export class ChatViewDraftRuntime {
  constructor(private readonly options: ChatViewDraftRuntimeOptions) {}

  getLocalDraft(): string {
    return this.options.getLocalDraft();
  }

  async handleSend(): Promise<boolean> {
    const draft = this.options.getLocalDraft();
    const attachments = [...this.options.getDraftAttachments()];
    const editingState = this.options.getEditingMessageState();
    if (this.options.controller.isLeafConversationArchived(this.options.leaf)) {
      this.options.showSendError(new Error("已归档对话需先恢复后才能继续发送。"));
      return false;
    }
    let replacementUiCommitted = false;
    const commitEditingReplacementUi = (): void => {
      if (!editingState || replacementUiCommitted) {
        return;
      }
      replacementUiCommitted = true;
      this.options.setEditingMessageState(null);
      this.options.syncDraftAttachmentChips();
      this.options.syncComposerButtons();
    };
    if (!draft.trim() && attachments.length === 0) {
      return false;
    }
    if (
      attachments.some((attachment) => attachment.type === "image")
      && !this.options.controller.currentModelSupportsImageInput(this.options.leaf)
    ) {
      new Notice("当前模型不支持图片输入，请先切换到支持图片的模型。", 3600);
      return false;
    }

    if (
      !editingState
      && this.options.controller.tryHandleConversationKnowledgeCommandFromChat(
        this.options.leaf,
        draft,
        attachments,
        {
          onSubmitStart: () => {
            this.options.closeInlineSuggests();
            this.options.queueScrollIntent("after-send");
            this.setLocalDraft("", {
              syncController: true,
              suppressEchoToOrigin: false,
              immediatePersistence: true
            });
            this.options.clearDraftAttachments();
          },
          onSubmitError: () => {
            this.options.clearPendingScrollIntent();
            this.setLocalDraft(draft, {
              syncController: true,
              suppressEchoToOrigin: false,
              immediatePersistence: true
            });
          }
        }
      )
    ) {
      return true;
    }

    try {
      this.options.closeInlineSuggests();
      this.options.queueScrollIntent("after-send");
      this.setLocalDraft("", {
        syncController: true,
        suppressEchoToOrigin: false,
        immediatePersistence: true
      });
      this.options.clearDraftAttachments();
      await this.options.controller.sendMessageFromLeaf(this.options.leaf, draft, attachments, {
        requestContextPrefix: this.options.getRequestContextPrefix?.() ?? null,
        replaceFromMessageId: editingState?.messageId ?? null,
        selectedKnowledgeBaseIndexPathOverride: editingState?.originalKnowledgeBaseIndexPath,
        webSearchEnabledOverride: editingState?.originalWebSearchEnabled,
        onReplacementCommit: () => {
          commitEditingReplacementUi();
        }
      });
      commitEditingReplacementUi();
      // 发送完成（含整段流式回复结束）后不再主动聚焦 composer。
      // 回复后的焦点回填会在移动端重新拉起键盘，打断阅读。
      return true;
    } catch (error) {
      this.options.clearPendingScrollIntent();
      if (!replacementUiCommitted) {
        this.options.setEditingMessageState(editingState);
        this.setLocalDraft(draft, {
          syncController: !editingState,
          suppressEchoToOrigin: false,
          immediatePersistence: true
        });
        this.options.setDraftAttachments(attachments);
        this.options.syncDraftAttachmentChips();
        this.options.syncComposerButtons();
      }
      this.options.showSendError(error);
      return false;
    }
  }

  renderViewState(): void {
    const viewState = this.options.controller.getLeafViewState(this.options.leaf);
    const shouldSuppressEcho =
      viewState.suppressEchoToOrigin && viewState.draftOrigin === this.options.getDraftOrigin();

    if (
      !this.options.hasEditingMessageState()
      && !shouldSuppressEcho
      && viewState.composerDraft !== this.options.getLocalDraft()
    ) {
      this.setLocalDraft(viewState.composerDraft);
    } else {
      this.options.syncComposerButtons();
    }

    if (viewState.focusComposerNonce !== this.options.getLastFocusComposerNonce()) {
      this.options.setLastFocusComposerNonce(viewState.focusComposerNonce);
      const textareaEl = this.options.getPreferredComposerTextarea();
      this.options.focusComposerTextarea(textareaEl);
      const length = textareaEl?.value.length ?? 0;
      textareaEl?.setSelectionRange(length, length);
      this.options.scheduleViewportSync();
    }

    this.handleExternalImportRequest(viewState);
  }

  setLocalDraft(draft: string, options: DraftMutationOptions = {}): void {
    this.options.setLocalDraftValue(draft);
    const textareaEl = this.options.getTextareaEl();
    if (textareaEl && textareaEl.value !== draft) {
      textareaEl.value = draft;
    }
    this.options.syncComposerLayout();
    this.options.syncComposerButtons();

    if (options.syncController) {
      this.options.controller.setComposerDraft(this.options.leaf, draft, {
        origin: this.options.getDraftOrigin(),
        suppressEchoToOrigin: options.suppressEchoToOrigin,
        immediatePersistence: options.immediatePersistence
      });
    }
  }

  commitDraft(options: { immediatePersistence: boolean }): void {
    if (this.options.hasEditingMessageState()) {
      return;
    }
    this.options.controller.setComposerDraft(this.options.leaf, this.options.getLocalDraft(), {
      origin: this.options.getDraftOrigin(),
      suppressEchoToOrigin: false,
      immediatePersistence: options.immediatePersistence
    });
  }

  private handleExternalImportRequest(viewState: ChatLeafViewState): void {
    const request = viewState.externalImportRequest;
    if (!request) {
      return;
    }

    this.options.controller.clearExternalImportRequest(this.options.leaf);
    if (request.kind === "url" && request.url) {
      void this.options.addWebpageAttachmentFromUrl(request.url);
      if (request.focusComposer !== false) {
        this.options.focusActiveComposerTextarea();
      }
      return;
    }

    if (request.kind === "text" && request.text !== undefined) {
      const nextDraft = request.append && this.options.getLocalDraft().trim().length > 0
        ? `${request.text}\n\n${this.options.getLocalDraft()}`
        : request.text;
      this.setLocalDraft(nextDraft, {
        syncController: true,
        suppressEchoToOrigin: false,
        immediatePersistence: true
      });
      if (request.focusComposer !== false) {
        this.options.focusActiveComposerTextarea();
      }
    }
  }
}
