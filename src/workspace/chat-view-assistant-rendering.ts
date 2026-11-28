import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { parseWebSearchImportLink } from "../context/web-search-service";
import type { ConversationRecord, MessageMetaPanel, MessageRecord, MessageSource } from "../types";
import { recordChatRenderTrace } from "./chat-view-render-trace";
import { recordChatScrollTrace } from "./chat-scroll-trace";
import {
  findAssistantAnswerActions,
  findAssistantAnswerVersions,
  findAssistantInlineActions,
  findAssistantLinks,
  findAssistantMessageContent,
  findAssistantMetaPanels,
  findAssistantMetaPanelParts,
  findAssistantStatusLines
} from "./assistant-message-dom";
import { decorateCitationMarkers } from "./chat-view-citation-dom";
import { hasPartialErrorContent } from "./chat-view-answer-presentation";
import { installSmoothDetailsToggle } from "./details-smooth-toggle";
import {
  buildProcessStreamLayout,
  getAssistantDisplayText as getProcessAssistantDisplayText,
  getAssistantTrailingTextOffset,
  stripAssistantProcessText,
  supportsProcessStream
} from "./assistant-process-events";
import {
  buildMetaPanelSignature,
  buildMetaPanelTextSignature,
  isElementVerticallyVisible,
  shouldFlushStreamingMarkdown,
  shouldRenderMetaPanelBody,
  shouldUpdateMetaPanelPreview,
  STREAMING_MARKDOWN_MIN_CHARS,
  STREAMING_MARKDOWN_MIN_INTERVAL_MS
} from "./chat-view-render-policy";
import type { AnswerSourceTarget } from "./chat-view-source-modal";

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export interface PendingStreamingMarkdownRender {
  contentEl: HTMLDivElement;
  markdown: string;
  conversationId: string;
  messageId: string;
  /** 发起渲染时的正文起点；动作面板插入会改它。 */
  textOffset?: number;
}

interface RenderAssistantMarkdownOptions {
  conversationId: string;
  renderGeneration: number;
  messageId?: string;
  requireStreaming?: boolean;
  staged?: boolean;
  managedScrollRestore?: boolean;
  streaming?: boolean;
  /** 流式渲染发起时的正文起点；完成时起点变了就丢弃这次结果。 */
  expectedTextOffset?: number;
  /** 发起渲染时的回答版本；切换版本后旧版本的异步渲染必须丢弃。 */
  expectedAnswerVariantIndex?: number;
  sources?: MessageSource[];
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
  refreshPinnedToBottom?: () => void;
  /** 用户开合过程面板 / 来源等折叠块；参数为开启方向。 */
  onUserContentToggle?: (open: boolean) => void;
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
  renderMarkdown: (parentEl: HTMLElement, markdown: string) => void;
  renderInlineToolAction: (parentEl: HTMLElement, conversation: ConversationRecord, message: MessageRecord) => void;
  renderWikiMaintenancePlanAction: (
    parentEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ) => void;
  renderAnswerSources: (parentEl: HTMLElement, message: MessageRecord) => void;
  renderAnswerActions: (
    parentEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ) => void;
  importWebSearchResultUrl: (url: string) => void;
  openSourceModal: (target: AnswerSourceTarget) => void;
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

type RenderedProcessBlock =
  | { type: "panel"; key: string; panel: RenderedMetaPanelBlock }
  | { type: "text"; key: string; text: string };

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
  private bottomFollowIntentUntil = 0;
  private bottomAnchorRequestVersion = 0;
  private lastStreamingMarkdownLength = 0;
  private lastContentHeight: number | null = null;
  private suppressContentResizeUntil = 0;
  private strippedTextCache: {
    messageId: string;
    textLength: number;
    textOffset: number;
    variantIndex: number;
    status: MessageRecord["status"];
    text: string;
  } | null = null;
  private readonly metaPanelStates = new WeakMap<HTMLDetailsElement, {
    panel: RenderedMetaPanelBlock;
    signature: string;
    lastPreviewAt: number;
    lastBodyAt: number;
    bodyStale: boolean;
  }>();

  constructor(private readonly options: ChatViewAssistantRenderingOptions) {}

  release(): void {
    this.cancelStreamingMessagePatch();
    this.cancelBottomFollow();
    this.resetStreamingMarkdownRenderer();
    this.bottomFollowProgrammaticScrollTop = null;
    this.bottomFollowIntentUntil = 0;
    this.strippedTextCache = null;
  }

  /**
   * 消息内容自身高度变化（展开 / 收起、切换回答版本、图片与异步 Markdown 补齐）
   * 时，贴底阅读继续保持贴底；非贴底阅读保持原位。
   *
   * ResizeObserver 在绘制前回调，这里同步把滚动位置补到新底部：底栏与操作排
   * 原地不动，新增空间从上方推出，缩短时底部同样不动。若改成下一帧平滑追底，
   * 底部会先被顶出去一帧再追回来，形成可见闪烁。手动收起期间仍由调用方抑制。
   */
  handleContentResize(): void {
    const scrollHost = this.options.getScrollHost();
    const height = scrollHost.scrollHeight;
    const previousHeight = this.lastContentHeight;
    this.lastContentHeight = height;
    if (nowMs() < this.suppressContentResizeUntil) {
      return;
    }
    if (previousHeight === null || height === previousHeight) {
      return;
    }
    if (!this.options.getScrollPinnedToBottom()) {
      return;
    }
    this.cancelBottomFollow();
    this.options.setScrollHostTop(this.options.getScrollBottomTarget(scrollHost));
    this.options.setScrollPinnedToBottom(true);
    this.options.syncScrollAffordances();
  }

  /** 建立高度基线；首次渲染 / 重新观察列表时调用，避免把初始挂载当成变高。 */
  resetContentHeightBaseline(): void {
    this.lastContentHeight = this.options.getScrollHost().scrollHeight;
  }

  /** 卡片手动收展期间临时压住高度跟随，避免动画与贴底滚动互相抢。 */
  suppressContentResizeFollow(durationMs = 240): void {
    this.suppressContentResizeUntil = nowMs() + Math.max(0, durationMs);
  }

  handleScroll(scrollTop: number): boolean {
    // 用户动作触发的展开 / 版本切换：内容变化期间浏览器会因夹紧、重排产生
    // 滚动事件，它们不是用户滚动。真实手势（滚轮 / 触摸）会提前解除锁定。
    if (nowMs() < this.bottomFollowIntentUntil) {
      this.options.setScrollPinnedToBottom(true);
      return true;
    }
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

  /**
   * 在用户动作开始前锁定「继续贴底」的意图：期间布局引起的滚动事件不清 pin，
   * 内容增长仍走现有贴底跟随。用户真实手势由视图层调用 release 解除。
   */
  holdBottomFollowIntent(durationMs = 900): void {
    this.bottomFollowIntentUntil = nowMs() + Math.max(0, durationMs);
    this.options.setScrollPinnedToBottom(true);
  }

  releaseBottomFollowIntent(): void {
    this.bottomFollowIntentUntil = 0;
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
      pendingScrollIntent: "none" | "after-send" | "conversation-switch-or-initial-open" | "reveal-message";
    },
    callbacks: {
      clearPendingScrollIntent: () => void;
    }
  ): { lastConversationId: string | null; lastMessageRevision: string | null } {
    if (state.pendingScrollIntent === "reveal-message") {
      callbacks.clearPendingScrollIntent();
      return {
        lastConversationId: conversationId,
        lastMessageRevision: messageRevision
      };
    }

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

  /**
   * 键盘表面动画期间，底部留白每帧都由 composer 的实时位置重算。
   * 这里在同一帧把滚动补到新底部，让内容与输入框成为同一条运动；
   * 若改成下一帧平滑追底，内容会滞后一截再慢慢爬回来（真机实测峰值 120px）。
   * 不走滚动 trace，避免每次留白变化把诊断缓冲刷满。
   */
  anchorBottomForKeyboardPresentation(): void {
    const scrollHost = this.options.getScrollHost();
    this.cancelBottomFollow();
    this.options.setScrollHostTop(this.options.getScrollBottomTarget(scrollHost));
    this.options.setScrollPinnedToBottom(true);
    this.options.syncScrollAffordances();
  }

  setPendingAssistantPlaceholder(contentEl: HTMLDivElement): void {
    if (contentEl.classList.contains("is-pending-reply") && contentEl.querySelector(".sidet-pending-reply-dots")) {
      return;
    }
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
    this.lastStreamingMarkdownLength = 0;
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

    const lastMessage = conversation.messages[conversation.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      return false;
    }

    // 编辑态可能隐藏了更早的消息；以最后一条消息的 DOM 身份判断补丁面，
    // 不再要求子节点数与消息总数一致。
    const lastItemEl = messagesListEl.lastElementChild;
    if (!lastItemEl || lastItemEl.getAttribute("data-message-id") !== lastMessage.id) {
      return false;
    }

    if ((lastMessage.attachments?.length ?? 0) > 0) {
      return false;
    }

    return lastMessage.status === "streaming" || lastMessage.status === "done";
  }

  patchLatestAssistantMessage(): boolean {
    const patchStartedAt = nowMs();
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
    if (lastItemEl.getAttribute("data-message-id") !== lastMessage.id) {
      return false;
    }

    const contentEl = findAssistantMessageContent(lastItemEl);
    if (!(contentEl instanceof HTMLDivElement)) {
      return false;
    }

    const displayText = this.getAssistantDisplayText(lastMessage);
    lastItemEl.classList.remove("-user");
    lastItemEl.classList.add("-assistant");
    lastItemEl.classList.toggle("-error", lastMessage.status === "error");
    findAssistantInlineActions(lastItemEl).forEach((element) => {
      element.remove();
    });
    findAssistantAnswerVersions(lastItemEl).forEach((element) => {
      element.remove();
    });
    findAssistantAnswerActions(lastItemEl).forEach((element) => {
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
        messageId: lastMessage.id,
        textOffset: getAssistantTrailingTextOffset(lastMessage)
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
        messageId: lastMessage.id,
        expectedAnswerVariantIndex: lastMessage.activeAnswerVariantIndex ?? 0,
        // 完成态补丁（重新生成收尾 / 切换更长版本）不要在渲染期间先清空正文：
        // 内容塌缩会让贴底位置被浏览器夹紧并丢失 pinned，长回答切换后停在半空。
        staged: true,
        sources: lastMessage.sources
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

    this.options.renderAnswerSources(lastItemEl, lastMessage);
    this.options.renderWikiMaintenancePlanAction(lastItemEl, conversation, lastMessage);
    this.options.renderInlineToolAction(lastItemEl, conversation, lastMessage);
    this.options.renderAnswerActions(lastItemEl, conversation, lastMessage);
    recordChatRenderTrace("assistant-patch", {
      durationMs: Math.round((nowMs() - patchStartedAt) * 10) / 10,
      messageId: lastMessage.id,
      streaming: isStreaming,
      markdownLength: displayText.length,
      metaPanelCount: lastMessage.metaPanels?.length ?? 0
    });
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

  /** 失败兜底只复核生成代 / 会话 / 回答版本，不要求目标是最新一条消息。 */
  private isStaleAnswerVariantRender(options: RenderAssistantMarkdownOptions): boolean {
    if (
      options.renderGeneration !== this.options.getMarkdownRenderGeneration()
      || this.options.getCurrentConversationId() !== options.conversationId
      || options.expectedAnswerVariantIndex === undefined
    ) {
      return options.renderGeneration !== this.options.getMarkdownRenderGeneration()
        || this.options.getCurrentConversationId() !== options.conversationId;
    }
    const conversation = this.options.getConversationById(options.conversationId);
    const message = options.messageId
      ? conversation?.messages.find((item) => item.id === options.messageId) ?? null
      : conversation?.messages[conversation.messages.length - 1] ?? null;
    return message !== null
      && (message.activeAnswerVariantIndex ?? 0) !== options.expectedAnswerVariantIndex;
  }

  /** 异步渲染完成时复核：生成代、会话、消息、流式状态、正文起点与回答版本都没变。 */
  private isStaleAssistantRender(options: RenderAssistantMarkdownOptions): boolean {
    if (
      options.renderGeneration !== this.options.getMarkdownRenderGeneration()
      || this.options.getCurrentConversationId() !== options.conversationId
    ) {
      return true;
    }
    if (!options.messageId && !options.requireStreaming) {
      return false;
    }
    const currentConversation = this.options.getConversationById(options.conversationId);
    const currentLastMessage = currentConversation?.messages[currentConversation.messages.length - 1] ?? null;
    if (
      currentLastMessage?.id !== options.messageId
      || (options.requireStreaming && currentLastMessage?.status !== "streaming")
    ) {
      return true;
    }
    // 动作面板插入后，正文起点会变；在途的流式渲染不能再把旧正文换回来。
    if (
      options.expectedTextOffset !== undefined
      && currentLastMessage
      && getAssistantTrailingTextOffset(currentLastMessage) !== options.expectedTextOffset
    ) {
      return true;
    }
    return options.expectedAnswerVariantIndex !== undefined
      && currentLastMessage !== null
      && (currentLastMessage.activeAnswerVariantIndex ?? 0) !== options.expectedAnswerVariantIndex;
  }

  private getAssistantDisplayText(message: MessageRecord): string {
    const textOffset = getAssistantTrailingTextOffset(message);
    if (
      this.strippedTextCache
      && this.strippedTextCache.messageId === message.id
      && this.strippedTextCache.textLength === message.text.length
      && this.strippedTextCache.textOffset === textOffset
      && this.strippedTextCache.variantIndex === (message.activeAnswerVariantIndex ?? 0)
      && this.strippedTextCache.status === message.status
    ) {
      return this.strippedTextCache.text;
    }
    const text = getProcessAssistantDisplayText(message);
    this.strippedTextCache = {
      messageId: message.id,
      textLength: message.text.length,
      textOffset,
      variantIndex: message.activeAnswerVariantIndex ?? 0,
      status: message.status,
      text
    };
    return text;
  }

  shouldRenderAssistantMarkdown(message: MessageRecord): boolean {
    if (message.role !== "assistant" || !message.text.trim()) {
      return false;
    }
    return message.status === "done" || (message.status === "error" && hasPartialErrorContent(message));
  }

  async renderAssistantMarkdown(
    contentEl: HTMLDivElement,
    markdown: string,
    renderComponent: Component,
    options: RenderAssistantMarkdownOptions
  ): Promise<void> {
    const renderStartedAt = nowMs();
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
        // 流式阶段只保留正文；链接解析与角标装饰留到 done 的最终渲染，
        // 避免每次 flush 都遍历整棵树。
        if (!options.streaming) {
          this.hydrateSpecialLinks(renderTarget);
          decorateCitationMarkers(
            renderTarget,
            options.sources ?? [],
            (target) => this.options.openSourceModal(target)
          );
        }
      }
    } catch (error) {
      recordChatRenderTrace("assistant-markdown-error", {
        durationMs: Math.round((nowMs() - renderStartedAt) * 10) / 10,
        markdownLength: markdown.length,
        streaming: Boolean(options.streaming)
      });
      console.error("Sidet：渲染 AI Markdown 失败", error);
      // 失败路径也不能把已切换走的旧版本写回仍然存活的容器；非最新消息的
      // 容器本身仍归它自己，不受「最后一条」检查影响。
      if (!this.isStaleAnswerVariantRender(options)) {
        this.options.setPlainMessageContent(contentEl, markdown);
      }
      return;
    }

    recordChatRenderTrace("assistant-markdown", {
      durationMs: Math.round((nowMs() - renderStartedAt) * 10) / 10,
      markdownLength: markdown.length,
      streaming: Boolean(options.streaming),
      staged: Boolean(options.staged),
      sourceCount: options.sources?.length ?? 0
    });

    if (this.isStaleAssistantRender(options)) {
      return;
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

  /** 用户把流式消息滚回视口时补一次刷新；离屏期间跳过的 Markdown 不再等待下一块 chunk。 */
  refreshStreamingMarkdownAfterScroll(): void {
    if (this.pendingStreamingMarkdownRender) {
      this.scheduleStreamingMarkdownRender(this.pendingStreamingMarkdownRender);
    }
  }

  private scheduleStreamingMarkdownRender(render: PendingStreamingMarkdownRender): void {
    this.pendingStreamingMarkdownRender = render;
    if (this.streamingMarkdownRenderInFlight || this.streamingMarkdownRenderTimer !== null) {
      return;
    }

    const elapsed = Date.now() - this.lastStreamingMarkdownRenderAt;
    const growth = render.markdown.length - this.lastStreamingMarkdownLength;
    if (!shouldFlushStreamingMarkdown({
      charsSinceLastFlush: growth,
      elapsedMs: elapsed,
      visible: this.isMessageVisible(render.contentEl),
      pinnedToBottom: this.options.getScrollPinnedToBottom()
    })) {
      return;
    }

    const delay = growth >= STREAMING_MARKDOWN_MIN_CHARS
      ? 0
      : Math.max(0, STREAMING_MARKDOWN_MIN_INTERVAL_MS - elapsed);
    this.streamingMarkdownRenderTimer = window.setTimeout(() => {
      this.streamingMarkdownRenderTimer = null;
      this.streamingMarkdownRenderInFlight = true;
      window.requestAnimationFrame(() => {
        void this.flushStreamingMarkdownRender();
      });
    }, delay);
  }

  private isMessageVisible(contentEl: HTMLElement): boolean {
    const host = this.options.getScrollHost();
    const itemRect = contentEl.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return isElementVerticallyVisible({
      itemTop: itemRect.top,
      itemBottom: itemRect.bottom,
      hostTop: hostRect.top,
      hostBottom: hostRect.bottom
    });
  }

  private async flushStreamingMarkdownRender(): Promise<void> {
    const render = this.pendingStreamingMarkdownRender;
    if (!render) {
      this.streamingMarkdownRenderInFlight = false;
      return;
    }

    this.pendingStreamingMarkdownRender = null;
    this.lastStreamingMarkdownRenderAt = Date.now();
    this.lastStreamingMarkdownLength = render.markdown.length;
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
      staged: true,
      streaming: true,
      expectedTextOffset: render.textOffset,
      sources: currentLastMessage.sources
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

  private buildProcessStreamBlocks(message: MessageRecord): {
    statusLines: RenderedStatusLine[];
    blocks: RenderedProcessBlock[];
  } | null {
    if (!supportsProcessStream(message)) {
      return null;
    }

    const layout = buildProcessStreamLayout(message);
    const blocks: RenderedProcessBlock[] = [];
    for (const event of layout.events) {
      if (event.type === "reasoning") {
        blocks.push({
          type: "panel",
          key: event.key,
          panel: {
            kind: event.key,
            label: event.label,
            text: event.text
          }
        });
      } else if (event.type === "panel") {
        blocks.push({
          type: "panel",
          key: event.key,
          panel: {
            kind: event.panel.kind,
            label: event.panel.label.trim() || "过程",
            text: event.panel.text,
            sources: event.panel.sources
          }
        });
      } else {
        blocks.push({
          type: "text",
          key: event.key,
          text: event.text
        });
      }
    }

    return {
      statusLines: layout.statusLines,
      blocks
    };
  }

  syncMetaBlocks(
    itemEl: HTMLDivElement,
    contentEl: HTMLDivElement,
    message: MessageRecord
  ): void {
    const streamBlocks = this.buildProcessStreamBlocks(message);
    const layout = streamBlocks ? null : this.buildMetaLayout(message);
    const nextStatusLines = streamBlocks?.statusLines ?? layout?.statusLines ?? [];
    const nextBlocks: RenderedProcessBlock[] = streamBlocks?.blocks
      ?? (layout?.panels ?? []).map((panel) => ({
        type: "panel" as const,
        key: panel.kind,
        panel
      }));
    const existingStatusLines = findAssistantStatusLines(itemEl);
    const existingPanels = findAssistantMetaPanels(itemEl);
    const existingTextBlocks = Array.from(
      itemEl.querySelectorAll<HTMLElement>(".sidet-process-text[data-process-text-key]")
    );
    if (nextStatusLines.length === 0 && nextBlocks.length === 0) {
      existingStatusLines.forEach((line) => line.remove());
      existingPanels.forEach((panel) => panel.remove());
      existingTextBlocks.forEach((block) => block.remove());
      return;
    }

    const panelByKind = new Map<string, HTMLDetailsElement>();
    existingPanels.forEach((panel) => {
      if (panel.instanceOf(HTMLDetailsElement)) {
        const kind = panel.getAttribute("data-panel-kind");
        if (kind) {
          panelByKind.set(kind, panel);
        }
      }
    });

    const textBlockByKey = new Map<string, HTMLElement>();
    existingTextBlocks.forEach((block) => {
      const key = block.getAttribute("data-process-text-key");
      if (key) {
        textBlockByKey.set(key, block);
      }
    });

    const streaming = message.status === "streaming";
    const now = Date.now();
    const syncStartedAt = nowMs();
    let bodyBuildCount = 0;
    let previewUpdateCount = 0;
    const orderedBlockEls: HTMLElement[] = [];
    for (const block of nextBlocks) {
      if (block.type === "text") {
        const existingTextBlock = textBlockByKey.get(block.key);
        if (existingTextBlock) {
          textBlockByKey.delete(block.key);
        }
        const displayText = stripAssistantProcessText(block.text);
        if (!displayText.trim()) {
          existingTextBlock?.remove();
          continue;
        }
        let textEl = existingTextBlock;
        if (!textEl) {
          textEl = itemEl.ownerDocument.createElement("div");
          textEl.className = "sidet-process-text markdown-rendered";
          textEl.setAttribute("data-process-text-key", block.key);
        }
        const textSignature = `${displayText.length}:${displayText.slice(-48)}`;
        if (textEl.getAttribute("data-render-signature") !== textSignature) {
          textEl.empty();
          textEl.setAttribute("data-render-signature", textSignature);
          this.options.renderMarkdown(textEl, displayText);
        }
        if (textEl.parentElement !== itemEl) {
          itemEl.insertBefore(textEl, contentEl);
        }
        orderedBlockEls.push(textEl);
        continue;
      }

      const panel = block.panel;
      const panelKey = block.key;
      let detailsEl = panelByKind.get(panelKey);
      let shouldBuildContent = false;
      if (detailsEl) {
        panelByKind.delete(panelKey);
        const existingParts = findAssistantMetaPanelParts(detailsEl);
        shouldBuildContent = !existingParts.iconEl
          || !existingParts.previewEl
          || !existingParts.bodyEl;
      } else {
        detailsEl = itemEl.ownerDocument.createElement("details");
        detailsEl.className = "sidet-message-meta-panel";
        detailsEl.setAttribute("data-panel-kind", panelKey);
        shouldBuildContent = true;
      }

      detailsEl.classList.add("sidet-message-meta-panel");
      detailsEl.setAttribute("data-panel-kind", panelKey);

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
        const bodyEl = detailsEl.querySelector<HTMLElement>(":scope > .sidet-message-meta-panel-body");
        if (bodyEl) {
          const renderBody = (): void => {
            const current = this.metaPanelStates.get(detailsEl);
            if (!current) {
              return;
            }
            this.renderMetaPanelBody(bodyEl, current.panel);
            current.lastBodyAt = Date.now();
            current.bodyStale = false;
          };
          detailsEl.addEventListener("toggle", () => {
            if (detailsEl.open) {
              renderBody();
            }
          });
          installSmoothDetailsToggle(detailsEl, {
            bodyEl,
            onToggle: (open) => {
              this.options.onUserContentToggle?.(open);
            }
          });
        }
      }

      const panelParts = findAssistantMetaPanelParts(detailsEl);
      const panelTextSignature = buildMetaPanelTextSignature(panel.text, streaming);
      const sectionSignatures = panel.sections?.map((section) => ({
        label: section.label,
        textSignature: buildMetaPanelTextSignature(section.text, streaming),
        sourceCount: section.sources?.length ?? 0
      }));
      const signature = buildMetaPanelSignature({
        label: panel.label,
        textSignature: panelTextSignature,
        sections: sectionSignatures,
        sources: panel.sources?.map((source) => ({
          title: source.title,
          url: source.url
        }))
      });
      let panelState = this.metaPanelStates.get(detailsEl);
      if (!panelState) {
        panelState = {
          panel,
          signature: "",
          lastPreviewAt: 0,
          lastBodyAt: 0,
          bodyStale: true
        };
        this.metaPanelStates.set(detailsEl, panelState);
      }
      panelState.panel = panel;
      const signatureChanged = signature !== panelState.signature;

      if (panelParts.labelEl instanceof HTMLElement && panelParts.labelEl.textContent !== panel.label) {
        panelParts.labelEl.textContent = panel.label;
      }

      if (
        panelParts.previewEl instanceof HTMLElement
        && shouldUpdateMetaPanelPreview({
          signatureChanged,
          elapsedMs: now - panelState.lastPreviewAt,
          streaming
        })
      ) {
        const nextPreviewText = this.getMetaPanelPreviewText(
          panel,
          panelParts.previewEl.textContent ?? "",
          streaming
        );
        if (nextPreviewText !== null) {
          panelParts.previewEl.textContent = nextPreviewText;
        }
        panelState.lastPreviewAt = now;
        previewUpdateCount += 1;
      }

      if (signatureChanged) {
        panelState.signature = signature;
        panelState.bodyStale = true;
      }

      if (
        panelParts.bodyEl instanceof HTMLElement
        && shouldRenderMetaPanelBody({
          signatureChanged: panelState.bodyStale,
          open: detailsEl.open,
          elapsedMs: now - panelState.lastBodyAt,
          streaming
        })
      ) {
        const previousBodyScrollTop = panelParts.bodyEl.scrollTop;
        this.renderMetaPanelBody(panelParts.bodyEl, panel);
        // 展开体内部滚动是用户的阅读位置；流式更新只接着写，不把内部视口拉回顶部。
        if (previousBodyScrollTop > 0) {
          panelParts.bodyEl.scrollTop = previousBodyScrollTop;
        }
        panelState.lastBodyAt = now;
        panelState.bodyStale = false;
        bodyBuildCount += 1;
      }

      if (detailsEl.parentElement !== itemEl) {
        itemEl.insertBefore(detailsEl, contentEl);
      }
      orderedBlockEls.push(detailsEl);
    }

    // 事件流按顺序插到正文前：每次同步都按列表重排，避免多块时只挪一格又打乱顺序。
    for (const blockEl of orderedBlockEls) {
      itemEl.insertBefore(blockEl, contentEl);
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

    const statusAnchor: Element = orderedBlockEls[0] ?? contentEl;
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
      if (lineEl.nextElementSibling !== statusAnchor) {
        itemEl.insertBefore(lineEl, statusAnchor);
      }
    }

    statusLineByKind.forEach((lineEl) => lineEl.remove());
    panelByKind.forEach((panelEl) => panelEl.remove());
    textBlockByKey.forEach((textEl) => textEl.remove());
    recordChatRenderTrace("meta-panels", {
      durationMs: Math.round((nowMs() - syncStartedAt) * 10) / 10,
      panelCount: nextBlocks.filter((block) => block.type === "panel").length,
      textBlockCount: nextBlocks.filter((block) => block.type === "text").length,
      bodyBuildCount,
      previewUpdateCount,
      streaming
    });
  }

  private getMetaPanelPreviewText(
    panel: RenderedMetaPanelBlock,
    previousPreview: string,
    streaming: boolean
  ): string | null {
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
    // 流式时才需要「稳定文本」避免抖动；终态要展示完整尾部，否则以 URL /
    // 路径 / key: value 结尾的最后一行会被永久截掉。
    const stableText = streaming
      ? this.getStableStreamingText(text, previousPreview)
      : text;
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
