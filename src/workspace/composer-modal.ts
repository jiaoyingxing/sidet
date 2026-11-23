import { Modal, WorkspaceLeaf } from "obsidian";
import { createSendButtonControl, type SendButtonControl } from "./send-button";
import { WorkspaceController } from "./workspace-controller";

interface ComposerModalOptions {
  onSend: () => Promise<boolean>;
  canSend: () => boolean;
  onAfterClose: () => void;
}

let composerModalOriginCounter = 0;

export class ComposerModal extends Modal {
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeViewState: (() => void) | null = null;
  private textareaEl: HTMLTextAreaElement | null = null;
  private textareaMirrorEl: HTMLDivElement | null = null;
  private sendButton: SendButtonControl | null = null;
  private localDraft = "";
  private readonly draftOrigin = `composer-modal-${++composerModalOriginCounter}`;

  constructor(
    private readonly controller: WorkspaceController,
    private readonly leaf: WorkspaceLeaf,
    private readonly options: ComposerModalOptions
  ) {
    super(controller.getApp());
  }

  override onOpen(): void {
    this.containerEl.addClass("sidet-composer-modal-container");
    this.modalEl.addClass("sidet-composer-modal");
    this.titleEl.setText("展开输入");

    const body = this.contentEl.createDiv({ cls: "sidet-composer-modal-body" });
    const textareaWrap = body.createDiv({ cls: "sidet-composer-modal-textarea-wrap" });
    this.textareaEl = textareaWrap.createEl("textarea", { cls: "sidet-composer-modal-textarea" });
    this.textareaMirrorEl = textareaWrap.createDiv({ cls: "sidet-composer-modal-textarea-mirror" });
    this.textareaMirrorEl.setAttr("aria-hidden", "true");
    this.textareaEl.placeholder = this.getPlaceholder();
    this.textareaEl.readOnly = this.controller.isLeafConversationArchived(this.leaf);
    this.textareaEl.setAttribute("aria-readonly", this.textareaEl.readOnly ? "true" : "false");
    this.localDraft = this.controller.getLeafViewState(this.leaf).composerDraft;
    this.textareaEl.value = this.localDraft;
    this.syncTextareaLayout();
    this.textareaEl.addEventListener("input", () => {
      this.localDraft = this.textareaEl?.value ?? "";
      this.controller.setComposerDraft(this.leaf, this.localDraft, {
        origin: this.draftOrigin,
        suppressEchoToOrigin: true
      });
      this.syncTextareaLayout();
      this.syncButtons();
    });
    this.textareaEl.addEventListener("blur", () => {
      this.commitDraft({ immediate: true });
    });
    this.textareaEl.addEventListener("keydown", (event) => {
      if (event.isComposing) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void this.handleSend();
      }
    });

    const footer = body.createDiv({ cls: "sidet-composer-modal-footer" });
    footer.createDiv({
      cls: "sidet-composer-modal-hint",
      text: "与当前草稿实时同步"
    });

    const actions = footer.createDiv({ cls: "sidet-composer-modal-actions" });
    this.sendButton = createSendButtonControl(actions, {
      onClick: () => {
        void this.handleSend();
      }
    });

    this.unsubscribeStore = this.controller.store.subscribe(() => this.syncButtons());
    this.unsubscribeViewState = this.controller.subscribeLeafViewState(this.leaf, () => this.syncFromViewState());
    this.syncFromViewState();
    this.syncButtons();
    window.setTimeout(() => {
      this.textareaEl?.focus();
      const length = this.textareaEl?.value.length ?? 0;
      this.textareaEl?.setSelectionRange(length, length);
    }, 0);
  }

  override onClose(): void {
    this.commitDraft({ immediate: true });
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribeViewState?.();
    this.unsubscribeViewState = null;
    this.textareaEl = null;
    this.textareaMirrorEl = null;
    this.sendButton = null;
    this.contentEl.empty();
    this.options.onAfterClose();
  }

  private syncFromViewState(): void {
    const viewState = this.controller.getLeafViewState(this.leaf);
    const shouldSuppressEcho =
      viewState.suppressEchoToOrigin && viewState.draftOrigin === this.draftOrigin;

    if (!shouldSuppressEcho && this.localDraft !== viewState.composerDraft) {
      this.localDraft = viewState.composerDraft;
      if (this.textareaEl && this.textareaEl.value !== this.localDraft) {
        this.textareaEl.value = this.localDraft;
      }
      this.syncTextareaLayout();
    }

    if (this.textareaEl) {
      const isReadOnly = this.controller.isLeafConversationArchived(this.leaf);
      this.textareaEl.readOnly = isReadOnly;
      this.textareaEl.setAttribute("aria-readonly", isReadOnly ? "true" : "false");
      this.textareaEl.placeholder = this.getPlaceholder();
    }
    this.syncButtons();
  }

  private syncButtons(): void {
    if (!this.sendButton) {
      return;
    }
    const isStreaming = this.controller.isLeafStreaming(this.leaf);
    this.sendButton.setState({
      disabled: this.controller.isLeafConversationArchived(this.leaf) || (!isStreaming && !this.options.canSend()),
      streaming: isStreaming
    });
  }

  private syncTextareaLayout(): void {
    if (!this.textareaEl || !this.textareaMirrorEl) {
      return;
    }

    this.textareaMirrorEl.textContent = this.localDraft.length > 0 ? `${this.localDraft}\n` : " \n";
    const nextHeight = Math.ceil(this.textareaMirrorEl.getBoundingClientRect().height);
    this.textareaEl.style.height = `${Math.max(260, nextHeight)}px`;
  }

  private commitDraft(options: { immediate: boolean }): void {
    this.controller.setComposerDraft(this.leaf, this.localDraft, {
      origin: this.draftOrigin,
      suppressEchoToOrigin: false,
      immediatePersistence: options.immediate
    });
  }

  private async handleSend(): Promise<void> {
    if (this.controller.isLeafConversationArchived(this.leaf)) {
      this.controller.showSendError(new Error("已归档对话需先恢复后才能继续发送。"));
      return;
    }
    if (this.controller.isLeafStreaming(this.leaf)) {
      this.controller.stopStreamingForLeaf(this.leaf);
      this.syncButtons();
      return;
    }

    const didSend = await this.options.onSend();
    if (didSend) {
      this.localDraft = this.controller.getLeafViewState(this.leaf).composerDraft;
      this.close();
    }
  }

  private getPlaceholder(): string {
    return this.controller.isLeafConversationArchived(this.leaf)
      ? "已归档对话，恢复后才能继续发送"
      : "继续输入";
  }
}
