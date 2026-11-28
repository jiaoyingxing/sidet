import { Component, type WorkspaceLeaf } from "obsidian";
import type {
  ConversationRecord,
  MessageRecord,
  WebpageMessageAttachment
} from "../types";
import { findAssistantMessageContent } from "./assistant-message-dom";
import { renderMessageAttachments } from "./chat-attachment-rendering";
import { getAssistantDisplayText } from "./assistant-process-events";
import { computeMessageRevealScrollTop } from "./chat-view-layout-metrics";
import { shouldDeferMessageMarkdown } from "./chat-view-render-policy";
import {
  buildVirtualMessageHeightSignature,
  estimateVirtualMessageHeight,
  resolveVirtualMountRange,
  shouldUnmountVirtualItem,
  type VirtualMessageRect
} from "./chat-view-virtual-window";
import { renderMessageKnowledgeBaseRouting } from "./chat-message-knowledge-base-routing";
import { recordChatRenderTrace } from "./chat-view-render-trace";
import { recordChatScrollTrace } from "./chat-scroll-trace";
import type { ChatViewAssistantRendering } from "./chat-view-assistant-rendering";
import type { ChatViewMessageActions } from "./chat-view-message-actions";
import type { WorkspaceController } from "./workspace-controller";

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

interface ScrollSnapshot {
  conversationId: string | null;
  scrollTop: number;
  pinnedToBottom: boolean;
  anchorMessageId: string | null;
  anchorOffset: number | null;
}

export type ChatViewScrollIntent =
  | "none"
  | "after-send"
  | "conversation-switch-or-initial-open"
  | "reveal-message";

interface VirtualMessageItem {
  messageId: string;
  messageIndex: number;
  itemEl: HTMLDivElement;
  mounted: boolean;
}

interface ChatViewConversationRuntimeOptions {
  controller: WorkspaceController;
  leaf: WorkspaceLeaf;
  assistantRendering: ChatViewAssistantRendering;
  messageActions: ChatViewMessageActions;
  getMessagesListEl: () => HTMLDivElement | null;
  addChild: (component: Component) => void;
  trackMessageRenderComponent: (component: Component) => void;
  unloadMessageRenderComponents: (components: Component[]) => void;
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
  renderAnswerSources: (parentEl: HTMLDivElement, message: MessageRecord) => void;
  renderAnswerActions: (
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
  highlightMessage: (messageId: string) => void;
  renderHome: (parentEl: HTMLElement) => HTMLDivElement;
  setHomeComposerSlot: (slotEl: HTMLDivElement | null) => void;
}

export class ChatViewConversationRuntime {
  private static readonly DEFERRED_MARKDOWN_ROOT_MARGIN = "1200px 0px";
  private static readonly DEFERRED_MARKDOWN_CONCURRENCY = 2;
  private static readonly VIRTUAL_INITIAL_TAIL_COUNT = 18;
  private static readonly VIRTUAL_INITIAL_MOUNT_LIMIT = 24;
  private static readonly VIRTUAL_REVEAL_MOUNT_RADIUS = 3;

  private hasConversationMessages = false;
  private pendingScrollIntent: ChatViewScrollIntent = "none";
  private pendingRevealMessageId: string | null = null;
  private revealAlignmentObserver: ResizeObserver | null = null;
  private revealAlignmentTimer: number | null = null;
  private deferredMarkdownObserver: IntersectionObserver | null = null;
  private readonly deferredMarkdownItems = new Map<HTMLDivElement, string>();
  private readonly hydratingDeferredMessageIds = new Set<string>();
  private readonly deferredHydrationQueue: Array<{
    itemEl: HTMLDivElement;
    messageId: string;
    conversationId: string;
    renderGeneration: number;
  }> = [];
  private readonly queuedDeferredItems = new Set<HTMLDivElement>();
  private deferredHydrationActive = 0;
  private lastConversationId: string | null = null;
  private lastMessageRevision: string | null = null;
  private lastOtherMessagesRevision: string | null = null;
  private lastFullRenderKey: string | null = null;
  private lastKnowledgeBaseRoutingRevision: string | null = null;
  private lastRenderedMessageCount = 0;
  private markdownRenderGeneration = 0;
  private virtualConversationId: string | null = null;
  private virtualItems: VirtualMessageItem[] = [];
  private readonly virtualHeightCache = new Map<string, {
    signature: string;
    height: number;
  }>();
  private readonly virtualItemComponents = new Map<HTMLDivElement, Component[]>();
  private readonly directMarkdownPromises = new Map<HTMLDivElement, Promise<void>>();
  private virtualWindowFrame: number | null = null;
  private revealForceHydrateUntilMs = 0;
  private snapshotAnchorForceHydrateUntilMs = 0;

  constructor(private readonly options: ChatViewConversationRuntimeOptions) {}

  release(): void {
    this.markdownRenderGeneration += 1;
    this.hasConversationMessages = false;
    this.pendingScrollIntent = "none";
    this.pendingRevealMessageId = null;
    this.clearRevealAlignment();
    this.clearDeferredMarkdownRender();
    this.clearVirtualWindow();
    this.lastConversationId = null;
    this.lastMessageRevision = null;
    this.lastOtherMessagesRevision = null;
    this.lastFullRenderKey = null;
    this.lastKnowledgeBaseRoutingRevision = null;
    this.lastRenderedMessageCount = 0;
    this.revealForceHydrateUntilMs = 0;
    this.snapshotAnchorForceHydrateUntilMs = 0;
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

  /** 一次性定位到指定消息；已在当前会话时直接滚动，否则交给下一次渲染。 */
  revealMessage(messageId: string): void {
    const conversationId = this.options.controller.getChatLeafState(this.options.leaf).conversationId;
    const conversation = conversationId
      ? this.options.controller.store.getConversation(conversationId)
      : null;
    if (!conversation?.messages.some((message) => message.id === messageId)) {
      return;
    }
    if (!conversationId) {
      return;
    }

    this.pendingRevealMessageId = messageId;
    this.revealForceHydrateUntilMs = Date.now() + 1500;
    if (conversationId !== this.lastConversationId) {
      return;
    }

    const itemEl = this.findMessageItem(messageId);
    const itemPosition = this.virtualItems.findIndex((entry) => entry.messageId === messageId);
    const finishReveal = (): void => {
      if (this.pendingRevealMessageId !== messageId) {
        return;
      }
      window.requestAnimationFrame(() => {
        if (this.pendingRevealMessageId === messageId) {
          this.pendingRevealMessageId = null;
        }
        this.applyMessageReveal(messageId);
      });
    };
    if (itemEl && itemPosition >= 0 && !this.virtualItems[itemPosition].mounted) {
      // 消息壳在、内容被虚拟窗口卸载：挂载目标及邻近消息并强制水合 Markdown。
      // 定位窗口内不再走延迟水合，避免异步撑高把刚对齐的目标推走。
      this.revealForceHydrateUntilMs = Date.now() + 1500;
      const startPosition = Math.max(
        0,
        itemPosition - ChatViewConversationRuntime.VIRTUAL_REVEAL_MOUNT_RADIUS
      );
      const endPosition = Math.min(
        this.virtualItems.length - 1,
        itemPosition + ChatViewConversationRuntime.VIRTUAL_REVEAL_MOUNT_RADIUS
      );
      let mountPromise: Promise<void> | null = null;
      for (let position = startPosition; position <= endPosition; position += 1) {
        const nextPromise = this.mountVirtualItem(position, { forceHydrate: true });
        if (position === itemPosition) {
          mountPromise = nextPromise;
        }
      }
      if (mountPromise) {
        void mountPromise.then(finishReveal, finishReveal);
      } else {
        finishReveal();
      }
      return;
    }
    if (itemEl && this.deferredMarkdownItems.has(itemEl)) {
      void this.hydrateDeferredMarkdown(
        itemEl,
        messageId,
        conversationId,
        this.markdownRenderGeneration
      ).then(finishReveal, finishReveal);
      return;
    }
    if (itemEl) {
      finishReveal();
      return;
    }
    this.renderConversation();
  }

  /** 滚动或程序化跳转后刷新窗口；可在一个事件内重复调用。 */
  handleVirtualScroll(): void {
    this.scheduleVirtualWindowUpdate();
  }

  /** 贴底 / 回到底部前先挂载尾部，避免先滚到空白占位再补内容。 */
  ensureVirtualWindowAtBottom(): void {
    if (this.virtualItems.length === 0) {
      return;
    }
    const startIndex = Math.max(
      0,
      this.virtualItems.length - ChatViewConversationRuntime.VIRTUAL_INITIAL_TAIL_COUNT
    );
    let mountedAny = false;
    for (let index = startIndex; index < this.virtualItems.length; index += 1) {
      const entry = this.virtualItems[index];
      if (!entry.mounted) {
        void this.mountVirtualItem(index);
        mountedAny = true;
      }
    }
    if (mountedAny && this.options.getScrollPinnedToBottom()) {
      const hostEl = this.options.getScrollHost();
      this.options.setScrollHostTop(
        Math.max(0, hostEl.scrollHeight - hostEl.clientHeight)
      );
      this.options.syncScrollAffordances();
    }
  }

  private applyMessageReveal(messageId: string): void {
    this.clearRevealAlignment();
    const initialScrollTop = this.alignMessageReveal(messageId);
    if (initialScrollTop === null) {
      this.options.syncScrollAffordances();
      return;
    }
    this.options.setScrollPinnedToBottom(false);
    this.options.syncScrollAffordances();
    this.options.highlightMessage(messageId);

    // 长对话里更早消息的 Markdown 仍在异步撑高列表；在有限窗口内跟随列表尺寸
    // 校正，用户一旦自己滚动就停止。
    const hostEl = this.options.getScrollHost();
    let expectedScrollTop = initialScrollTop;
    const deadline = Date.now() + 1200;
    const align = (): boolean => {
      if (Date.now() > deadline || Math.abs(hostEl.scrollTop - expectedScrollTop) > 4) {
        return false;
      }
      const nextScrollTop = this.alignMessageReveal(messageId);
      if (nextScrollTop === null) {
        return false;
      }
      expectedScrollTop = nextScrollTop;
      return true;
    };

    if (typeof ResizeObserver !== "undefined") {
      const listEl = this.options.getMessagesListEl();
      if (listEl) {
        const observer = new ResizeObserver(() => {
          if (!align()) {
            this.clearRevealAlignment();
          }
        });
        observer.observe(listEl);
        this.revealAlignmentObserver = observer;
      }
    }

    const tick = (): void => {
      this.revealAlignmentTimer = null;
      if (!align()) {
        this.clearRevealAlignment();
        return;
      }
      this.revealAlignmentTimer = window.setTimeout(tick, 160);
    };
    this.revealAlignmentTimer = window.setTimeout(tick, 160);
  }

  private clearRevealAlignment(): void {
    this.revealAlignmentObserver?.disconnect();
    this.revealAlignmentObserver = null;
    if (this.revealAlignmentTimer !== null) {
      window.clearTimeout(this.revealAlignmentTimer);
      this.revealAlignmentTimer = null;
    }
  }

  private alignMessageReveal(messageId: string): number | null {
    const itemEl = this.findMessageItem(messageId);
    if (!itemEl) {
      return null;
    }
    const hostEl = this.options.getScrollHost();
    const hostRect = hostEl.getBoundingClientRect();
    const itemRect = itemEl.getBoundingClientRect();
    const nextScrollTop = computeMessageRevealScrollTop({
      hostScrollTop: hostEl.scrollTop,
      hostTop: hostRect.top,
      itemTop: itemRect.top
    });
    this.options.setScrollHostTop(nextScrollTop);
    return nextScrollTop;
  }

  private findMessageItem(messageId: string): HTMLDivElement | null {
    return this.options.getMessagesListEl()?.querySelector<HTMLDivElement>(
      `.sidet-message[data-message-id="${messageId}"]`
    ) ?? null;
  }

  private deferMessageMarkdown(
    itemEl: HTMLDivElement,
    contentEl: HTMLDivElement,
    displayText: string
  ): void {
    const messageId = itemEl.getAttribute("data-message-id");
    if (!messageId) {
      return;
    }
    contentEl.removeClass("is-pending-reply");
    contentEl.addClass("is-deferred-markdown");
    this.options.setPlainMessageContent(contentEl, displayText || " ");
    this.deferredMarkdownItems.set(itemEl, messageId);
    this.deferredMarkdownObserver?.observe(itemEl);
  }

  private releaseDeferredMarkdownItem(itemEl: HTMLDivElement): void {
    if (!this.deferredMarkdownItems.has(itemEl)) {
      return;
    }
    this.deferredMarkdownItems.delete(itemEl);
    this.deferredMarkdownObserver?.unobserve(itemEl);
    this.queuedDeferredItems.delete(itemEl);
    for (let index = this.deferredHydrationQueue.length - 1; index >= 0; index -= 1) {
      if (this.deferredHydrationQueue[index].itemEl === itemEl) {
        this.deferredHydrationQueue.splice(index, 1);
      }
    }
  }

  private ensureDeferredMarkdownObserver(): void {
    if (
      this.deferredMarkdownObserver
      || this.deferredMarkdownItems.size === 0
      || !this.lastConversationId
      || this.lastConversationId !== this.virtualConversationId
    ) {
      return;
    }
    this.setupDeferredMarkdownObserver(this.lastConversationId, this.markdownRenderGeneration);
  }

  private setupDeferredMarkdownObserver(
    conversationId: string,
    renderGeneration: number
  ): void {
    // 同会话整页重绘会再次进入这里；旧 observer 不 disconnect 会继续观察
    // 已移除 / 仍在的节点，每次重绘泄漏一个。
    this.deferredMarkdownObserver?.disconnect();
    this.deferredMarkdownObserver = null;
    if (this.deferredMarkdownItems.size === 0 || typeof IntersectionObserver === "undefined") {
      return;
    }
    const root = this.options.getScrollHost();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        const itemEl = entry.target;
        if (!itemEl.instanceOf(HTMLDivElement)) {
          continue;
        }
        const messageId = this.deferredMarkdownItems.get(itemEl);
        if (!messageId) {
          continue;
        }
        this.enqueueDeferredMarkdown(itemEl, messageId, conversationId, renderGeneration);
      }
    }, {
      root,
      rootMargin: ChatViewConversationRuntime.DEFERRED_MARKDOWN_ROOT_MARGIN
    });
    for (const itemEl of this.deferredMarkdownItems.keys()) {
      observer.observe(itemEl);
    }
    this.deferredMarkdownObserver = observer;
    recordChatRenderTrace("deferred-markdown-registered", {
      conversationId,
      count: this.deferredMarkdownItems.size
    });
  }

  private enqueueDeferredMarkdown(
    itemEl: HTMLDivElement,
    messageId: string,
    conversationId: string,
    renderGeneration: number
  ): void {
    if (this.queuedDeferredItems.has(itemEl) || this.hydratingDeferredMessageIds.has(messageId)) {
      return;
    }
    this.queuedDeferredItems.add(itemEl);
    this.deferredHydrationQueue.push({ itemEl, messageId, conversationId, renderGeneration });
    this.drainDeferredHydrationQueue();
  }

  private drainDeferredHydrationQueue(): void {
    while (
      this.deferredHydrationActive < ChatViewConversationRuntime.DEFERRED_MARKDOWN_CONCURRENCY
      && this.deferredHydrationQueue.length > 0
    ) {
      const next = this.deferredHydrationQueue.shift();
      if (!next) {
        return;
      }
      this.queuedDeferredItems.delete(next.itemEl);
      this.deferredHydrationActive += 1;
      void this.hydrateDeferredMarkdown(
        next.itemEl,
        next.messageId,
        next.conversationId,
        next.renderGeneration
      ).finally(() => {
        this.deferredHydrationActive -= 1;
        this.drainDeferredHydrationQueue();
      });
    }
  }

  private async hydrateDeferredMarkdown(
    itemEl: HTMLDivElement,
    messageId: string,
    conversationId: string,
    renderGeneration: number
  ): Promise<void> {
    if (this.hydratingDeferredMessageIds.has(messageId) || !this.deferredMarkdownItems.has(itemEl)) {
      return;
    }
    this.hydratingDeferredMessageIds.add(messageId);

    const conversation = this.options.controller.store.getConversation(conversationId);
    const message = conversation?.messages.find((candidate) => candidate.id === messageId);
    const contentEl = findAssistantMessageContent(itemEl);
    if (
      !conversation
      || !message
      || !contentEl?.instanceOf(HTMLDivElement)
      || !this.options.shouldRenderAssistantMessageMarkdown(message)
    ) {
      this.deferredMarkdownItems.delete(itemEl);
      this.deferredMarkdownObserver?.unobserve(itemEl);
      this.hydratingDeferredMessageIds.delete(messageId);
      return;
    }

    const hostEl = this.options.getScrollHost();
    const scrollTopBefore = hostEl.scrollTop;
    const scrollHeightBefore = hostEl.scrollHeight;
    const hostRect = hostEl.getBoundingClientRect();
    const itemRect = itemEl.getBoundingClientRect();
    const wasAboveViewport = itemRect.bottom < hostRect.top;
    const displayText = getAssistantDisplayText(message);
    const hydrateStartedAt = nowMs();

    const renderComponent = this.createMessageRenderComponent(itemEl);
    contentEl.removeClass("is-deferred-markdown");
    const hydratePromise = this.options.assistantRendering.renderAssistantMarkdown(
      contentEl,
      displayText,
      renderComponent,
      {
        conversationId,
        renderGeneration,
        messageId,
        managedScrollRestore: true,
        sources: message.sources
      }
    );
    this.directMarkdownPromises.set(itemEl, hydratePromise);
    try {
      await hydratePromise;
    } finally {
      if (this.directMarkdownPromises.get(itemEl) === hydratePromise) {
        this.directMarkdownPromises.delete(itemEl);
      }
    }

    this.deferredMarkdownItems.delete(itemEl);
    this.deferredMarkdownObserver?.unobserve(itemEl);
    this.hydratingDeferredMessageIds.delete(messageId);
    if (!itemEl.isConnected) {
      return;
    }

    if (this.options.getScrollPinnedToBottom()) {
      this.options.setScrollHostTop(Math.max(0, hostEl.scrollHeight - hostEl.clientHeight));
    } else if (wasAboveViewport && Math.abs(hostEl.scrollTop - scrollTopBefore) <= 2) {
      const delta = hostEl.scrollHeight - scrollHeightBefore;
      if (delta !== 0) {
        this.options.setScrollHostTop(scrollTopBefore + delta);
      }
    }
    this.options.syncScrollAffordances();
    recordChatRenderTrace("deferred-markdown-hydrated", {
      messageId,
      durationMs: Math.round((nowMs() - hydrateStartedAt) * 10) / 10,
      wasAboveViewport,
      delta: hostEl.scrollHeight - scrollHeightBefore
    });
  }

  private clearDeferredMarkdownRender(): void {
    this.deferredMarkdownObserver?.disconnect();
    this.deferredMarkdownObserver = null;
    this.deferredMarkdownItems.clear();
    this.hydratingDeferredMessageIds.clear();
    this.deferredHydrationQueue.length = 0;
    this.queuedDeferredItems.clear();
  }

  private createMessageRenderComponent(itemEl: HTMLDivElement): Component {
    const component = new Component();
    this.options.addChild(component);
    this.options.trackMessageRenderComponent(component);
    const components = this.virtualItemComponents.get(itemEl);
    if (components) {
      components.push(component);
    } else {
      this.virtualItemComponents.set(itemEl, [component]);
    }
    return component;
  }

  private resetVirtualItems(conversationId: string | null): void {
    if (this.virtualWindowFrame !== null) {
      window.cancelAnimationFrame(this.virtualWindowFrame);
      this.virtualWindowFrame = null;
    }
    if (this.virtualConversationId !== conversationId) {
      this.virtualHeightCache.clear();
    }
    this.virtualConversationId = conversationId;
    this.virtualItems = [];
    this.virtualItemComponents.clear();
    this.directMarkdownPromises.clear();
  }

  private clearVirtualWindow(): void {
    this.resetVirtualItems(null);
  }

  private cacheVirtualHeights(conversation: ConversationRecord | null): void {
    if (!conversation || conversation.id !== this.virtualConversationId) {
      return;
    }
    for (const entry of this.virtualItems) {
      if (!entry.mounted) {
        continue;
      }
      const message = conversation.messages[entry.messageIndex];
      if (!message || message.id !== entry.messageId) {
        continue;
      }
      const height = Math.round(entry.itemEl.getBoundingClientRect().height);
      if (height <= 0) {
        continue;
      }
      this.virtualHeightCache.set(entry.messageId, {
        signature: buildVirtualMessageHeightSignature(message),
        height
      });
    }
    if (this.virtualHeightCache.size > 4000) {
      const oldestKey = this.virtualHeightCache.keys().next().value;
      if (oldestKey) {
        this.virtualHeightCache.delete(oldestKey);
      }
    }
  }

  private resolveVirtualMessageHeight(message: MessageRecord): number {
    const cached = this.virtualHeightCache.get(message.id);
    if (cached?.signature === buildVirtualMessageHeightSignature(message)) {
      return cached.height;
    }
    return estimateVirtualMessageHeight(message);
  }

  private applyVirtualPlaceholder(
    entry: VirtualMessageItem,
    message: MessageRecord
  ): void {
    entry.itemEl.addClass("is-virtual-placeholder");
    entry.itemEl.style.height = `${this.resolveVirtualMessageHeight(message)}px`;
  }

  private mountVirtualItem(
    itemPosition: number,
    options: { forceHydrate?: boolean; forceDeferMarkdown?: boolean } = {}
  ): Promise<void> | null {
    const entry = this.virtualItems[itemPosition];
    const conversationId = this.virtualConversationId;
    if (!entry || entry.mounted || !conversationId) {
      return null;
    }
    const conversation = this.options.controller.store.getConversation(conversationId);
    const message = conversation?.messages[entry.messageIndex];
    if (!conversation || !message || message.id !== entry.messageId) {
      return null;
    }

    entry.mounted = true;
    entry.itemEl.removeClass("is-virtual-placeholder");
    entry.itemEl.style.removeProperty("height");
    const renderPromise = this.renderMessageItem(
      entry.itemEl,
      conversation,
      message,
      entry.messageIndex,
      {
        renderGeneration: this.markdownRenderGeneration,
        forceHydrate: options.forceHydrate ?? false,
        forceDeferMarkdown: options.forceDeferMarkdown ?? false
      }
    );
    if (renderPromise) {
      this.directMarkdownPromises.set(entry.itemEl, renderPromise);
      void renderPromise.finally(() => {
        if (this.directMarkdownPromises.get(entry.itemEl) === renderPromise) {
          this.directMarkdownPromises.delete(entry.itemEl);
        }
      });
    }
    this.ensureDeferredMarkdownObserver();
    return renderPromise;
  }

  private unmountVirtualItem(itemPosition: number): boolean {
    const entry = this.virtualItems[itemPosition];
    if (!entry?.mounted) {
      return false;
    }
    if (
      this.pendingRevealMessageId === entry.messageId
      || this.directMarkdownPromises.has(entry.itemEl)
      || this.hydratingDeferredMessageIds.has(entry.messageId)
      || entry.itemEl.contains(document.activeElement)
      || entry.itemEl.querySelector("details[open]")
    ) {
      return false;
    }

    const conversation = this.virtualConversationId
      ? this.options.controller.store.getConversation(this.virtualConversationId)
      : null;
    const message = conversation?.messages[entry.messageIndex];
    if (!conversation || !message || message.id !== entry.messageId) {
      return false;
    }

    const height = Math.round(entry.itemEl.getBoundingClientRect().height);
    if (height > 0) {
      this.virtualHeightCache.set(entry.messageId, {
        signature: buildVirtualMessageHeightSignature(message),
        height
      });
    }
    this.releaseDeferredMarkdownItem(entry.itemEl);
    entry.itemEl.empty();
    this.applyVirtualPlaceholder(entry, message);
    const components = this.virtualItemComponents.get(entry.itemEl);
    if (components) {
      this.virtualItemComponents.delete(entry.itemEl);
      this.options.unloadMessageRenderComponents(components);
    }
    entry.mounted = false;
    return true;
  }

  private scheduleVirtualWindowUpdate(): void {
    if (this.virtualWindowFrame !== null) {
      return;
    }
    this.virtualWindowFrame = window.requestAnimationFrame(() => {
      this.virtualWindowFrame = null;
      this.updateVirtualWindow();
    });
  }

  private updateVirtualWindow(): void {
    if (this.virtualItems.length === 0 || !this.virtualConversationId) {
      return;
    }
    const conversationId = this.options.controller.getChatLeafState(this.options.leaf).conversationId;
    const conversation = conversationId
      ? this.options.controller.store.getConversation(conversationId)
      : null;
    if (!conversation || conversation.id !== this.virtualConversationId) {
      return;
    }
    const hostEl = this.options.getScrollHost();
    const listEl = this.options.getMessagesListEl();
    if (!hostEl || !listEl) {
      return;
    }

    const hostRect = hostEl.getBoundingClientRect();
    const viewportTop = hostRect.top;
    const viewportBottom = hostRect.bottom;
    const rects: VirtualMessageRect[] = this.virtualItems.map((entry, index) => {
      const rect = entry.itemEl.getBoundingClientRect();
      return { index, top: rect.top, bottom: rect.bottom };
    });
    const mountRange = resolveVirtualMountRange({ rects, viewportTop, viewportBottom });
    const mountPositions = new Set<number>();
    if (mountRange) {
      for (let index = mountRange.startIndex; index <= mountRange.endIndex; index += 1) {
        mountPositions.add(index);
      }
    }

    const lastPosition = this.virtualItems.length - 1;
    mountPositions.add(lastPosition);
    const revealPosition = this.pendingRevealMessageId
      ? this.virtualItems.findIndex((entry) => entry.messageId === this.pendingRevealMessageId)
      : -1;
    if (revealPosition >= 0) {
      mountPositions.add(revealPosition);
    }
    for (let index = 0; index < this.virtualItems.length; index += 1) {
      const message = conversation.messages[this.virtualItems[index].messageIndex];
      if (message?.status === "streaming") {
        mountPositions.add(index);
      }
    }

    const wasPinnedToBottom = this.options.getScrollPinnedToBottom();
    let anchor: { index: number; top: number } | null = null;
    if (!wasPinnedToBottom) {
      for (const rect of rects) {
        if (
          this.virtualItems[rect.index].mounted
          && rect.bottom > viewportTop
          && rect.top < viewportBottom
        ) {
          anchor = { index: rect.index, top: rect.top };
          break;
        }
      }
    }

    let mountedCount = 0;
    let hitMountLimit = false;
    for (const position of Array.from(mountPositions).sort((left, right) => left - right)) {
      if (this.virtualItems[position].mounted) {
        continue;
      }
      if (mountedCount >= ChatViewConversationRuntime.VIRTUAL_INITIAL_MOUNT_LIMIT) {
        hitMountLimit = true;
        break;
      }
      const message = conversation.messages[this.virtualItems[position].messageIndex];
      const rect = rects[position];
      const farFromViewport =
        rect.bottom < viewportTop - 400 || rect.top > viewportBottom + 400;
      const forceHydrateReveal =
        revealPosition >= 0
        && rect.bottom >= viewportTop - 400
        && rect.top <= viewportBottom + 400;
      const revealHydrationActive = this.revealForceHydrateUntilMs > Date.now();
      const snapshotHydrationActive =
        this.snapshotAnchorForceHydrateUntilMs > Date.now();
      void this.mountVirtualItem(position, {
        forceHydrate:
          position === revealPosition
          || forceHydrateReveal
          || (revealHydrationActive && !farFromViewport)
          || (snapshotHydrationActive && !farFromViewport),
        forceDeferMarkdown: farFromViewport && message?.status !== "streaming"
      });
      mountedCount += 1;
    }

    let unmountedCount = 0;
    for (let position = this.virtualItems.length - 1; position >= 0; position -= 1) {
      const entry = this.virtualItems[position];
      if (
        !entry.mounted
        || position === lastPosition
        || mountPositions.has(position)
        || !shouldUnmountVirtualItem({
          rect: rects[position],
          viewportTop,
          viewportBottom
        })
      ) {
        continue;
      }
      if (this.unmountVirtualItem(position)) {
        unmountedCount += 1;
      }
    }

    if (mountedCount > 0 || unmountedCount > 0) {
      if (wasPinnedToBottom) {
        const bottom = Math.max(0, hostEl.scrollHeight - hostEl.clientHeight);
        if (Math.abs(hostEl.scrollTop - bottom) > 1) {
          this.options.setScrollHostTop(bottom);
        }
      } else if (anchor) {
        const anchorEl = this.virtualItems[anchor.index].itemEl;
        if (anchorEl.isConnected) {
          const delta = anchorEl.getBoundingClientRect().top - anchor.top;
          if (Math.abs(delta) > 0.5) {
            this.options.setScrollHostTop(hostEl.scrollTop + delta);
          }
        }
      }
      this.options.syncScrollAffordances();
      recordChatRenderTrace("virtual-window-update", {
        conversationId: conversation.id,
        messageCount: this.virtualItems.length,
        mountedCount,
        unmountedCount,
        scrollTop: Math.round(hostEl.scrollTop)
      });
    }
    if (hitMountLimit) {
      this.scheduleVirtualWindowUpdate();
    }
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
      this.buildMessageSignature(lastMessage),
      this.buildOtherMessagesRevision(conversation),
      knowledgeBaseRoutingRevision
    ].join(":");
  }

  buildOtherMessagesRevision(conversation: ConversationRecord | null): string {
    if (!conversation || conversation.messages.length <= 1) {
      return "";
    }
    return conversation.messages
      .slice(0, -1)
      .map((message) => this.buildMessageSignature(message))
      .join("|");
  }

  private buildMessageSignature(message: MessageRecord): string {
    return [
      message.id,
      message.status,
      message.text.length,
      message.reasoningText?.length ?? 0,
      message.metaPanels?.reduce((total, panel) => {
        return total + (panel.text?.length ?? 0) + (panel.sources?.length ?? 0);
      }, 0) ?? 0,
      message.sources?.length ?? 0,
      message.errorText?.length ?? 0,
      message.activeAnswerVariantIndex ?? 0,
      message.answerVariants?.length ?? 0
    ].join("~");
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

  private findKnowledgeBaseRoutingForAssistant(
    conversation: ConversationRecord,
    messageIndex: number
  ): MessageRecord["knowledgeBaseRouting"] {
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index];
      if (message.role === "user") {
        return message.knowledgeBaseRouting;
      }
    }
    return undefined;
  }

  private renderMessageItem(
    itemEl: HTMLDivElement,
    conversation: ConversationRecord,
    message: MessageRecord,
    messageIndex: number,
    renderOptions: {
      renderGeneration: number;
      forceHydrate: boolean;
      forceDeferMarkdown: boolean;
    }
  ): Promise<void> | null {
    itemEl.empty();
    const messageSurface = message.role === "user"
      ? itemEl.createDiv({ cls: "sidet-message-bubble" })
      : itemEl;
    const contentSurface = message.role === "user"
      ? messageSurface.createDiv({ cls: "sidet-message-bubble-surface" })
      : messageSurface;
    const content = contentSurface.createDiv({ cls: "sidet-message-content" });
    const displayText = message.role === "assistant"
      ? getAssistantDisplayText(message)
      : message.text;
    this.options.renderAssistantMetaBlocks(messageSurface, content, message);
    let markdownRenderPromise: Promise<void> | null = null;
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
      const shouldDefer = !renderOptions.forceHydrate && (
        renderOptions.forceDeferMarkdown
        || shouldDeferMessageMarkdown({
          messageIndex,
          messageCount: conversation.messages.length,
          forceHydrateAll: false
        })
      );
      if (shouldDefer) {
        this.deferMessageMarkdown(itemEl, content, displayText ?? "");
      } else {
        const renderComponent = this.createMessageRenderComponent(itemEl);
        markdownRenderPromise = this.options.assistantRendering.renderAssistantMarkdown(
          content,
          displayText ?? "",
          renderComponent,
          {
            conversationId: conversation.id,
            renderGeneration: renderOptions.renderGeneration,
            managedScrollRestore: true,
            sources: message.sources
          }
        );
      }
    } else if (message.status === "error") {
      content.removeClass("is-pending-reply");
      content.empty();
      content.removeClass("-plain");
      content.addClass("markdown-rendered");
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
      const knowledgeBaseRouting = this.findKnowledgeBaseRoutingForAssistant(
        conversation,
        messageIndex
      );
      if (knowledgeBaseRouting) {
        renderMessageKnowledgeBaseRouting(contentSurface, knowledgeBaseRouting, {
          controller: this.options.controller
        });
      }
    } else if (this.options.messageActions.isLatestUserMessage(conversation, message)) {
      this.options.messageActions.renderUserMessageActions(messageSurface, conversation, message);
    }
    this.options.renderAnswerSources(itemEl, message);
    this.options.renderWikiMaintenancePlanAction(itemEl, conversation, message);
    this.options.renderInlineToolAction(itemEl, conversation, message);
    this.options.renderAnswerActions(itemEl, conversation, message);
    return markdownRenderPromise;
  }


  renderConversation(): void {
    const renderStartedAt = nowMs();
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
    const revealMessageId = this.pendingRevealMessageId
      && conversation?.messages.some((message) => message.id === this.pendingRevealMessageId)
      ? this.pendingRevealMessageId
      : null;
    if (!revealMessageId) {
      this.pendingRevealMessageId = null;
    }
    if (
      isConversationChanged &&
      this.options.messageActions.hasEditingMessageState() &&
      this.options.messageActions.getEditingMessageState()?.conversationId !== currentConversationId
    ) {
      this.options.messageActions.clearEditingMessageState();
    }
    const messageRevision = this.buildMessageRevision(conversation);
    const knowledgeBaseRoutingRevision = this.buildKnowledgeBaseRoutingRevision(conversation);
    this.lastOtherMessagesRevision = this.buildOtherMessagesRevision(conversation);
    const editingMessageIndex = conversation
      ? this.options.messageActions.getEditingMessageIndex(conversation)
      : -1;

    const messagesListEl = this.options.getMessagesListEl();
    if (!messagesListEl) {
      return;
    }

    // onOpen / setState 等路径可能连续要求渲染同一份内容；DOM 仍在时跳过，
    // 避免长对话每次打开都把消息和 Markdown 全部重建两遍。
    const renderKey = conversation
      ? `${conversation.id}:${messageRevision}:${editingMessageIndex}`
      : null;
    if (
      renderKey
      && renderKey === this.lastFullRenderKey
      && messagesListEl.childElementCount > 0
      && !revealMessageId
    ) {
      recordChatRenderTrace("conversation-render-skipped", {
        conversationId: currentConversationId,
        messageCount: conversation?.messages.length ?? 0
      });
      return;
    }
    this.lastFullRenderKey = renderKey;
    this.cacheVirtualHeights(conversation);
    this.clearRevealAlignment();
    this.clearDeferredMarkdownRender();
    this.options.assistantRendering.release();
    const renderGeneration = ++this.markdownRenderGeneration;

    if (revealMessageId && currentConversationId) {
      this.queueScrollIntent("reveal-message");
    } else if (isConversationChanged && currentConversationId) {
      this.queueScrollIntent("conversation-switch-or-initial-open");
    }
    const scrollSnapshot = this.captureScrollSnapshot(currentConversationId);

    this.resetVirtualItems(currentConversationId);
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

    let revealRenderPromise: Promise<void> | null = null;
    for (let messageIndex = 0; messageIndex < conversation.messages.length; messageIndex += 1) {
      if (this.options.messageActions.shouldHideMessageForEditing(conversation, messageIndex, editingMessageIndex)) {
        continue;
      }
      const message = conversation.messages[messageIndex];
      const item = messagesListEl.createDiv({
        cls: `sidet-message ${message.role === "user" ? "-user" : "-assistant"}${message.status === "error" ? " -error" : ""}`
      });
      item.setAttr("data-message-id", message.id);
      item.setAttr("data-message-index", String(messageIndex));
      const entry: VirtualMessageItem = {
        messageId: message.id,
        messageIndex,
        itemEl: item,
        mounted: false
      };
      this.virtualItems.push(entry);
      this.applyVirtualPlaceholder(entry, message);
    }

    const revealPosition = revealMessageId
      ? this.virtualItems.findIndex((entry) => entry.messageId === revealMessageId)
      : -1;
    if (revealPosition >= 0) {
      this.revealForceHydrateUntilMs = Date.now() + 1500;
    }
    const initialMountPositions = this.resolveInitialVirtualMountPositions(
      revealPosition,
      scrollSnapshot
    );
    const forceHydrateSnapshotWindow = Boolean(
      this.pendingScrollIntent === "none"
      && scrollSnapshot
      && !scrollSnapshot.pinnedToBottom
      && scrollSnapshot.anchorMessageId
    );
    for (const position of initialMountPositions) {
      const renderPromise = this.mountVirtualItem(position, {
        forceHydrate: revealPosition >= 0 || forceHydrateSnapshotWindow
      });
      if (position === revealPosition) {
        revealRenderPromise = renderPromise;
      }
    }

    // 最后一条消息始终保留内容：流式补丁门依赖它的 DOM。
    const lastPosition = this.virtualItems.length - 1;
    if (lastPosition >= 0 && !this.virtualItems[lastPosition].mounted) {
      const lastMessage = conversation.messages[this.virtualItems[lastPosition].messageIndex];
      const lastRect = this.virtualItems[lastPosition].itemEl.getBoundingClientRect();
      const hostEl = this.options.getScrollHost();
      const hostRect = hostEl.getBoundingClientRect();
      const farFromViewport =
        lastRect.bottom < hostRect.top - 400 || lastRect.top > hostRect.bottom + 400;
      void this.mountVirtualItem(lastPosition, {
        forceDeferMarkdown: farFromViewport && lastMessage?.status !== "streaming"
      });
    }

    this.lastKnowledgeBaseRoutingRevision = knowledgeBaseRoutingRevision;
    this.restoreMessageScroll(scrollSnapshot, currentConversationId, messageRevision);
    this.syncConversationChrome();
    this.setupDeferredMarkdownObserver(conversation.id, renderGeneration);
    this.scheduleSnapshotAnchorAlignment(scrollSnapshot);
    this.scheduleVirtualWindowUpdate();

    if (revealMessageId) {
      const applyReveal = () => {
        window.requestAnimationFrame(() => {
          if (this.pendingRevealMessageId === revealMessageId) {
            this.pendingRevealMessageId = null;
          }
          this.applyMessageReveal(revealMessageId);
        });
      };
      if (revealRenderPromise) {
        void revealRenderPromise.then(applyReveal, applyReveal);
      } else {
        applyReveal();
      }
    }

    recordChatRenderTrace("conversation-render", {
      durationMs: Math.round((nowMs() - renderStartedAt) * 10) / 10,
      conversationId: currentConversationId,
      messageCount: conversation.messages.length,
      mountedCount: this.virtualItems.reduce((total, entry) => total + (entry.mounted ? 1 : 0), 0),
      switched: isConversationChanged
    });
  }

  private resolveInitialVirtualMountPositions(
    revealPosition: number,
    scrollSnapshot: ScrollSnapshot | null
  ): number[] {
    const messageCount = this.virtualItems.length;
    if (messageCount === 0) {
      return [];
    }
    if (revealPosition >= 0) {
      const start = Math.max(
        0,
        revealPosition - ChatViewConversationRuntime.VIRTUAL_REVEAL_MOUNT_RADIUS
      );
      const end = Math.min(
        messageCount - 1,
        revealPosition + ChatViewConversationRuntime.VIRTUAL_REVEAL_MOUNT_RADIUS
      );
      return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
    }

    const shouldStartAtBottom =
      this.pendingScrollIntent === "after-send"
      || this.pendingScrollIntent === "conversation-switch-or-initial-open"
      || scrollSnapshot?.pinnedToBottom
      || !scrollSnapshot;
    if (!shouldStartAtBottom) {
      const hostEl = this.options.getScrollHost();
      const hostRect = hostEl.getBoundingClientRect();
      const delta = scrollSnapshot.scrollTop - hostEl.scrollTop;
      const rects: VirtualMessageRect[] = this.virtualItems.map((entry, index) => {
        const rect = entry.itemEl.getBoundingClientRect();
        return { index, top: rect.top, bottom: rect.bottom };
      });
      const range = resolveVirtualMountRange({
        rects,
        viewportTop: hostRect.top + delta,
        viewportBottom: hostRect.top + delta + hostEl.clientHeight,
        overscanPx: 600
      });
      const positions: number[] = [];
      if (range) {
        for (let index = range.startIndex; index <= range.endIndex; index += 1) {
          positions.push(index);
        }
      }
      if (scrollSnapshot.anchorMessageId) {
        const anchorPosition = this.virtualItems.findIndex(
          (entry) => entry.messageId === scrollSnapshot.anchorMessageId
        );
        if (anchorPosition >= 0) {
          const startPosition = Math.max(
            0,
            anchorPosition - ChatViewConversationRuntime.VIRTUAL_REVEAL_MOUNT_RADIUS
          );
          const endPosition = Math.min(
            messageCount - 1,
            anchorPosition + ChatViewConversationRuntime.VIRTUAL_REVEAL_MOUNT_RADIUS
          );
          for (let index = startPosition; index <= endPosition; index += 1) {
            if (!positions.includes(index)) {
              positions.push(index);
            }
          }
        }
      }
      if (positions.length > 0) {
        return this.limitInitialVirtualMountPositions(positions.sort((left, right) => left - right));
      }
    }

    const start = Math.max(
      0,
      messageCount - ChatViewConversationRuntime.VIRTUAL_INITIAL_TAIL_COUNT
    );
    return Array.from({ length: messageCount - start }, (_, offset) => start + offset);
  }

  private limitInitialVirtualMountPositions(positions: number[]): number[] {
    const limit = ChatViewConversationRuntime.VIRTUAL_INITIAL_MOUNT_LIMIT;
    if (positions.length <= limit) {
      return positions;
    }
    const center = (positions[0] + positions[positions.length - 1]) / 2;
    return [...positions]
      .sort((left, right) => Math.abs(left - center) - Math.abs(right - center))
      .slice(0, limit)
      .sort((left, right) => left - right);
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
    const otherMessagesChanged =
      currentConversationId === this.lastConversationId &&
      this.buildOtherMessagesRevision(conversation) !== this.lastOtherMessagesRevision;
    if (
      !knowledgeBaseRoutingChanged &&
      !otherMessagesChanged &&
      currentConversationId === this.lastConversationId &&
      conversation &&
      this.options.assistantRendering.canPatchLatestAssistantMessage(conversation) &&
      this.options.assistantRendering.patchLatestAssistantMessage()
    ) {
      // 补丁改变了最后一条消息的 DOM，旧的全量渲染键不再代表当前内容。
      this.lastFullRenderKey = null;
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
      this.lastFullRenderKey = null;
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
    const pinnedToBottom = this.options.getScrollPinnedToBottom();
    let anchorMessageId: string | null = null;
    let anchorOffset: number | null = null;
    if (!pinnedToBottom) {
      const hostRect = scrollHost.getBoundingClientRect();
      const items = this.options.getMessagesListEl()?.querySelectorAll<HTMLDivElement>(
        ".sidet-message[data-message-id]:not(.is-virtual-placeholder)"
      );
      for (const item of Array.from(items ?? [])) {
        const rect = item.getBoundingClientRect();
        if (rect.bottom > hostRect.top && rect.top < hostRect.bottom) {
          anchorMessageId = item.getAttribute("data-message-id");
          anchorOffset = rect.top - hostRect.top;
          break;
        }
      }
    }
    recordChatScrollTrace("capture-scroll-snapshot", {
      conversationId,
      scrollTop: scrollHost.scrollTop,
      pinnedToBottom,
      anchorMessageId,
      anchorOffset
    });
    return {
      conversationId,
      scrollTop: scrollHost.scrollTop,
      pinnedToBottom,
      anchorMessageId,
      anchorOffset
    };
  }

  private scheduleSnapshotAnchorAlignment(snapshot: ScrollSnapshot | null): void {
    if (
      !snapshot?.anchorMessageId
      || snapshot.anchorOffset === null
      || snapshot.pinnedToBottom
      || this.pendingScrollIntent === "reveal-message"
      || this.pendingScrollIntent === "after-send"
      || this.pendingScrollIntent === "conversation-switch-or-initial-open"
    ) {
      return;
    }
    const anchorMessageId = snapshot.anchorMessageId;
    const anchorOffset = snapshot.anchorOffset;
    this.snapshotAnchorForceHydrateUntilMs = Date.now() + 1200;
    window.requestAnimationFrame(() => {
      if (this.pendingScrollIntent !== "none") {
        return;
      }
      const hostEl = this.options.getScrollHost();
      let expectedScrollTop = hostEl.scrollTop;
      const deadline = Date.now() + 1200;
      const align = (): boolean => {
        if (
          Date.now() > deadline
          || this.pendingScrollIntent !== "none"
          || Math.abs(hostEl.scrollTop - expectedScrollTop) > 4
        ) {
          return false;
        }
        const itemEl = this.findMessageItem(anchorMessageId);
        if (!itemEl?.isConnected) {
          return false;
        }
        const hostRect = hostEl.getBoundingClientRect();
        const itemRect = itemEl.getBoundingClientRect();
        const delta = itemRect.top - hostRect.top - anchorOffset;
        if (Math.abs(delta) > 1) {
          this.options.setScrollHostTop(hostEl.scrollTop + delta);
          expectedScrollTop = hostEl.scrollTop;
          recordChatRenderTrace("snapshot-anchor-align", {
            anchorMessageId,
            anchorOffset,
            delta
          });
        }
        return true;
      };
      if (!align()) {
        return;
      }
      const tick = (): void => {
        if (!align()) {
          return;
        }
        window.setTimeout(tick, 160);
      };
      window.setTimeout(tick, 160);
    });
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
