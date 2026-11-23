import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { stripSidetToolActionBlock } from "../agent/actions/agent-tool-protocol";
import { stripSidetProtocolBlocks } from "../agent/web-search/sidet-protocol";
import { parseWebSearchImportLink } from "../context/web-search-service";
import type { ConversationRecord, MessageMetaPanel, MessageRecord } from "../types";
import { recordChatScrollTrace } from "./chat-scroll-trace";
import {
  findAssistantInlineActions,
  findAssistantLinks,
  findAssistantMessageContent,
  findAssistantMetaPanels,
  findAssistantMetaPanelParts,
  findAssistantStatusLines
} from "./assistant-message-dom";

export interface PendingStreamingMarkdownRender {
  contentEl: HTMLDivElement;
  markdown: string;
  conversationId: string;
  messageId: string;
}

interface RenderAssistantMarkdownOptions {
  conversationId: string;
  renderGeneration: number;
  messageId?: string;
  requireStreaming?: boolean;
  staged?: boolean;
  managedScrollRestore?: boolean;
}

interface ChatViewAssistantRenderingOptions {
  getApp: () => App;
  addChild: (component: Component) => void;
  trackMessageRenderComponent: (component: Component) => void;
  getScrollHost: () => HTMLElement;
  setScrollHostTop: (scrollTop: number) => void;
  syncScrollAffordances: () => void;
  getScrollBottomTarget: (scrollHost?: HTMLElement) => number;
  getScrollPinnedToBottom: () => boolean;
  setScrollPinnedToBottom: (value: boolean) => void;
  getLastConversationId: () => string | null;
  getLastRenderedMessageCount: () => number;
  setLastRenderedMessageCount: (count: number) => void;
  getMarkdownRenderGeneration: () => number;
  buildMessageRevision: (conversation: ConversationRecord | null) => string | null;
  setLastMessageRevision: (revision: string | null) => void;
  syncComposerButtons: () => void;
  getConversationForCurrentLeaf: () => ConversationRecord | null;
  getConversationById: (conversationId: string) => ConversationRecord | null;
  getCurrentConversationId: () => string | null;
  getMessagesListEl: () => HTMLDivElement | null;
  renderConversation: () => void;
  setPlainMessageContent: (contentEl: HTMLDivElement, text: string) => void;
  renderInlineToolAction: (parentEl: HTMLElement, conversation: ConversationRecord, message: MessageRecord) => void;
  renderWikiMaintenancePlanAction: (
    parentEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ) => void;
  importWebSearchResultUrl: (url: string) => void;
}

interface RenderedStatusLine {
  kind: string;
  text: string;
}

interface RenderedMetaPanelSection {
  kind: string;
  label: string;
  text?: string;
  sources?: MessageMetaPanel["sources"];
}

interface RenderedMetaPanelBlock {
  kind: string;
  label: string;
  text?: string;
  sources?: MessageMetaPanel["sources"];
  sections?: RenderedMetaPanelSection[];
}

interface RenderedMetaLayout {
  statusLines: RenderedStatusLine[];
  panels: RenderedMetaPanelBlock[];
}

interface StepGroupInfo {
  group: string;
  label: string;
}

const META_PANEL_GROUP_ORDER = new Map<string, number>([
  ["group:deep-thinking", 0],
  ["group:web-search", 1]
]);

const HIDDEN_DEEP_THINKING_STEP_LABELS = new Set([
  "模型思考",
  "联网搜索",
  "网页搜索",
  "网页抓取",
  "过程说明",
  "过程"
]);

const HIDDEN_WEB_SEARCH_STEP_LABELS = new Set([
  "联网搜索",
  "联网搜索中",
  "联网过程",
  "网页搜索",
  "网页抓取",
  "过程说明",
  "过程"
]);

export class ChatViewAssistantRendering {
  private static readonly BOTTOM_REANCHOR_THRESHOLD = 96;

  private streamingMessagePatchFrame: number | null = null;
  private pendingStreamingMarkdownRender: PendingStreamingMarkdownRender | null = null;
  private streamingMarkdownRenderInFlight = false;
  private streamingMarkdownRenderTimer: number | null = null;
  private lastStreamingMarkdownRenderAt = 0;
  private streamingMarkdownRenderComponent: Component | null = null;
  private bottomFollowFrame: number | null = null;
  private bottomFollowProgrammaticScrollTop: number | null = null;
  private bottomAnchorRequestVersion = 0;

  constructor(private readonly options: ChatViewAssistantRenderingOptions) {}

  release(): void {
    this.cancelStreamingMessagePatch();
    this.cancelBottomFollow();
    this.resetStreamingMarkdownRenderer();
    this.bottomFollowProgrammaticScrollTop = null;
  }

  handleScroll(scrollTop: number): boolean {
    if (
      this.bottomFollowProgrammaticScrollTop !== null &&
      Math.abs(scrollTop - this.bottomFollowProgrammaticScrollTop) <= 1
    ) {
      this.bottomFollowProgrammaticScrollTop = null;
      return true;
    }
    this.bottomFollowProgrammaticScrollTop = null;
    return false;
  }

  updatePinnedToBottom(bottomPinThreshold: number): boolean {
    const scrollHost = this.options.getScrollHost();
    const distanceFromBottom =
      scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight;
    const isPinned = distanceFromBottom <= bottomPinThreshold;
    this.options.setScrollPinnedToBottom(isPinned);
    if (!isPinned) {
      this.cancelBottomFollow();
    }
    return isPinned;
  }

  restoreMessageScroll(
    snapshot: { conversationId: string | null; scrollTop: number; pinnedToBottom: boolean } | null,
    conversationId: string | null,
    messageRevision: string | null,
    state: {
      lastConversationId: string | null;
      lastMessageRevision: string | null;
      pendingScrollIntent: "none" | "after-send" | "conversation-switch-or-initial-open";
    },
    callbacks: {
      clearPendingScrollIntent: () => void;
    }
  ): { lastConversationId: string | null; lastMessageRevision: string | null } {
    const isConversationChanged = conversationId !== state.lastConversationId;
    const isMessageChanged = messageRevision !== state.lastMessageRevision;
    const shouldScrollForSend =
      state.pendingScrollIntent === "after-send" && conversationId !== null && isMessageChanged;
    const shouldScrollForConversation =
      state.pendingScrollIntent === "conversation-switch-or-initial-open" &&
      conversationId !== null &&
      isConversationChanged;
    const wasPinnedToBottomBeforeRender = snapshot?.pinnedToBottom ?? this.options.getScrollPinnedToBottom();
    const shouldFollowLatest =
      conversationId !== null &&
      !isConversationChanged &&
      isMessageChanged &&
      wasPinnedToBottomBeforeRender;

    if (shouldScrollForSend || shouldScrollForConversation) {
      recordChatScrollTrace("restore-message-scroll-to-bottom", {
        reason: shouldScrollForSend ? "after-send" : "conversation-switch-or-initial-open",
        snapshotScrollTop: snapshot?.scrollTop ?? null,
        conversationId,
        messageRevision
      });
      this.scrollMessagesToBottom({
        onAfterScroll: callbacks.clearPendingScrollIntent
      });
    } else if (shouldFollowLatest) {
      recordChatScrollTrace("restore-message-scroll-follow-latest", {
        conversationId,
        messageRevision,
        snapshotScrollTop: snapshot?.scrollTop ?? null,
        snapshotPinnedToBottom: snapshot?.pinnedToBottom ?? null
      });
      this.scrollMessagesToBottom({ keepPinned: true });
    } else if (snapshot) {
      recordChatScrollTrace("restore-message-scroll-snapshot", {
        conversationId,
        messageRevision,
        snapshotScrollTop: snapshot.scrollTop
      });
      window.requestAnimationFrame(() => {
        this.options.setScrollHostTop(snapshot.scrollTop);
        this.options.syncScrollAffordances();
      });
    } else {
      this.options.syncScrollAffordances();
    }

    return {
      lastConversationId: conversationId,
      lastMessageRevision: messageRevision
    };
  }

  scrollMessagesToBottom(options: { keepPinned?: boolean; onAfterScroll?: () => void } = {}): void {
    this.cancelBottomFollow();
    this.bottomAnchorRequestVersion += 1;
    window.requestAnimationFrame(() => {
      const activeScrollHost = this.options.getScrollHost();
      recordChatScrollTrace("apply-scroll-messages-to-bottom", {
        currentScrollTop: activeScrollHost.scrollTop,
        targetScrollTop: this.options.getScrollBottomTarget(activeScrollHost),
        keepPinned: Boolean(options.keepPinned)
      });
      this.options.setScrollHostTop(this.options.getScrollBottomTarget(activeScrollHost));
      this.options.setScrollPinnedToBottom(true);
      this.options.syncScrollAffordances();
      if (options.keepPinned) {
        this.requestBottomFollow("smooth");
      }
      options.onAfterScroll?.();
    });
  }

  requestBottomFollow(mode: "instant" | "smooth"): void {
    const scrollHost = this.options.getScrollHost();
    if (mode === "smooth") {
      const distanceFromBottom =
        scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight;
      if (!this.options.getScrollPinnedToBottom() && distanceFromBottom > ChatViewAssistantRendering.BOTTOM_REANCHOR_THRESHOLD) {
        this.options.syncScrollAffordances();
        return;
      }
      if (distanceFromBottom <= ChatViewAssistantRendering.BOTTOM_REANCHOR_THRESHOLD) {
        this.options.setScrollPinnedToBottom(true);
      }
    }

    const bottomTarget = this.options.getScrollBottomTarget(scrollHost);
    if (mode === "instant") {
      this.cancelBottomFollow();
      recordChatScrollTrace("apply-request-bottom-follow-instant", {
        currentScrollTop: scrollHost.scrollTop,
        targetScrollTop: bottomTarget
      });
      this.options.setScrollHostTop(bottomTarget);
      this.options.setScrollPinnedToBottom(true);
      this.options.syncScrollAffordances();
      return;
    }

    if (this.bottomFollowFrame !== null) {
      return;
    }

    const step = () => {
      this.bottomFollowFrame = null;
      if (!this.options.getScrollPinnedToBottom()) {
        return;
      }

      const activeScrollHost = this.options.getScrollHost();
      const target = this.options.getScrollBottomTarget(activeScrollHost);
      const current = activeScrollHost.scrollTop;
      const delta = target - current;

      if (delta <= 1) {
        recordChatScrollTrace("apply-request-bottom-follow-final", {
          currentScrollTop: current,
          targetScrollTop: target
        });
        this.options.setScrollHostTop(target);
        this.options.setScrollPinnedToBottom(true);
        this.options.syncScrollAffordances();
        return;
      }

      const next = current + Math.max(1.5, delta * 0.22);
      recordChatScrollTrace("apply-request-bottom-follow-step", {
        currentScrollTop: current,
        nextScrollTop: Math.min(target, next),
        targetScrollTop: target
      });
      this.options.setScrollHostTop(Math.min(target, next));
      this.bottomFollowProgrammaticScrollTop = activeScrollHost.scrollTop;
      this.options.setScrollPinnedToBottom(true);
      this.options.syncScrollAffordances();
      this.bottomFollowFrame = window.requestAnimationFrame(step);
    };

    this.bottomFollowFrame = window.requestAnimationFrame(step);
  }

  cancelBottomFollow(): void {
    if (this.bottomFollowFrame === null) {
      return;
    }

    window.cancelAnimationFrame(this.bottomFollowFrame);
    this.bottomFollowFrame = null;
  }

  setPendingAssistantPlaceholder(contentEl: HTMLDivElement): void {
    contentEl.empty();
    contentEl.removeClass("-plain");
    contentEl.addClass("markdown-rendered");
    contentEl.addClass("is-pending-reply");
    const dotsEl = contentEl.createDiv({ cls: "sidet-pending-reply-dots" });
    for (let index = 0; index < 3; index += 1) {
      dotsEl.createSpan({ cls: "sidet-pending-reply-dot" });
    }
  }

  scheduleStreamingMessagePatch(): void {
    if (this.streamingMessagePatchFrame !== null) {
      return;
    }

    this.streamingMessagePatchFrame = window.requestAnimationFrame(() => {
      this.streamingMessagePatchFrame = null;
      if (!this.patchLatestAssistantMessage()) {
        this.options.renderConversation();
      }
    });
  }

  cancelStreamingMessagePatch(): void {
    if (this.streamingMessagePatchFrame === null) {
      return;
    }

    window.cancelAnimationFrame(this.streamingMessagePatchFrame);
    this.streamingMessagePatchFrame = null;
  }

  resetStreamingMarkdownRenderer(): void {
    this.pendingStreamingMarkdownRender = null;
    this.streamingMarkdownRenderInFlight = false;
    if (this.streamingMarkdownRenderTimer !== null) {
      window.clearTimeout(this.streamingMarkdownRenderTimer);
      this.streamingMarkdownRenderTimer = null;
    }
    this.lastStreamingMarkdownRenderAt = 0;
    this.streamingMarkdownRenderComponent?.unload();
    this.streamingMarkdownRenderComponent = null;
  }

  canPatchLatestAssistantMessage(conversation: ConversationRecord | null): boolean {
    const messagesListEl = this.options.getMessagesListEl();
    if (!conversation || !messagesListEl) {
      return false;
    }

    if (conversation.id !== this.options.getLastConversationId()) {
      return false;
    }

    if (conversation.messages.length === 0 || conversation.messages.length !== this.options.getLastRenderedMessageCount()) {
      return false;
    }

    if (messagesListEl.childElementCount !== conversation.messages.length) {
      return false;
    }

    const lastMessage = conversation.messages[conversation.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      return false;
    }

    if ((lastMessage.attachments?.length ?? 0) > 0) {
      return false;
    }

    return lastMessage.status === "streaming" || lastMessage.status === "done";
  }

  patchLatestAssistantMessage(): boolean {
    const conversation = this.options.getConversationForCurrentLeaf();
    const messagesListEl = this.options.getMessagesListEl();
    if (!conversation || !this.canPatchLatestAssistantMessage(conversation) || !messagesListEl) {
      return false;
    }

    const lastMessage = conversation.messages[conversation.messages.length - 1];
    const lastItemEl = messagesListEl.lastElementChild;
    if (!(lastItemEl instanceof HTMLDivElement)) {
      return false;
    }

    const contentEl = findAssistantMessageContent(lastItemEl);
    if (!(contentEl instanceof HTMLDivElement)) {
      return false;
    }

    const displayText = stripSidetToolActionBlock(stripSidetProtocolBlocks(lastMessage.text));
    lastItemEl.classList.remove("-user", "-error");
    lastItemEl.classList.add("-assistant");
    findAssistantInlineActions(lastItemEl).forEach((element) => {
      element.remove();
    });

    this.syncMetaBlocks(lastItemEl, contentEl, lastMessage);
    const nextText = displayText.trim() ? displayText : "";
    const isStreaming = lastMessage.status === "streaming";
    if (isStreaming && displayText.trim() && this.shouldRenderStreamingMarkdown(displayText)) {
      contentEl.removeClass("is-pending-reply");
      if (!contentEl.classList.contains("markdown-rendered") && contentEl.textContent !== nextText) {
        this.options.setPlainMessageContent(contentEl, nextText);
      }
      this.scheduleStreamingMarkdownRender({
        contentEl,
        markdown: displayText,
        conversationId: conversation.id,
        messageId: lastMessage.id
      });
    } else if (isStreaming && !nextText) {
      this.resetStreamingMarkdownRenderer();
      this.setPendingAssistantPlaceholder(contentEl);
    } else if (!isStreaming && this.shouldRenderAssistantMarkdown(lastMessage)) {
      this.resetStreamingMarkdownRenderer();
      contentEl.removeClass("is-pending-reply");
      const renderComponent = new Component();
      this.options.addChild(renderComponent);
      this.options.trackMessageRenderComponent(renderComponent);
      void this.renderAssistantMarkdown(contentEl, displayText, renderComponent, {
        conversationId: conversation.id,
        renderGeneration: this.options.getMarkdownRenderGeneration(),
        messageId: lastMessage.id
      });
    } else if (!nextText) {
      contentEl.removeClass("is-pending-reply");
      contentEl.empty();
      contentEl.removeClass("-plain");
      contentEl.addClass("markdown-rendered");
    } else if (!contentEl.classList.contains("-plain") || contentEl.textContent !== nextText) {
      contentEl.removeClass("is-pending-reply");
      this.options.setPlainMessageContent(contentEl, nextText);
    }

    this.options.renderWikiMaintenancePlanAction(lastItemEl, conversation, lastMessage);
    this.options.renderInlineToolAction(lastItemEl, conversation, lastMessage);
    this.options.setLastRenderedMessageCount(conversation.messages.length);
    this.options.setLastMessageRevision(this.options.buildMessageRevision(conversation));
    this.options.syncComposerButtons();

    if (this.options.getScrollPinnedToBottom()) {
      this.requestBottomFollow("smooth");
      return true;
    }

    this.options.syncScrollAffordances();
    return true;
  }

  shouldRenderAssistantMarkdown(message: MessageRecord): boolean {
    return message.role === "assistant" && message.status !== "error" && Boolean(message.text.trim());
  }

  async renderAssistantMarkdown(
    contentEl: HTMLDivElement,
    markdown: string,
    renderComponent: Component,
    options: RenderAssistantMarkdownOptions
  ): Promise<void> {
    const scrollHost = this.options.getScrollHost();
    const preservedScrollTop = scrollHost.scrollTop;
    const wasPinnedToBottom = this.options.getScrollPinnedToBottom();
    const bottomAnchorVersionAtStart = this.bottomAnchorRequestVersion;
    recordChatScrollTrace("render-assistant-markdown-start", {
      conversationId: options.conversationId,
      preservedScrollTop,
      wasPinnedToBottom,
      bottomAnchorVersionAtStart,
      staged: Boolean(options.staged)
    });
    const renderTarget = options.staged
      ? contentEl.ownerDocument.createElement("div")
      : contentEl;

    try {
      contentEl.removeClass("is-pending-reply");
      renderTarget.empty();
      renderTarget.removeClass("is-pending-reply");
      renderTarget.removeClass("-plain");
      renderTarget.addClass("markdown-rendered");
      if (!markdown.trim()) {
        renderTarget.setText(" ");
      } else {
        await MarkdownRenderer.render(
          this.options.getApp(),
          markdown,
          renderTarget,
          this.options.getApp().workspace.getActiveFile()?.path ?? "",
          renderComponent
        );
        this.hydrateSpecialLinks(renderTarget);
      }
    } catch (error) {
      console.error("Sidet：渲染 AI Markdown 失败", error);
      this.options.setPlainMessageContent(contentEl, markdown);
      return;
    }

    if (
      options.renderGeneration !== this.options.getMarkdownRenderGeneration() ||
      this.options.getCurrentConversationId() !== options.conversationId
    ) {
      return;
    }

    if (options.messageId || options.requireStreaming) {
      const currentConversation = this.options.getConversationById(options.conversationId);
      const currentLastMessage = currentConversation?.messages[currentConversation.messages.length - 1] ?? null;
      if (
        currentLastMessage?.id !== options.messageId ||
        (options.requireStreaming && currentLastMessage?.status !== "streaming")
      ) {
        return;
      }
    }

    if (options.staged) {
      contentEl.empty();
      contentEl.removeClass("-plain");
      contentEl.addClass("markdown-rendered");
      while (renderTarget.firstChild) {
        contentEl.appendChild(renderTarget.firstChild);
      }
    }

    window.requestAnimationFrame(() => {
      if (bottomAnchorVersionAtStart !== this.bottomAnchorRequestVersion) {
        recordChatScrollTrace("render-assistant-markdown-follow-bottom-anchor", {
          conversationId: options.conversationId,
          preservedScrollTop,
          bottomAnchorVersionAtStart,
          currentBottomAnchorVersion: this.bottomAnchorRequestVersion
        });
        this.requestBottomFollow("smooth");
        return;
      }

      const activeScrollHost = this.options.getScrollHost();
      const distanceFromBottom =
        activeScrollHost.scrollHeight - activeScrollHost.scrollTop - activeScrollHost.clientHeight;
      if (
        wasPinnedToBottom &&
        (this.options.getScrollPinnedToBottom() || distanceFromBottom <= ChatViewAssistantRendering.BOTTOM_REANCHOR_THRESHOLD)
      ) {
        recordChatScrollTrace("render-assistant-markdown-follow-pinned-bottom", {
          conversationId: options.conversationId,
          preservedScrollTop,
          distanceFromBottom
        });
        this.requestBottomFollow("smooth");
        return;
      }
      if (options.managedScrollRestore) {
        recordChatScrollTrace("render-assistant-markdown-skip-managed-restore", {
          conversationId: options.conversationId,
          activeScrollTop: activeScrollHost.scrollTop,
          preservedScrollTop
        });
        this.options.syncScrollAffordances();
        return;
      }
      if (Math.abs(activeScrollHost.scrollTop - preservedScrollTop) <= 48) {
        recordChatScrollTrace("render-assistant-markdown-restore-preserved", {
          conversationId: options.conversationId,
          activeScrollTop: activeScrollHost.scrollTop,
          preservedScrollTop
        });
        this.options.setScrollHostTop(preservedScrollTop);
      }
      this.options.syncScrollAffordances();
    });
  }

  private scheduleStreamingMarkdownRender(render: PendingStreamingMarkdownRender): void {
    this.pendingStreamingMarkdownRender = render;
    if (this.streamingMarkdownRenderInFlight || this.streamingMarkdownRenderTimer !== null) {
      return;
    }

    const elapsed = Date.now() - this.lastStreamingMarkdownRenderAt;
    const delay = Math.max(0, 140 - elapsed);
    this.streamingMarkdownRenderTimer = window.setTimeout(() => {
      this.streamingMarkdownRenderTimer = null;
      this.streamingMarkdownRenderInFlight = true;
      window.requestAnimationFrame(() => {
        void this.flushStreamingMarkdownRender();
      });
    }, delay);
  }

  private async flushStreamingMarkdownRender(): Promise<void> {
    const render = this.pendingStreamingMarkdownRender;
    if (!render) {
      this.streamingMarkdownRenderInFlight = false;
      return;
    }

    this.pendingStreamingMarkdownRender = null;
    this.lastStreamingMarkdownRenderAt = Date.now();
    const currentConversationId = this.options.getCurrentConversationId();
    const currentConversation = currentConversationId
      ? this.options.getConversationById(currentConversationId)
      : null;
    const currentLastMessage = currentConversation?.messages[currentConversation.messages.length - 1] ?? null;
    if (
      currentConversationId !== render.conversationId ||
      currentLastMessage?.id !== render.messageId ||
      currentLastMessage.status !== "streaming"
    ) {
      if (this.pendingStreamingMarkdownRender) {
        window.requestAnimationFrame(() => {
          void this.flushStreamingMarkdownRender();
        });
      } else {
        this.streamingMarkdownRenderInFlight = false;
      }
      return;
    }

    this.streamingMarkdownRenderComponent?.unload();
    this.streamingMarkdownRenderComponent = new Component();
    this.options.addChild(this.streamingMarkdownRenderComponent);

    await this.renderAssistantMarkdown(render.contentEl, render.markdown, this.streamingMarkdownRenderComponent, {
      conversationId: render.conversationId,
      renderGeneration: this.options.getMarkdownRenderGeneration(),
      messageId: render.messageId,
      requireStreaming: true,
      staged: true
    });

    if (this.pendingStreamingMarkdownRender) {
      window.requestAnimationFrame(() => {
        void this.flushStreamingMarkdownRender();
      });
      return;
    }

    this.streamingMarkdownRenderInFlight = false;
  }

  private shouldRenderStreamingMarkdown(markdown: string): boolean {
    return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~|\|.+\||-{3,}\s*$)|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__/m.test(markdown);
  }

  private hydrateSpecialLinks(root: HTMLElement): void {
    const anchors = findAssistantLinks(root);
    for (const anchor of anchors) {
      const targetUrl = parseWebSearchImportLink(anchor.href);
      if (!targetUrl) {
        continue;
      }

      anchor.classList.add("sidet-web-search-import-link");
      anchor.setAttribute("data-sidet-web-search-import", "true");
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.importWebSearchResultUrl(targetUrl);
      });
    }
  }

  syncMetaBlocks(
    itemEl: HTMLDivElement,
    contentEl: HTMLDivElement,
    message: MessageRecord
  ): void {
    const layout = this.buildMetaLayout(message);
    const nextStatusLines = layout.statusLines;
    const nextPanels = layout.panels;
    const existingStatusLines = findAssistantStatusLines(itemEl);
    const existingPanels = findAssistantMetaPanels(itemEl);
    if (nextStatusLines.length === 0 && nextPanels.length === 0) {
      existingStatusLines.forEach((line) => line.remove());
      existingPanels.forEach((panel) => panel.remove());
      return;
    }

    const statusLineByKind = new Map<string, HTMLDivElement>();
    existingStatusLines.forEach((line) => {
      if (line.instanceOf(HTMLDivElement)) {
        const kind = line.getAttribute("data-status-kind");
        if (kind) {
          statusLineByKind.set(kind, line);
        }
      }
    });

    for (const statusLine of nextStatusLines) {
      let lineEl = statusLineByKind.get(statusLine.kind);
      if (lineEl) {
        statusLineByKind.delete(statusLine.kind);
      } else {
        lineEl = itemEl.ownerDocument.createElement("div");
        lineEl.className = "sidet-message-status-line";
        lineEl.setAttribute("data-status-kind", statusLine.kind);
      }

      lineEl.classList.add("sidet-message-status-line");
      lineEl.setAttribute("data-status-kind", statusLine.kind);
      lineEl.textContent = statusLine.text;
      if (lineEl.nextElementSibling !== contentEl) {
        itemEl.insertBefore(lineEl, contentEl);
      }
    }

    statusLineByKind.forEach((lineEl) => lineEl.remove());

    const panelByKind = new Map<string, HTMLDetailsElement>();
    existingPanels.forEach((panel) => {
      if (panel.instanceOf(HTMLDetailsElement)) {
        const kind = panel.getAttribute("data-panel-kind");
        if (kind) {
          panelByKind.set(kind, panel);
        }
      }
    });

    for (const panel of nextPanels) {
      let detailsEl = panelByKind.get(panel.kind);
      let shouldBuildContent = false;
      if (detailsEl) {
        panelByKind.delete(panel.kind);
        const existingParts = findAssistantMetaPanelParts(detailsEl);
        shouldBuildContent = !existingParts.iconEl
          || !existingParts.previewEl
          || !existingParts.bodyEl;
      } else {
        detailsEl = itemEl.ownerDocument.createElement("details");
        detailsEl.className = "sidet-message-meta-panel";
        detailsEl.setAttribute("data-panel-kind", panel.kind);
        shouldBuildContent = true;
      }

      detailsEl.classList.add("sidet-message-meta-panel");
      detailsEl.setAttribute("data-panel-kind", panel.kind);

      if (shouldBuildContent) {
        detailsEl.empty();
        const summaryEl = itemEl.ownerDocument.createElement("summary");
        summaryEl.className = "sidet-message-meta-panel-summary";

        const iconEl = itemEl.ownerDocument.createElement("span");
        iconEl.className = "sidet-message-meta-panel-icon";
        setIcon(iconEl, "chevron-right");
        summaryEl.appendChild(iconEl);

        summaryEl.createSpan({
          cls: "sidet-message-meta-panel-label"
        });
        summaryEl.createSpan({
          cls: "sidet-message-meta-panel-preview"
        });
        detailsEl.appendChild(summaryEl);

        detailsEl.createDiv({
          cls: "sidet-message-meta-panel-body"
        });
      }

      const panelParts = findAssistantMetaPanelParts(detailsEl);
      if (panelParts.labelEl instanceof HTMLElement) {
        panelParts.labelEl.textContent = panel.label;
      }

      if (panelParts.previewEl instanceof HTMLElement) {
        const nextPreviewText = this.getMetaPanelPreviewText(panel, panelParts.previewEl.textContent ?? "");
        if (nextPreviewText !== null) {
          panelParts.previewEl.textContent = nextPreviewText;
        }
      }

      if (panelParts.bodyEl instanceof HTMLElement) {
        this.renderMetaPanelBody(panelParts.bodyEl, panel);
      }

      if (detailsEl.nextElementSibling !== contentEl) {
        itemEl.insertBefore(detailsEl, contentEl);
      }
    }

    panelByKind.forEach((panelEl) => panelEl.remove());
  }

  private getMetaPanelPreviewText(panel: RenderedMetaPanelBlock, previousPreview: string): string | null {
    const previewTarget = panel.sections?.length ? panel.sections[panel.sections.length - 1] : panel;
    if (previewTarget.sources?.length) {
      const sourceTitles = previewTarget.sources.map((source) => source.title).filter(Boolean);
      if (sourceTitles.length === 0) {
        return previousPreview ? null : "已引用来源";
      }
      const joined = sourceTitles.join(" / ");
      return joined.length > 96 ? `…${joined.slice(-96)}` : joined;
    }

    const text = previewTarget.text?.trim() ?? "";
    const stableText = this.getStableStreamingText(text, previousPreview);
    if (!stableText.trim()) {
      if (previousPreview) {
        return null;
      }
      return this.isReasoningPanel(panel.kind) ? "正在思考…" : "处理中…";
    }

    const collapsed = stableText.replace(/\s+/g, " ").trim();
    return collapsed.length > 96 ? `…${collapsed.slice(-96)}` : collapsed;
  }

  private getStableStreamingText(text: string, previousText: string): string {
    const normalized = text.replace(/\r\n/g, "\n");

    const lastBreak = Math.max(
      normalized.lastIndexOf("\n"),
      normalized.lastIndexOf("。"),
      normalized.lastIndexOf("！"),
      normalized.lastIndexOf("？"),
      normalized.lastIndexOf("；"),
      normalized.lastIndexOf(". "),
      normalized.lastIndexOf("! "),
      normalized.lastIndexOf("? "),
      normalized.lastIndexOf("; ")
    );

    if (lastBreak >= 0) {
      const stableText = normalized.slice(0, lastBreak + 1).trimEnd();
      if (stableText.length >= previousText.trimEnd().length) {
        return stableText;
      }
    }

    return previousText.trim() ? previousText : normalized;
  }

  private isReasoningPanel(kind: string): boolean {
    return kind === "reasoning" || kind.startsWith("reasoning-") || kind === "deep-thinking";
  }

  private isWebSearchPanel(panel: MessageMetaPanel): boolean {
    const kind = panel.kind.trim();
    const label = panel.label.trim();
    const group = panel.group?.trim() || "";
    const groupLabel = panel.groupLabel?.trim() || "";
    return kind === "web-process"
      || kind.startsWith("web-step-")
      || group === "web-search"
      || groupLabel === "联网搜索"
      || label === "联网搜索"
      || label === "联网搜索中"
      || label === "联网过程";
  }

  private buildMetaLayout(message: MessageRecord): RenderedMetaLayout {
    const statusLines: RenderedStatusLine[] = [];
    const groupedPanels = new Map<string, RenderedMetaPanelBlock>();
    const regularPanels: RenderedMetaPanelBlock[] = [];

    const ensureGroupPanel = (group: string, label: string): RenderedMetaPanelBlock => {
      const kind = `group:${group}`;
      let block = groupedPanels.get(kind);
      if (!block) {
        block = {
          kind,
          label,
          sections: []
        };
        groupedPanels.set(kind, block);
      }
      return block;
    };

    const appendStepSection = (
      group: string,
      groupLabel: string,
      section: RenderedMetaPanelSection
    ): void => {
      const block = ensureGroupPanel(group, groupLabel);
      if (!block.sections) {
        block.sections = [];
      }
      const previousSection = block.sections[block.sections.length - 1];
      if (
        previousSection
        && previousSection.label === section.label
        && previousSection.text === section.text
        && JSON.stringify(previousSection.sources ?? []) === JSON.stringify(section.sources ?? [])
      ) {
        return;
      }
      block.sections.push(section);
    };

    const reasoningText = message.reasoningText?.trim() ?? "";
    const reasoningLabel = message.reasoningLabel?.trim() ?? "";
    if (reasoningText) {
      appendStepSection("deep-thinking", "深度思考", {
        kind: "reasoning-stream",
        label: reasoningLabel,
        text: reasoningText
      });
    }

    for (const panel of message.metaPanels ?? []) {
      const hasText = panel.text?.trim();
      const hasSources = (panel.sources?.length ?? 0) > 0;
      if (!hasText && !hasSources) {
        continue;
      }

      if (panel.display === "status") {
        if (hasText) {
          statusLines.push({
            kind: panel.kind,
            text: panel.text!.trim()
          });
        }
        continue;
      }

      if (panel.display === "step") {
        const stepGroup = this.resolveStepGroup(panel);
        appendStepSection(stepGroup.group, stepGroup.label, {
          kind: panel.kind,
          label: panel.label.trim() || "过程",
          text: hasText ? panel.text : undefined,
          sources: hasSources ? panel.sources : undefined
        });
        continue;
      }

      if (this.isWebSearchPanel(panel)) {
        appendStepSection("web-search", "联网搜索", {
          kind: panel.kind,
          label: panel.label.trim() || "过程",
          text: hasText ? panel.text : undefined,
          sources: hasSources ? panel.sources : undefined
        });
        continue;
      }

      if (this.isDeepThinkingPanel(panel)) {
        appendStepSection("deep-thinking", "深度思考", {
          kind: panel.kind,
          label: panel.label.trim() || "过程",
          text: hasText ? panel.text : undefined,
          sources: hasSources ? panel.sources : undefined
        });
        continue;
      }

      regularPanels.push({
        kind: panel.kind,
        label: panel.label,
        text: hasText ? panel.text : undefined,
        sources: hasSources ? panel.sources : undefined
      });
    }

    return {
      statusLines,
      panels: [
        ...Array.from(groupedPanels.values()).sort((left, right) => {
          const leftOrder = META_PANEL_GROUP_ORDER.get(left.kind) ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = META_PANEL_GROUP_ORDER.get(right.kind) ?? Number.MAX_SAFE_INTEGER;
          if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }
          return 0;
        }),
        ...regularPanels
      ]
    };
  }

  private isDeepThinkingPanel(panel: MessageMetaPanel): boolean {
    const trimmedLabel = panel.label.trim();
    return this.isReasoningPanel(panel.kind)
      || trimmedLabel === "深度思考"
      || trimmedLabel === "深度思考中"
      || trimmedLabel === "已深度思考"
      || (this.isReasoningPanel(panel.kind) && !trimmedLabel);
  }

  private resolveStepGroup(panel: MessageMetaPanel): StepGroupInfo {
    const normalizedGroup = panel.group?.trim() || "";
    const normalizedGroupLabel = panel.groupLabel?.trim() || "";
    if (this.isWebSearchPanel(panel)) {
      return {
        group: "web-search",
        label: "联网搜索"
      };
    }

    if (
      normalizedGroup === "deep-thinking"
      || normalizedGroupLabel === "深度思考"
      || this.isDeepThinkingPanel(panel)
    ) {
      return {
        group: "deep-thinking",
        label: "深度思考"
      };
    }

    return {
      group: normalizedGroup || "deep-thinking",
      label: normalizedGroupLabel || "深度思考"
    };
  }

  private renderMetaPanelBody(bodyEl: HTMLElement, panel: RenderedMetaPanelBlock): void {
    bodyEl.empty();
    if (panel.sections?.length) {
      for (const section of panel.sections) {
        const sectionEl = bodyEl.createDiv({ cls: "sidet-message-meta-panel-step" });
        const sectionLabel = section.label?.trim() ?? "";
        if (this.shouldRenderMetaStepLabel(panel, sectionLabel)) {
          sectionEl.createDiv({
            cls: "sidet-message-meta-panel-step-label",
            text: sectionLabel
          });
        }
        if (section.text?.trim()) {
          const textEl = sectionEl.createDiv({ cls: "sidet-message-meta-panel-text" });
          textEl.textContent = section.text.trim();
        }
        if (section.sources?.length) {
          if (section.text?.trim()) {
            sectionEl.addClass("has-text-before-sources");
          }
          this.renderMetaPanelSources(sectionEl, section.sources);
        }
      }
      return;
    }

    if (panel.text?.trim()) {
      const textEl = bodyEl.createDiv({ cls: "sidet-message-meta-panel-text" });
      textEl.textContent = panel.text.trim();
    }

    if (!panel.sources?.length) {
      return;
    }

    this.renderMetaPanelSources(bodyEl, panel.sources);
  }

  private shouldRenderMetaStepLabel(panel: RenderedMetaPanelBlock, label: string): boolean {
    if (!label) {
      return false;
    }

    if (panel.kind === "group:deep-thinking") {
      if (HIDDEN_DEEP_THINKING_STEP_LABELS.has(label)) {
        return false;
      }
      if (/^网页搜索\s+\d+$/.test(label)) {
        return false;
      }
      return true;
    }

    if (panel.kind === "group:web-search") {
      if (HIDDEN_WEB_SEARCH_STEP_LABELS.has(label)) {
        return false;
      }
      if (/^网页搜索\s+\d+$/.test(label)) {
        return false;
      }
      return true;
    }

    return true;
  }

  private renderMetaPanelSources(parentEl: HTMLElement, sources: NonNullable<MessageMetaPanel["sources"]>): void {
    const listEl = parentEl.createDiv({ cls: "sidet-message-meta-panel-sources" });
    for (const source of sources) {
      const itemEl = listEl.createDiv({ cls: "sidet-message-meta-panel-source" });
      const titleEl = itemEl.createDiv({ cls: "sidet-message-meta-panel-source-title" });
      if (source.url) {
        titleEl.createEl("a", {
          text: source.title,
          href: source.url
        });
      } else {
        titleEl.setText(source.title);
      }

      if (source.host || source.note) {
        const metaEl = itemEl.createDiv({ cls: "sidet-message-meta-panel-source-meta" });
        const parts = [source.host, source.note].filter(Boolean);
        metaEl.setText(parts.join(" · "));
      }
    }
  }
}
