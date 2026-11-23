import { Component, type WorkspaceLeaf } from "obsidian";
import { stripSidetToolActionBlock } from "../agent/actions/agent-tool-protocol";
import { stripSidetProtocolBlocks } from "../agent/web-search/sidet-protocol";
import type {
  ConversationRecord,
  MessageRecord,
  WebpageMessageAttachment
} from "../types";
import { renderMessageAttachments } from "./chat-attachment-rendering";
import { renderMessageKnowledgeBaseRouting } from "./chat-message-knowledge-base-routing";
import { recordChatScrollTrace } from "./chat-scroll-trace";
import type { ChatViewAssistantRendering } from "./chat-view-assistant-rendering";
import type { ChatViewMessageActions } from "./chat-view-message-actions";
import type { WorkspaceController } from "./workspace-controller";

interface ScrollSnapshot {
  conversationId: string | null;
  scrollTop: number;
  pinnedToBottom: boolean;
}

export type ChatViewScrollIntent = "none" | "after-send" | "conversation-switch-or-initial-open";

interface ChatViewConversationRuntimeOptions {
  controller: WorkspaceController;
  leaf: WorkspaceLeaf;
  assistantRendering: ChatViewAssistantRendering;
  messageActions: ChatViewMessageActions;
  getMessagesListEl: () => HTMLDivElement | null;
  addChild: (component: Component) => void;
  trackMessageRenderComponent: (component: Component) => void;
  resetMessageRenderComponents: () => void;
  renderAssistantMetaBlocks: (
    parentEl: HTMLDivElement,
    contentEl: HTMLDivElement,
    message: MessageRecord
  ) => void;
  shouldRenderAssistantMessageMarkdown: (message: MessageRecord) => boolean;
  setPlainMessageContent: (contentEl: HTMLDivElement, text: string) => void;
  renderInlineToolAction: (
    parentEl: HTMLDivElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ) => void;
  renderWikiMaintenancePlanAction: (
    parentEl: HTMLDivElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ) => void;
  openWebpageAttachmentPreview: (attachment: WebpageMessageAttachment) => void;
  syncComposerButtons: () => void;
  syncLeafHeader: () => void;
  syncScrollAffordances: () => void;
  getScrollHost: () => HTMLElement;
  getScrollPinnedToBottom: () => boolean;
  setScrollHostTop: (scrollTop: number) => void;
  setScrollPinnedToBottom: (value: boolean) => void;
  closeInlineSuggests: () => void;
  cancelComposerScrollRestore: () => void;
  renderHome: (parentEl: HTMLElement) => HTMLDivElement;
  setHomeComposerSlot: (slotEl: HTMLDivElement | null) => void;
}

export class ChatViewConversationRuntime {
  private hasConversationMessages = false;
  private pendingScrollIntent: ChatViewScrollIntent = "none";
  private lastConversationId: string | null = null;
  private lastMessageRevision: string | null = null;
  private lastKnowledgeBaseRoutingRevision: string | null = null;
  private lastRenderedMessageCount = 0;
  private markdownRenderGeneration = 0;

  constructor(private readonly options: ChatViewConversationRuntimeOptions) {}

  release(): void {
    this.markdownRenderGeneration += 1;
    this.hasConversationMessages = false;
    this.pendingScrollIntent = "none";
    this.lastConversationId = null;
    this.lastMessageRevision = null;
    this.lastKnowledgeBaseRoutingRevision = null;
    this.lastRenderedMessageCount = 0;
  }

  getLastConversationId(): string | null {
    return this.lastConversationId;
  }

  getLastRenderedMessageCount(): number {
    return this.lastRenderedMessageCount;
  }

  getPendingScrollIntent(): ChatViewScrollIntent {
    return this.pendingScrollIntent;
  }

  getMarkdownRenderGeneration(): number {
    return this.markdownRenderGeneration;
  }

  hasConversationMessagesRendered(): boolean {
    return this.hasConversationMessages;
  }

  setLastRenderedMessageCount(count: number): void {
    this.lastRenderedMessageCount = count;
  }

  setLastMessageRevision(revision: string | null): void {
    this.lastMessageRevision = revision;
  }

  clearPendingScrollIntent(): void {
    this.pendingScrollIntent = "none";
  }

  queueScrollIntent(intent: Exclude<ChatViewScrollIntent, "none">): void {
    this.pendingScrollIntent = intent;
    this.options.cancelComposerScrollRestore();
  }

  buildMessageRevision(conversation: ConversationRecord | null): string | null {
    if (!conversation) {
      return null;
    }
    if (conversation.messages.length === 0) {
      return `${conversation.id}:empty`;
    }

    const lastMessage = conversation.messages[conversation.messages.length - 1];
    const knowledgeBaseRoutingRevision = this.buildKnowledgeBaseRoutingRevision(conversation)
      ?? "no-knowledge-base-routing";
    return [
      conversation.id,
      conversation.messages.length,
      lastMessage.id,
      lastMessage.status,
      lastMessage.text.length,
      lastMessage.reasoningText?.length ?? 0,
      lastMessage.metaPanels?.reduce((total, panel) => {
        return total + (panel.text?.length ?? 0) + (panel.sources?.length ?? 0);
      }, 0) ?? 0,
      knowledgeBaseRoutingRevision
    ].join(":");
  }

  buildKnowledgeBaseRoutingRevision(conversation: ConversationRecord | null): string | null {
    if (!conversation) {
      return null;
    }
    let latestKnowledgeBaseRouting: MessageRecord["knowledgeBaseRouting"];
    let latestKnowledgeBaseRoutingMessageId: string | null = null;
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index];
      if (message.role === "user" && message.knowledgeBaseRouting) {
        latestKnowledgeBaseRouting = message.knowledgeBaseRouting;
        latestKnowledgeBaseRoutingMessageId = message.id;
        break;
      }
    }
    if (!latestKnowledgeBaseRouting || !latestKnowledgeBaseRoutingMessageId) {
      return "no-knowledge-base-routing";
    }
    return [
      latestKnowledgeBaseRoutingMessageId,
      latestKnowledgeBaseRouting.mode,
      latestKnowledgeBaseRouting.displayName,
      latestKnowledgeBaseRouting.status ?? "complete",
      latestKnowledgeBaseRouting.resultCount,
      latestKnowledgeBaseRouting.hits
        .map((hit) => `${hit.path}|${hit.basename}|${hit.kindLabel}`)
        .join(",")
    ].join(":");
  }

  renderConversation(): void {
    this.options.assistantRendering.release();
    const leafState = this.options.controller.getChatLeafState(this.options.leaf);
    const shouldWaitForConversationRestore =
      Boolean(leafState.conversationId) && !this.options.controller.isConversationStoreReady();
    const conversation = shouldWaitForConversationRestore
      ? null
      : leafState.conversationId
        ? this.options.controller.store.getConversation(leafState.conversationId)
        : null;
    const currentConversationId = conversation?.id ?? null;
    const isConversationChanged = currentConversationId !== this.lastConversationId;
    if (
      isConversationChanged &&
      this.options.messageActions.hasEditingMessageState() &&
      this.options.messageActions.getEditingMessageState()?.conversationId !== currentConversationId
    ) {
      this.options.messageActions.clearEditingMessageState();
    }
    const messageRevision = this.buildMessageRevision(conversation);
    const knowledgeBaseRoutingRevision = this.buildKnowledgeBaseRoutingRevision(conversation);
    const renderGeneration = ++this.markdownRenderGeneration;
    if (isConversationChanged && currentConversationId) {
      this.queueScrollIntent("conversation-switch-or-initial-open");
    }
    const scrollSnapshot = this.captureScrollSnapshot(currentConversationId);

    const messagesListEl = this.options.getMessagesListEl();
    if (!messagesListEl) {
      return;
    }

    this.options.resetMessageRenderComponents();
    this.options.setHomeComposerSlot(null);
    messagesListEl.empty();

    if (!leafState.conversationId) {
      const composerSlotEl = this.options.renderHome(messagesListEl);
      this.options.setHomeComposerSlot(composerSlotEl);
      this.applyNonMessageState(null, null);
      this.syncConversationChrome();
      return;
    }

    if (shouldWaitForConversationRestore) {
      this.renderEmptyState("正在恢复这条对话…");
      return;
    }

    if (!conversation) {
      this.renderEmptyState("这条对话当前不可用。");
      return;
    }

    if (conversation.messages.length === 0) {
      this.renderEmptyState("这个对话还是空的。发第一条消息开始。", {
        conversationId: currentConversationId,
        messageRevision
      });
      return;
    }

    this.hasConversationMessages = true;
    this.lastRenderedMessageCount = conversation.messages.length;

    const editingMessageIndex = this.options.messageActions.getEditingMessageIndex(conversation);
    let pendingKnowledgeBaseRouting: MessageRecord["knowledgeBaseRouting"];
    for (let messageIndex = 0; messageIndex < conversation.messages.length; messageIndex += 1) {
      if (this.options.messageActions.shouldHideMessageForEditing(conversation, messageIndex, editingMessageIndex)) {
        continue;
      }
      const message = conversation.messages[messageIndex];
      const item = messagesListEl.createDiv({
        cls: `sidet-message ${message.role === "user" ? "-user" : "-assistant"}${message.status === "error" ? " -error" : ""}`
      });
      const messageSurface = message.role === "user"
        ? item.createDiv({ cls: "sidet-message-bubble" })
        : item;
      const contentSurface = message.role === "user"
        ? messageSurface.createDiv({ cls: "sidet-message-bubble-surface" })
        : messageSurface;
      const content = contentSurface.createDiv({ cls: "sidet-message-content" });
      const displayText = message.role === "assistant"
        ? stripSidetToolActionBlock(stripSidetProtocolBlocks(message.text))
        : message.text;
      this.options.renderAssistantMetaBlocks(messageSurface, content, message);
      if (message.status === "streaming") {
        if (displayText?.trim()) {
          content.removeClass("is-pending-reply");
          content.removeClass("-plain");
          content.addClass("markdown-rendered");
          content.setText(displayText);
        } else {
          this.options.assistantRendering.setPendingAssistantPlaceholder(content);
        }
      } else if (this.options.shouldRenderAssistantMessageMarkdown(message)) {
        const renderComponent = new Component();
        this.options.addChild(renderComponent);
        this.options.trackMessageRenderComponent(renderComponent);
        void this.options.assistantRendering.renderAssistantMarkdown(content, displayText ?? "", renderComponent, {
          conversationId: conversation.id,
          renderGeneration,
          managedScrollRestore: true
        });
      } else {
        content.removeClass("is-pending-reply");
        this.options.setPlainMessageContent(content, displayText || " ");
      }
      renderMessageAttachments(contentSurface, message, {
        onOpenWebpageAttachment: (attachment) => {
          this.options.openWebpageAttachmentPreview(attachment);
        }
      });
      if (message.role === "assistant") {
        if (pendingKnowledgeBaseRouting) {
          renderMessageKnowledgeBaseRouting(contentSurface, pendingKnowledgeBaseRouting, {
            controller: this.options.controller
          });
          pendingKnowledgeBaseRouting = undefined;
        }
      } else {
        pendingKnowledgeBaseRouting = message.knowledgeBaseRouting;
      }
      if (this.options.messageActions.isLatestUserMessage(conversation, message)) {
        this.options.messageActions.renderUserMessageActions(messageSurface, conversation, message);
      }
      this.options.renderWikiMaintenancePlanAction(item, conversation, message);
      this.options.renderInlineToolAction(item, conversation, message);
    }

    this.lastKnowledgeBaseRoutingRevision = knowledgeBaseRoutingRevision;
    this.restoreMessageScroll(scrollSnapshot, currentConversationId, messageRevision);
    this.syncConversationChrome();
  }

  handleLeafStateChange(): void {
    const leafConversationId = this.options.controller.getChatLeafState(this.options.leaf).conversationId;
    if (leafConversationId !== this.lastConversationId) {
      this.options.closeInlineSuggests();
      this.renderConversation();
    }
  }

  handleStoreChange(): void {
    const leafState = this.options.controller.getChatLeafState(this.options.leaf);
    const conversation = leafState.conversationId
      ? this.options.controller.store.getConversation(leafState.conversationId)
      : null;
    const currentConversationId = conversation?.id ?? null;
    const nextMessageRevision = this.buildMessageRevision(conversation);
    const nextKnowledgeBaseRoutingRevision = this.buildKnowledgeBaseRoutingRevision(conversation);
    const knowledgeBaseRoutingChanged =
      currentConversationId === this.lastConversationId &&
      nextKnowledgeBaseRoutingRevision !== this.lastKnowledgeBaseRoutingRevision;
    if (
      currentConversationId === this.lastConversationId &&
      nextMessageRevision === this.lastMessageRevision
    ) {
      this.options.syncLeafHeader();
      this.options.syncComposerButtons();
      return;
    }
    if (
      !knowledgeBaseRoutingChanged &&
      currentConversationId === this.lastConversationId &&
      conversation &&
      this.options.assistantRendering.canPatchLatestAssistantMessage(conversation) &&
      this.options.assistantRendering.patchLatestAssistantMessage()
    ) {
      return;
    }
    this.renderConversation();
  }

  handleAssistantChunkEvent(event: {
    conversationId: string;
    messageId: string;
    segment: "content" | "reasoning" | "meta";
    text: string;
  }): void {
    const leafState = this.options.controller.getChatLeafState(this.options.leaf);
    if (leafState.conversationId !== event.conversationId) {
      return;
    }

    const conversation = this.options.controller.store.getConversation(event.conversationId);
    const lastMessage = conversation?.messages[conversation.messages.length - 1] ?? null;
    if (!conversation || lastMessage?.id !== event.messageId || lastMessage.status !== "streaming") {
      return;
    }

    if (this.options.assistantRendering.canPatchLatestAssistantMessage(conversation)) {
      this.options.assistantRendering.scheduleStreamingMessagePatch();
      return;
    }

    this.renderConversation();
  }

  private renderEmptyState(
    messageText: string,
    state: { conversationId?: string | null; messageRevision?: string | null } = {}
  ): void {
    const messagesListEl = this.options.getMessagesListEl();
    if (!messagesListEl) {
      return;
    }

    const empty = messagesListEl.createDiv({ cls: "sidet-empty" });
    empty.setText(messageText);
    this.applyNonMessageState(state.conversationId ?? null, state.messageRevision ?? null);
    this.syncConversationChrome();
  }

  private applyNonMessageState(conversationId: string | null, messageRevision: string | null): void {
    this.hasConversationMessages = false;
    this.lastRenderedMessageCount = 0;
    this.lastConversationId = conversationId;
    this.lastMessageRevision = messageRevision;
    this.lastKnowledgeBaseRoutingRevision = null;
    this.pendingScrollIntent = "none";
    this.options.setScrollPinnedToBottom(true);
  }

  private syncConversationChrome(): void {
    this.options.syncComposerButtons();
    this.options.syncLeafHeader();
    this.options.syncScrollAffordances();
  }

  private captureScrollSnapshot(conversationId: string | null): ScrollSnapshot | null {
    const scrollHost = this.options.getScrollHost();
    recordChatScrollTrace("capture-scroll-snapshot", {
      conversationId,
      scrollTop: scrollHost.scrollTop,
      pinnedToBottom: this.options.getScrollPinnedToBottom()
    });
    return {
      conversationId,
      scrollTop: scrollHost.scrollTop,
      pinnedToBottom: this.options.getScrollPinnedToBottom()
    };
  }

  private restoreMessageScroll(
    snapshot: ScrollSnapshot | null,
    conversationId: string | null,
    messageRevision: string | null
  ): void {
    const nextState = this.options.assistantRendering.restoreMessageScroll(
      snapshot,
      conversationId,
      messageRevision,
      {
        lastConversationId: this.lastConversationId,
        lastMessageRevision: this.lastMessageRevision,
        pendingScrollIntent: this.pendingScrollIntent
      },
      {
        clearPendingScrollIntent: () => {
          this.pendingScrollIntent = "none";
        }
      }
    );
    this.lastConversationId = nextState.lastConversationId;
    this.lastMessageRevision = nextState.lastMessageRevision;
  }
}
