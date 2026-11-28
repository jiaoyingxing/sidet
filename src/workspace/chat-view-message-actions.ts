import { Menu, Notice } from "obsidian";
import type {
  ConversationRecord,
  MessageAttachment,
  MessageRecord
} from "../types";
import { createIconButton } from "./icon-button";
import { showDesktopMenuAtAnchor, type DesktopMenuPlacement } from "./desktop-menu";
import { openInlineActionMenu, type InlineActionMenuHandle, type InlineActionMenuItem } from "./inline-action-menu";
import type { WorkspaceController } from "./workspace-controller";

export interface EditingMessageState {
  conversationId: string;
  messageId: string;
  originalDraft: string;
  originalAttachments: MessageAttachment[];
  originalWebSearchEnabled: boolean;
}

interface ChatViewMessageActionsOptions {
  controller: WorkspaceController;
  getLeafComposerDraft: () => string;
  setLocalDraft: (
    draft: string,
    options?: {
      syncController?: boolean;
      suppressEchoToOrigin?: boolean;
      immediatePersistence?: boolean;
    }
  ) => void;
  getDraftAttachments: () => MessageAttachment[];
  setDraftAttachments: (attachments: MessageAttachment[]) => void;
  syncDraftAttachmentChips: () => void;
  syncComposerButtons: () => void;
  renderConversation: () => void;
  scrollMessagesToBottom: (options?: { keepPinned?: boolean }) => void;
  focusActiveComposerTextarea: () => void;
  getPreferredComposerTextarea: () => HTMLTextAreaElement | null;
  scheduleViewportSync: () => void;
  isPhoneLayout: () => boolean;
  isMobileRuntime: () => boolean;
  closeOtherMenus: () => void;
  getCurrentWebSearchEnabled: () => boolean;
}

export class ChatViewMessageActions {
  private messageMenuClose: (() => void) | null = null;
  private messageMenuAnchorEl: HTMLElement | null = null;
  private editingMessageState: EditingMessageState | null = null;

  constructor(private readonly options: ChatViewMessageActionsOptions) {}

  closeMessageMenu(): void {
    this.messageMenuClose?.();
    this.messageMenuClose = null;
    this.messageMenuAnchorEl = null;
  }

  hasEditingMessageState(): boolean {
    return Boolean(this.editingMessageState);
  }

  getEditingMessageState(): EditingMessageState | null {
    return this.editingMessageState;
  }

  setEditingMessageState(state: EditingMessageState | null): void {
    this.editingMessageState = state;
  }

  isEditingDraftActive(): boolean {
    return this.hasEditingMessageState();
  }

  cancelEditingMessage(options: { focusComposer: boolean }): void {
    const editingState = this.editingMessageState;
    if (!editingState) {
      return;
    }
    this.editingMessageState = null;
    this.options.setDraftAttachments(cloneMessageAttachments(editingState.originalAttachments));
    this.options.setLocalDraft(editingState.originalDraft, {
      syncController: true,
      suppressEchoToOrigin: true,
      immediatePersistence: true
    });
    this.options.syncDraftAttachmentChips();
    this.options.renderConversation();
    if (options.focusComposer) {
      this.options.focusActiveComposerTextarea();
      this.options.scrollMessagesToBottom({ keepPinned: true });
    }
  }

  clearEditingMessageState(): void {
    if (!this.editingMessageState) {
      return;
    }
    this.editingMessageState = null;
    this.options.setDraftAttachments([]);
    this.options.syncDraftAttachmentChips();
    this.options.syncComposerButtons();
  }

  getEditingMessageIndex(conversation: ConversationRecord): number {
    if (!this.editingMessageState || this.editingMessageState.conversationId !== conversation.id) {
      return -1;
    }

    return conversation.messages.findIndex((message) => message.id === this.editingMessageState?.messageId);
  }

  shouldHideMessageForEditing(
    conversation: ConversationRecord,
    messageIndex: number,
    editingMessageIndex: number
  ): boolean {
    if (editingMessageIndex < 0 || messageIndex < editingMessageIndex) {
      return false;
    }

    const message = conversation.messages[messageIndex];
    if (messageIndex === editingMessageIndex) {
      return true;
    }
    if (message.role !== "assistant") {
      return false;
    }

    for (let index = editingMessageIndex + 1; index < messageIndex; index += 1) {
      if (conversation.messages[index].role === "user") {
        return false;
      }
    }
    return true;
  }

  isLatestUserMessage(conversation: ConversationRecord, message: MessageRecord): boolean {
    if (message.role !== "user") {
      return false;
    }

    const lastUserMessage = conversation.messages.slice().reverse().find((item) => item.role === "user");
    return Boolean(lastUserMessage && lastUserMessage.id === message.id);
  }

  renderUserMessageActions(
    parentEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ): void {
    if (this.options.isPhoneLayout() && this.options.isMobileRuntime()) {
      parentEl.addClass("is-mobile-message-menu-enabled");
      this.bindMobileMessageMenuLongPress(parentEl, conversation, message);
      return;
    }

    parentEl.addClass("has-message-actions");
    parentEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openMessageMenuAtPoint(parentEl.ownerDocument, event.clientX, event.clientY, conversation, message);
    });
    const actionsEl = parentEl.createDiv({ cls: "sidet-message-actions" });
    const moreButton = createIconButton(actionsEl, {
      icon: "more-horizontal",
      label: "更多消息操作",
      preserveFocus: true,
      onClick: (event) => {
        event.stopPropagation();
        this.openMessageMenu(event.currentTarget as HTMLElement, conversation, message);
      }
    });
    moreButton.classList.add("sidet-message-more-button");
  }

  async copyTextToClipboard(text: string): Promise<void> {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        new Notice("已复制", 1200);
        return;
      }
    } catch (error) {
      console.warn("Sidet：使用原生剪贴板复制失败，尝试降级。", error);
    }

    const textareaEl = createEl("textarea");
    textareaEl.value = text;
    textareaEl.setAttribute("readonly", "true");
    textareaEl.setCssProps({
      position: "fixed",
      left: "-9999px",
      top: "0",
      opacity: "0"
    });
    document.body.appendChild(textareaEl);
    textareaEl.select();
    const copied = document.execCommand("copy");
    textareaEl.remove();

    if (!copied) {
      throw new Error("复制失败");
    }
    new Notice("已复制", 1200);
  }

  private openMessageMenu(
    anchorEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ): void {
    if (!this.isLatestUserMessage(conversation, message)) {
      return;
    }

    if (this.messageMenuClose && this.messageMenuAnchorEl === anchorEl) {
      this.closeMessageMenu();
      return;
    }

    this.options.closeOtherMenus();
    this.closeMessageMenu();
    const items = this.buildMessageMenuItems(conversation, message);

    const handle = this.options.isMobileRuntime()
      ? openInlineActionMenu({
        anchorEl,
        items,
        onClose: () => {
          this.messageMenuClose = null;
          this.messageMenuAnchorEl = null;
        }
      })
      : openDesktopActionMenu(anchorEl, items, () => {
        this.messageMenuClose = null;
        this.messageMenuAnchorEl = null;
      }, "side-left");
    this.messageMenuAnchorEl = anchorEl;
    this.messageMenuClose = () => handle.close();
  }

  private openMessageMenuAtPoint(
    doc: Document,
    clientX: number,
    clientY: number,
    conversation: ConversationRecord,
    message: MessageRecord
  ): void {
    if (!this.isLatestUserMessage(conversation, message)) {
      return;
    }

    if (this.messageMenuClose) {
      this.closeMessageMenu();
    }

    this.options.closeOtherMenus();
    this.closeMessageMenu();
    const items = this.buildMessageMenuItems(conversation, message);

    const handle = openDesktopActionMenuAtPoint(clientX, clientY, items, () => {
      this.messageMenuClose = null;
      this.messageMenuAnchorEl = null;
    }, doc);
    this.messageMenuAnchorEl = null;
    this.messageMenuClose = () => handle.close();
  }

  private async deleteLastUserMessage(conversation: ConversationRecord, message: MessageRecord): Promise<void> {
    try {
      await this.options.controller.deleteLastUserMessage(conversation.id, message.id);
      this.options.renderConversation();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "删除消息失败。";
      new Notice(messageText, 3600);
    }
  }

  private async modifyLastUserMessage(conversation: ConversationRecord, message: MessageRecord): Promise<void> {
    if (conversation.isArchived) {
      new Notice("已归档对话需先恢复后才能继续修改消息。", 3600);
      return;
    }
    const draftText = message.text;
    const draftAttachments = cloneMessageAttachments(message.attachments);

    try {
      if (this.editingMessageState) {
        this.cancelEditingMessage({ focusComposer: false });
      }
      this.editingMessageState = {
        conversationId: conversation.id,
        messageId: message.id,
        originalDraft: this.options.getLeafComposerDraft(),
        originalAttachments: cloneMessageAttachments(this.options.getDraftAttachments()),
        originalWebSearchEnabled: this.options.getCurrentWebSearchEnabled()
      };
      this.options.setDraftAttachments(draftAttachments);
      this.options.syncDraftAttachmentChips();
      this.options.setLocalDraft(draftText, {
        syncController: false,
        suppressEchoToOrigin: true,
        immediatePersistence: true
      });
      this.options.renderConversation();
      this.options.focusActiveComposerTextarea();
      const textareaEl = this.options.getPreferredComposerTextarea();
      const length = textareaEl?.value.length ?? 0;
      textareaEl?.setSelectionRange(length, length);
      this.options.scheduleViewportSync();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "修改消息失败。";
      new Notice(messageText, 3600);
    }
  }

  private buildMessageMenuItems(
    conversation: ConversationRecord,
    message: MessageRecord
  ): InlineActionMenuItem[] {
    const items: InlineActionMenuItem[] = [];
    if (!conversation.isArchived) {
      items.push(
        {
          title: "修改",
          icon: "pencil",
          onSelect: () => {
            void this.modifyLastUserMessage(conversation, message);
          }
        },
        {
          title: "删除",
          icon: "trash-2",
          danger: true,
          onSelect: () => {
            void this.deleteLastUserMessage(conversation, message);
          }
        }
      );
    }

    items.splice(conversation.isArchived ? 0 : 1, 0, {
      title: "复制",
      icon: "copy",
      onSelect: () => {
        void this.copyTextToClipboard(message.text);
      }
    });

    return items;
  }

  private bindMobileMessageMenuLongPress(
    targetEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ): void {
    const interactiveSelector = [
      "button",
      "a",
      "input",
      "textarea",
      "select",
      "option",
      "[role='button']",
      "[contenteditable='true']"
    ].join(", ");

    let pressTimer: number | null = null;
    let pressPointerId: number | null = null;
    let pressStartX = 0;
    let pressStartY = 0;
    let pressActivated = false;

    const clearPressTimer = (): void => {
      if (pressTimer === null) {
        return;
      }
      window.clearTimeout(pressTimer);
      pressTimer = null;
    };

    const releasePointerCapture = (): void => {
      if (pressPointerId === null) {
        return;
      }
      if (targetEl.hasPointerCapture?.(pressPointerId)) {
        try {
          targetEl.releasePointerCapture(pressPointerId);
        } catch {
          // Ignore capture release failures on hostile WebViews.
        }
      }
      pressPointerId = null;
    };

    const cancelPress = (): void => {
      clearPressTimer();
      releasePointerCapture();
      pressActivated = false;
    };

    const triggerMenu = (): void => {
      if (pressActivated || !targetEl.isConnected) {
        return;
      }
      pressActivated = true;
      clearPressTimer();
      releasePointerCapture();
      navigator.vibrate?.(10);
      this.openMessageMenu(targetEl, conversation, message);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (!this.options.isPhoneLayout() || !this.options.isMobileRuntime()) {
        return;
      }
      if (event.pointerType !== "touch" || event.button !== 0) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest(interactiveSelector)) {
        return;
      }

      cancelPress();
      pressPointerId = event.pointerId;
      pressStartX = event.clientX;
      pressStartY = event.clientY;
      pressActivated = false;
      try {
        targetEl.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture failures.
      }
      pressTimer = window.setTimeout(triggerMenu, 520);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (pressPointerId !== event.pointerId || pressTimer === null) {
        return;
      }
      if (Math.abs(event.clientX - pressStartX) > 12 || Math.abs(event.clientY - pressStartY) > 12) {
        cancelPress();
      }
    };

    const onPointerUpOrCancel = (event: PointerEvent): void => {
      if (pressPointerId !== event.pointerId) {
        return;
      }
      cancelPress();
    };

    targetEl.addEventListener("pointerdown", onPointerDown);
    targetEl.addEventListener("pointermove", onPointerMove);
    targetEl.addEventListener("pointerup", onPointerUpOrCancel);
    targetEl.addEventListener("pointercancel", onPointerUpOrCancel);
    targetEl.addEventListener("lostpointercapture", onPointerUpOrCancel as EventListener);
  }
}

function openDesktopActionMenu(
  anchorEl: HTMLElement,
  items: InlineActionMenuItem[],
  onClose: () => void,
  placement: DesktopMenuPlacement = "align"
): InlineActionMenuHandle {
  const menu = new Menu();
  let hasAddedItem = false;
  for (const item of items) {
    if (item.sectionStart && hasAddedItem) {
      menu.addSeparator();
    }
    menu.addItem((menuItem) => {
      menuItem
        .setTitle(item.title)
        .setDisabled(Boolean(item.disabled))
        .onClick(item.onSelect);
      if (item.icon) {
        menuItem.setIcon(item.icon);
      }
      if (item.danger) {
        menuItem.setWarning(true);
      }
    });
    hasAddedItem = true;
  }
  return showDesktopMenuAtAnchor({
    menu,
    anchorEl,
    onClose,
    placement
  });
}

function openDesktopActionMenuAtPoint(
  clientX: number,
  clientY: number,
  items: InlineActionMenuItem[],
  onClose: () => void,
  doc: Document
): InlineActionMenuHandle {
  const menu = new Menu();
  let hasAddedItem = false;
  for (const item of items) {
    if (item.sectionStart && hasAddedItem) {
      menu.addSeparator();
    }
    menu.addItem((menuItem) => {
      menuItem
        .setTitle(item.title)
        .setDisabled(Boolean(item.disabled))
        .onClick(item.onSelect);
      if (item.icon) {
        menuItem.setIcon(item.icon);
      }
      if (item.danger) {
        menuItem.setWarning(true);
      }
    });
    hasAddedItem = true;
  }
  menu.showAtPosition({ x: clientX, y: clientY, overlap: false }, doc);
  let isClosed = false;
  const close = () => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    menu.close();
  };
  menu.onHide(() => {
    isClosed = true;
    onClose();
  });
  return {
    close,
    reposition: () => undefined
  };
}

function cloneMessageAttachments(attachments?: MessageAttachment[]): MessageAttachment[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}
