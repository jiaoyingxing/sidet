import { Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type { WebUrlMatch } from "../context/webpage-context";
import type { MessageAttachment, WebpageMessageAttachment } from "../types";
import {
  renderDraftAttachmentStrip,
  type DraftLeadingChip
} from "./chat-attachment-rendering";
import { openChatContextMenu, openWebpageAttachmentModal } from "./chat-context-menu";
import { createIconButton } from "./icon-button";
import {
  createHiddenImageInput,
  createImageAttachmentFromFile,
  createImageAttachmentFromPath,
  pickDesktopImagePath
} from "./image-attachment-file";
import { WebpageAttachmentPreviewModal } from "./webpage-attachment-preview-modal";
import type { WorkspaceController } from "./workspace-controller";

interface DraftMutationOptions {
  syncController?: boolean;
  suppressEchoToOrigin?: boolean;
  immediatePersistence?: boolean;
}

export interface AddWebpageAttachmentOptions {
  draftSnapshot?: string;
  matchedUrl?: WebUrlMatch;
  textareaEl?: HTMLTextAreaElement | null;
}

interface ChatViewContextIntakeOptions {
  controller: WorkspaceController;
  leaf: WorkspaceLeaf;
  getContentEl: () => HTMLElement;
  getAttachmentStripEl: () => HTMLDivElement | null;
  getLocalDraft: () => string;
  setLocalDraft: (draft: string, options?: DraftMutationOptions) => void;
  getPreferredComposerTextarea: () => HTMLTextAreaElement | null;
  focusComposerTextarea: (textareaEl: HTMLTextAreaElement | null) => void;
  holdMobileComposerForAttachmentPicker: (durationMs?: number) => void;
  restoreComposerFocusAfterAttachment: () => void;
  syncComposerButtons: () => void;
  closeOtherMenus: () => void;
  isEditingDraftActive: () => boolean;
  cancelEditingMessage: (options: { focusComposer: boolean }) => void;
  removeSelectedLinkText: (match: WebUrlMatch, draftSnapshot: string) => string;
  openModelMenu: (anchorEl: HTMLElement) => void;
  getAdditionalLeadingChips?: () => DraftLeadingChip[];
}

export class ChatViewContextIntake {
  private contextMenuClose: (() => void) | null = null;
  private contextMenuAnchorEl: HTMLElement | null = null;
  private draftAttachments: MessageAttachment[] = [];
  private imageInputEl: HTMLInputElement | null = null;
  private readonly pendingWebpageUrls = new Set<string>();

  constructor(private readonly options: ChatViewContextIntakeOptions) {}

  release(): void {
    this.closeContextMenu();
    this.imageInputEl?.remove();
    this.imageInputEl = null;
  }

  getDraftAttachments(): MessageAttachment[] {
    return this.draftAttachments;
  }

  setDraftAttachments(attachments: MessageAttachment[]): void {
    this.draftAttachments = attachments;
  }

  clearDraftAttachments(): void {
    if (this.draftAttachments.length === 0) {
      return;
    }
    this.draftAttachments = [];
    this.syncDraftAttachmentChips();
    this.options.syncComposerButtons();
  }

  clearDraftWebpageAttachments(): void {
    const nextAttachments = this.draftAttachments.filter(
      (attachment) => attachment.type !== "webpage"
    );
    if (nextAttachments.length === this.draftAttachments.length) {
      return;
    }
    this.draftAttachments = nextAttachments;
    this.syncDraftAttachmentChips();
    this.options.syncComposerButtons();
  }

  closeContextMenu(): void {
    this.contextMenuClose?.();
    this.contextMenuClose = null;
    this.contextMenuAnchorEl = null;
  }

  ensureImageInputReady(): void {
    this.ensureImageInput();
  }

  createContextButton(parent: HTMLElement): HTMLButtonElement {
    return createIconButton(parent, {
      icon: "plus",
      label: "添加上下文",
      preserveFocus: true,
      onClick: (event) => {
        event.stopPropagation();
        this.openContextMenu(event.currentTarget as HTMLElement);
      }
    });
  }

  openWebpageAttachmentPreview(attachment: WebpageMessageAttachment): void {
    new WebpageAttachmentPreviewModal(this.options.controller, attachment).open();
  }

  openWebpageAttachmentPicker(): void {
    openWebpageAttachmentModal({
      controller: this.options.controller,
      onAddWebpageAttachment: (url) => {
        void this.addWebpageAttachmentFromUrl(url);
      },
      onHoldAttachmentPicker: () => {
        this.options.holdMobileComposerForAttachmentPicker();
      },
      onCancelAttachmentPicker: () => {
        this.options.holdMobileComposerForAttachmentPicker(300);
        this.options.restoreComposerFocusAfterAttachment();
      }
    });
  }

  syncDraftAttachmentChips(): void {
    const leadingChips = this.buildLeadingChips();
    this.renderDraftAttachmentStrip(this.options.getAttachmentStripEl(), leadingChips);
  }

  async addMarkdownAttachment(file: TFile): Promise<void> {
    try {
      const attachment = await this.options.controller.buildMarkdownFileAttachment(file);
      this.draftAttachments = [
        ...this.draftAttachments.filter((item) => item.type !== "markdown" || item.path !== attachment.path),
        attachment
      ];
      this.clearWebSearchSelectionForExplicitContext();
      this.syncDraftAttachmentChips();
      this.options.syncComposerButtons();
      this.options.restoreComposerFocusAfterAttachment();
    } catch (error) {
      const message = error instanceof Error ? error.message : "引用笔记失败。";
      new Notice(message, 3600);
    }
  }

  async addWebpageAttachmentFromUrl(url: string, options: AddWebpageAttachmentOptions = {}): Promise<void> {
    if (this.pendingWebpageUrls.has(url)) {
      new Notice("正在抓取这个网页，请稍等。", 2200);
      return;
    }

    this.pendingWebpageUrls.add(url);
    const loadingNotice = new Notice("正在抓取网页…", 0);
    try {
      const attachment = await this.options.controller.buildWebpageAttachment(url);
      if (options.matchedUrl && options.draftSnapshot !== undefined) {
        const nextDraft = this.options.removeSelectedLinkText(options.matchedUrl, options.draftSnapshot);
        if (nextDraft !== this.options.getLocalDraft()) {
          this.options.setLocalDraft(nextDraft, {
            syncController: !this.options.isEditingDraftActive(),
            suppressEchoToOrigin: true
          });
        }
      }
      this.draftAttachments = [
        ...this.draftAttachments.filter((item) => item.type !== "webpage" || item.url !== attachment.url),
        attachment
      ];
      this.clearWebSearchSelectionForExplicitContext();
      this.syncDraftAttachmentChips();
      this.options.syncComposerButtons();
      const targetTextarea = options.textareaEl ?? this.options.getPreferredComposerTextarea();
      this.options.focusComposerTextarea(targetTextarea);
      this.options.restoreComposerFocusAfterAttachment();
    } catch (error) {
      const message = error instanceof Error ? error.message : "引用网页失败。";
      new Notice(message, 3600);
    } finally {
      loadingNotice.hide();
      this.pendingWebpageUrls.delete(url);
    }
  }

  private openContextMenu(anchorEl: HTMLElement): void {
    if (this.contextMenuClose && this.contextMenuAnchorEl === anchorEl) {
      this.closeContextMenu();
      return;
    }

    this.options.closeOtherMenus();
    const handle = openChatContextMenu({
      anchorEl,
      controller: this.options.controller,
      leaf: this.options.leaf,
      onAddMarkdownAttachment: (file) => {
        void this.addMarkdownAttachment(file);
      },
      onAddWebpageAttachment: (url) => {
        void this.addWebpageAttachmentFromUrl(url);
      },
      onPickImageAttachment: () => {
        this.pickImageAttachment();
      },
      onHoldAttachmentPicker: () => {
        this.options.holdMobileComposerForAttachmentPicker();
      },
      onCancelAttachmentPicker: () => {
        this.options.holdMobileComposerForAttachmentPicker(300);
        this.options.restoreComposerFocusAfterAttachment();
      },
      onClose: () => {
        this.contextMenuClose = null;
        this.contextMenuAnchorEl = null;
      }
    });
    this.contextMenuAnchorEl = anchorEl;
    this.contextMenuClose = () => handle.close();
  }

  private pickImageAttachment(): void {
    if (!this.options.controller.currentModelSupportsImageInput(this.options.leaf)) {
      new Notice("当前模型不支持图片输入。", 2600);
      return;
    }
    this.options.holdMobileComposerForAttachmentPicker();
    if (this.pickImageAttachmentWithNativeDialog()) {
      return;
    }

    const inputEl = this.ensureImageInput();
    inputEl.value = "";
    inputEl.click();
  }

  private pickImageAttachmentWithNativeDialog(): boolean {
    const selection = pickDesktopImagePath();
    if (!selection.handled) {
      return false;
    }
    if (selection.filePath) {
      void this.addImageAttachmentFromPath(selection.filePath);
    }
    return true;
  }

  private ensureImageInput(): HTMLInputElement {
    if (this.imageInputEl?.isConnected) {
      return this.imageInputEl;
    }

    const inputEl = createHiddenImageInput(
      this.options.getContentEl(),
      (file) => {
        void this.addImageAttachment(file);
      },
      () => {
        this.options.restoreComposerFocusAfterAttachment();
      }
    );
    this.imageInputEl = inputEl;
    return inputEl;
  }

  private async addImageAttachment(file: File): Promise<void> {
    try {
      const attachment = await createImageAttachmentFromFile(file);
      this.draftAttachments = [
        ...this.draftAttachments.filter((item) => item.type !== "image"),
        attachment
      ];
      this.clearWebSearchSelectionForExplicitContext();
      this.syncDraftAttachmentChips();
      this.options.syncComposerButtons();
      this.options.restoreComposerFocusAfterAttachment();
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取图片失败。";
      new Notice(message, 3600);
    }
  }

  private async addImageAttachmentFromPath(filePath: string): Promise<void> {
    try {
      const attachment = await createImageAttachmentFromPath(filePath);
      this.draftAttachments = [
        ...this.draftAttachments.filter((item) => item.type !== "image"),
        attachment
      ];
      this.clearWebSearchSelectionForExplicitContext();
      this.syncDraftAttachmentChips();
      this.options.syncComposerButtons();
      this.options.restoreComposerFocusAfterAttachment();
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取图片失败。";
      new Notice(message, 3600);
    }
  }

  private removeDraftAttachment(attachmentId: string): void {
    this.draftAttachments = this.draftAttachments.filter((attachment) => attachment.id !== attachmentId);
    this.syncDraftAttachmentChips();
    this.options.syncComposerButtons();
  }

  private clearWebSearchSelectionForExplicitContext(): void {
    if (!this.options.controller.getLeafViewState(this.options.leaf).webSearchEnabled) {
      return;
    }
    this.options.controller.setWebSearchEnabled(this.options.leaf, false);
  }

  private buildLeadingChips(): DraftLeadingChip[] {
    const leadingChips: DraftLeadingChip[] = [];

    if (this.options.controller.getLeafViewState(this.options.leaf).webSearchEnabled) {
      leadingChips.push({
        label: "联网搜索",
        icon: "globe",
        removeLabel: "取消联网搜索",
        tone: "default",
        onRemove: () => {
          this.options.controller.setWebSearchEnabled(this.options.leaf, false);
        },
        clickable: true,
        onClick: (anchorEl) => {
          this.options.openModelMenu(anchorEl);
        }
      });
    }

    leadingChips.push(...(this.options.getAdditionalLeadingChips?.() ?? []));

    if (this.options.isEditingDraftActive()) {
      leadingChips.push({
        label: "修改中",
        icon: "pencil",
        removeLabel: "取消修改",
        tone: "status",
        onRemove: () => {
          this.options.cancelEditingMessage({ focusComposer: true });
        }
      });
    }

    return leadingChips;
  }

  private renderDraftAttachmentStrip(
    stripEl: HTMLDivElement | null,
    leadingChips: DraftLeadingChip[]
  ): void {
    renderDraftAttachmentStrip(stripEl, this.draftAttachments, (attachmentId) => {
      this.removeDraftAttachment(attachmentId);
    }, {
      leadingChips,
      onOpenWebpageAttachment: (attachment) => {
        this.openWebpageAttachmentPreview(attachment);
      }
    });
  }
}
