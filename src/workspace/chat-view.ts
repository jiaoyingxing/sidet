import {
  Component,
  ItemView,
  MarkdownRenderer,
  Platform,
  WorkspaceLeaf,
  setIcon,
  setTooltip,
  type ViewStateResult
} from "obsidian";
import {
  CHAT_VIEW_ICON,
  CHAT_VIEW_TYPE
} from "../constants";
import type {
  ChatLeafState,
  MessageRecord
} from "../types";
import { openChatModelMenu } from "./chat-model-menu";
import { ComposerModal } from "./composer-modal";
import { releaseDesktopPaneMinWidthIfUnused, resolveDesktopPaneItemElement } from "./desktop-pane-min-width";
import { createIconButton } from "./icon-button";
import { syncLeafHeaderTitle } from "./leaf-header";
import { createSendButtonControl, type SendButtonControl } from "./send-button";
import { WorkspaceController } from "./workspace-controller";
import { ChatViewInlineSuggests } from "./chat-view-inline-suggests";
import { ChatViewMessageActions } from "./chat-view-message-actions";
import { ChatViewAssistantActions } from "./chat-view-assistant-actions";
import { ChatViewAssistantRendering } from "./chat-view-assistant-rendering";
import { hasPartialErrorContent } from "./chat-view-answer-presentation";
import { ChatViewSourceModal, type AnswerSourceTarget } from "./chat-view-source-modal";
import { ChatViewMobileComposer } from "./chat-view-mobile-composer";
import {
  recordMobileInputProbeSample,
  resetMobileInputProbe
} from "./chat-view-mobile-input-probe";
import { ChatViewContextIntake } from "./chat-view-context-intake";
import { ChatViewDraftRuntime } from "./chat-view-draft-runtime";
import {
  CHAT_HOME_CAPABILITY_LABELS,
  renderChatHome,
  setChatHomeCapabilitySelected,
  type ChatHomeCapability,
  type ChatHomeCapabilityId
} from "./chat-home";
import {
  ChatViewConversationRuntime,
  type ChatViewScrollIntent
} from "./chat-view-conversation-runtime";
import {
  readMobileHomeElementSignature,
  recordMobileHomeLifecycleDiagnostic,
  type MobileHomeDiagnosticRect,
  type MobileHomeInputLifecycleExtras,
  type MobileHomeTailEventObservation
} from "./chat-view-mobile-home-lifecycle-diagnostics";
import {
  isMobileHomeRestGeometryDisplaced,
  type MobileHomeRestGeometry
} from "./chat-view-mobile-home-rest-geometry";
import {
  resolveHomeComposerInline,
  resolveHomeComposerSlot,
  resolveHomeComposerSlotHeight,
  resolveScrollBottomTarget,
  shouldShowScrollBottomButton
} from "./chat-view-layout-metrics";
import { haltMobileScrollMomentum } from "./chat-view-mobile-scroll-momentum";

type ChatMenuKind = "context" | "message" | "model";

let chatViewOriginCounter = 0;

// Bounded tail-event observation for delayed-blur diagnosis: after a native
// activation journey starts, capture-phase click / contextmenu events are
// recorded (no behavior change) so a future real-device failure can name the
// leaf-invariant focus owner.
const MOBILE_TAIL_OBSERVATION_WINDOW_MS = 4000;
const MOBILE_TAIL_OBSERVATION_ARM_EVENTS = new Set([
  "native.activation.pending",
  "native.pointerup.accepted",
  "native.pointerup.focused",
  "focus.event",
  "layer.change.active"
]);

function readMobileHomeDiagnosticRect(
  element: Element | null
): MobileHomeDiagnosticRect | null {
  if (!element?.isConnected) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return {
    top: roundMobileHomeDiagnosticNumber(rect.top),
    right: roundMobileHomeDiagnosticNumber(rect.right),
    bottom: roundMobileHomeDiagnosticNumber(rect.bottom),
    left: roundMobileHomeDiagnosticNumber(rect.left),
    width: roundMobileHomeDiagnosticNumber(rect.width),
    height: roundMobileHomeDiagnosticNumber(rect.height)
  };
}

function normalizeMobileHomeDiagnosticNumber(
  value: number | undefined
): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? roundMobileHomeDiagnosticNumber(value)
    : null;
}

function roundMobileHomeDiagnosticNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * ChatView 是聊天页壳，不是所有 UI 状态的容器。阅读顺序：
 * 1. 视图生命周期 / 叶子状态：ensureViewReady、renderViewState、handleLeafStateChange、onClose。
 * 2. 消息区 / 滚动：assistantRendering、getScrollHost、updatePinnedToBottom、syncScrollAffordances。
 * 3. 主页展示态：renderHome、buildHomeCapabilities、homeComposerSlotEl、syncHomeComposerPosition。
 * 4. Composer / 发送：draftRuntime、contextIntake、mobileComposer、syncComposer*。
 * 5. 菜单 / 浮层：openModelMenu、closeChatMenus、composerModal。
 * 6. 移动输入 / 诊断：chat-view-mobile-* helper；mobileHome* 字段只服务诊断与锚点。
 * 7. 监听器生命周期：bindRuntimeListeners 把清理函数压入 disposeCallbacks，onClose 统一执行。
 *
 * 修改前先确认字段归属；不要把主页槽位、滚动或菜单状态搬进消息渲染 helper。
 */
export class ChatView extends ItemView {
  private static readonly DESKTOP_MIN_LEAF_WIDTH = 440;
  private static readonly DESKTOP_BOTTOM_MESSAGE_GAP = 8;
  private static readonly BOTTOM_PIN_THRESHOLD = 40;
  private static readonly CHAT_LEAF_CONTENT_CLASS = "sidet-chat-leaf-content";
  private unsubscribe: (() => void) | null = null;
  private unsubscribeAssistantChunk: (() => void) | null = null;
  private viewStateUnsubscribe: (() => void) | null = null;
  private rootEl: HTMLDivElement | null = null;
  private messagesEl: HTMLDivElement | null = null;
  private messagesListEl: HTMLDivElement | null = null;
  private messagesBottomSpacerEl: HTMLDivElement | null = null;
  private composerWrapEl: HTMLDivElement | null = null;
  private composerEl: HTMLDivElement | null = null;
  private attachmentStripEl: HTMLDivElement | null = null;
  private composerInputShellEl: HTMLDivElement | null = null;
  private composerInputWrapEl: HTMLDivElement | null = null;
  private textareaEl: HTMLTextAreaElement | null = null;
  private textareaMirrorEl: HTMLDivElement | null = null;
  private mobileExpandButtonEl: HTMLButtonElement | null = null;
  private sendButtons: SendButtonControl[] = [];
  private scrollBottomButtonEl: HTMLButtonElement | null = null;
  private scrollPinnedToBottom = true;
  /** 移动聚焦开始时的贴底快照：决定键盘落定后是否跟随到底部。 */
  private mobileFocusPinnedToBottom = false;
  /** 键盘让位期间用户自己动手（滚轮 / 触摸 / 按下）后取消本次跟随。 */
  private mobileFocusFollowCancelled = false;
  private mobileInputProbeTimer: number | null = null;
  private mobileInputProbeStopTimer: number | null = null;
  private lastFocusComposerNonce = 0;
  private disposeCallbacks: Array<() => void> = [];
  private composerModal: ComposerModal | null = null;
  private modelMenuClose: (() => void) | null = null;
  private modelMenuAnchorEl: HTMLElement | null = null;
  private messageRenderComponents: Component[] = [];
  private messageHighlightTimer: number | null = null;
  private composerResizeObserver: ResizeObserver | null = null;
  private messageListResizeObserver: ResizeObserver | null = null;
  private homeComposerSlotEl: HTMLDivElement | null = null;
  private homeCapabilityRowEl: HTMLDivElement | null = null;
  private homeCapabilityEls = new Map<ChatHomeCapabilityId, HTMLDivElement>();
  private homeComposerPositionFrame: number | null = null;
  private mobileHomeWorkspaceAnchor: MobileHomeRestGeometry | null = null;
  private mobileHomeLifecycleDiagnosticFrame: number | null = null;
  private pendingMobileHomeLifecycleGeometryEvent: string | null = null;
  private mobileTailObservationUntilMs = 0;
  private localDraft = "";
  private readonly draftOrigin = `chat-view-${++chatViewOriginCounter}`;
  private desktopPaneItemEl: HTMLElement | null = null;
  private readonly messageActions: ChatViewMessageActions;
  private readonly inlineSuggests: ChatViewInlineSuggests;
  private sourceModal: ChatViewSourceModal | null = null;
  private readonly assistantActions: ChatViewAssistantActions;
  private readonly assistantRendering: ChatViewAssistantRendering;
  private readonly mobileComposer: ChatViewMobileComposer;
  private readonly contextIntake: ChatViewContextIntake;
  private readonly draftRuntime: ChatViewDraftRuntime;
  private readonly conversationRuntime: ChatViewConversationRuntime;

  constructor(leaf: WorkspaceLeaf, private readonly controller: WorkspaceController) {
    super(leaf);
    this.messageActions = new ChatViewMessageActions({
      controller: this.controller,
      getLeafComposerDraft: () => this.controller.getLeafViewState(this.leaf).composerDraft,
      setLocalDraft: (draft, options) => this.setLocalDraft(draft, options),
      getDraftAttachments: () => this.contextIntake.getDraftAttachments(),
      setDraftAttachments: (attachments) => {
        this.contextIntake.setDraftAttachments(attachments);
      },
      syncDraftAttachmentChips: () => this.contextIntake.syncDraftAttachmentChips(),
      syncComposerButtons: () => this.syncComposerButtons(),
      renderConversation: () => this.renderConversation(),
      scrollMessagesToBottom: (options) => this.scrollMessagesToBottom(options),
      focusActiveComposerTextarea: () => this.focusActiveComposerTextarea(),
      getPreferredComposerTextarea: () => this.getPreferredComposerTextarea(),
      scheduleViewportSync: () => this.scheduleViewportSync(),
      isPhoneLayout: () => this.isPhoneLayout(),
      isMobileRuntime: () => this.isMobileRuntime(),
      closeOtherMenus: () => this.closeChatMenus("message"),
      getCurrentWebSearchEnabled: () => this.controller.getLeafViewState(this.leaf).webSearchEnabled
    });
    this.contextIntake = new ChatViewContextIntake({
      controller: this.controller,
      leaf: this.leaf,
      getContentEl: () => this.contentEl,
      getAttachmentStripEl: () => this.attachmentStripEl,
      getLocalDraft: () => this.draftRuntime.getLocalDraft(),
      setLocalDraft: (draft, options) => this.setLocalDraft(draft, options),
      getPreferredComposerTextarea: () => this.getPreferredComposerTextarea(),
      focusComposerTextarea: (textareaEl) => this.focusComposerTextarea(textareaEl),
      holdMobileComposerForAttachmentPicker: (durationMs) => this.holdMobileComposerForAttachmentPicker(durationMs),
      restoreComposerFocusAfterAttachment: () => this.restoreComposerFocusAfterAttachment(),
      syncComposerButtons: () => this.syncComposerButtons(),
      closeOtherMenus: () => this.closeChatMenus("context"),
      isEditingDraftActive: () => this.messageActions.isEditingDraftActive(),
      cancelEditingMessage: (options) => this.messageActions.cancelEditingMessage(options),
      removeSelectedLinkText: (match, draftSnapshot) => this.inlineSuggests.removeSelectedLinkText(match, draftSnapshot),
      openModelMenu: (anchorEl) => {
        void this.openModelMenu(anchorEl);
      }
    });
    this.inlineSuggests = new ChatViewInlineSuggests({
      controller: this.controller,
      getContainerDocument: () => this.containerEl.ownerDocument,
      getTextareaElements: (): Array<HTMLTextAreaElement | null> => [this.textareaEl],
      getPreferredComposerTextarea: () => this.getPreferredComposerTextarea(),
      getDraftAttachments: () => this.contextIntake.getDraftAttachments(),
      getLocalDraft: () => this.draftRuntime.getLocalDraft(),
      setLocalDraft: (draft, options) => this.setLocalDraft(draft, options),
      isEditingDraftActive: () => this.messageActions.isEditingDraftActive(),
      focusComposerTextarea: (textareaEl) => this.focusComposerTextarea(textareaEl),
      addMarkdownAttachment: (file) => this.contextIntake.addMarkdownAttachment(file),
      addWebpageAttachmentFromUrl: (url, options) => this.contextIntake.addWebpageAttachmentFromUrl(url, options)
    });
    this.assistantActions = new ChatViewAssistantActions({
      controller: this.controller,
      leaf: this.leaf,
      copyText: (text) => this.messageActions.copyTextToClipboard(text),
      renderMarkdown: (parentEl, markdown) => this.renderAnswerMarkdown(parentEl, markdown),
      onCardToggle: (expanded) => this.handleContentToggle(expanded),
      onDetailsToggle: (open) => this.handleContentToggle(open),
      onBeforeUserContentChange: () => {
        this.holdBottomIntentForUserAction();
      }
    });
    this.assistantRendering = new ChatViewAssistantRendering({
      getApp: () => this.controller.getApp(),
      addChild: (component) => this.addChild(component),
      trackMessageRenderComponent: (component) => {
        this.messageRenderComponents.push(component);
      },
      getScrollHost: () => this.getScrollHost(),
      setScrollHostTop: (scrollTop) => this.setScrollHostTop(scrollTop),
      syncScrollAffordances: () => this.syncScrollAffordances(),
      getScrollBottomTarget: (scrollHost) => this.getScrollBottomTarget(scrollHost),
      getScrollPinnedToBottom: () => this.scrollPinnedToBottom,
      setScrollPinnedToBottom: (value) => {
        this.scrollPinnedToBottom = value;
      },
      refreshPinnedToBottom: () => this.updatePinnedToBottom(),
      onUserContentToggle: (open) => this.handleContentToggle(open),
      getLastConversationId: () => this.conversationRuntime.getLastConversationId(),
      getLastRenderedMessageCount: () => this.conversationRuntime.getLastRenderedMessageCount(),
      setLastRenderedMessageCount: (count) => {
        this.conversationRuntime.setLastRenderedMessageCount(count);
      },
      getMarkdownRenderGeneration: () => this.conversationRuntime.getMarkdownRenderGeneration(),
      buildMessageRevision: (conversation) => this.conversationRuntime.buildMessageRevision(conversation),
      setLastMessageRevision: (revision) => {
        this.conversationRuntime.setLastMessageRevision(revision);
      },
      syncComposerButtons: () => this.syncComposerButtons(),
      getConversationForCurrentLeaf: () => {
        const leafState = this.controller.getChatLeafState(this.leaf);
        return leafState.conversationId
          ? this.controller.store.getConversation(leafState.conversationId)
          : null;
      },
      getConversationById: (conversationId) => this.controller.store.getConversation(conversationId),
      getCurrentConversationId: () => this.controller.getChatLeafState(this.leaf).conversationId,
      getMessagesListEl: () => this.messagesListEl,
      renderConversation: () => this.renderConversation(),
      setPlainMessageContent: (contentEl, text) => this.setPlainMessageContent(contentEl, text),
      renderMarkdown: (parentEl, markdown) => this.renderAnswerMarkdown(parentEl, markdown),
      renderInlineToolAction: (parentEl, conversation, message) =>
        this.assistantActions.renderInlineToolAction(parentEl, conversation, message),
      renderAnswerSources: (parentEl, message) =>
        this.assistantActions.renderAnswerSources(parentEl, message),
      renderAnswerActions: (parentEl, conversation, message) =>
        this.assistantActions.renderAnswerActions(parentEl, conversation, message),
      importWebSearchResultUrl: (url) => {
        void this.contextIntake.addWebpageAttachmentFromUrl(url, {
          textareaEl: this.getPreferredComposerTextarea()
        });
      },
      openSourceModal: (target) => this.openSourceModal(target)
    });
    this.conversationRuntime = new ChatViewConversationRuntime({
      controller: this.controller,
      leaf: this.leaf,
      assistantRendering: this.assistantRendering,
      messageActions: this.messageActions,
      getMessagesListEl: () => this.messagesListEl,
      addChild: (component) => this.addChild(component),
      trackMessageRenderComponent: (component) => {
        this.messageRenderComponents.push(component);
      },
      unloadMessageRenderComponents: (components) => {
        const unloaded = new Set(components);
        for (const component of unloaded) {
          component.unload();
        }
        this.messageRenderComponents = this.messageRenderComponents.filter(
          (component) => !unloaded.has(component)
        );
      },
      resetMessageRenderComponents: () => this.resetMessageRenderComponents(),
      renderAssistantMetaBlocks: (parentEl, contentEl, message) =>
        this.renderAssistantMetaBlocks(parentEl, contentEl, message),
      shouldRenderAssistantMessageMarkdown: (message) => this.shouldRenderAssistantMessageMarkdown(message),
      setPlainMessageContent: (contentEl, text) => this.setPlainMessageContent(contentEl, text),
      renderInlineToolAction: (parentEl, conversation, message) =>
        this.assistantActions.renderInlineToolAction(parentEl, conversation, message),
      renderAnswerSources: (parentEl, message) =>
        this.assistantActions.renderAnswerSources(parentEl, message),
      renderAnswerActions: (parentEl, conversation, message) =>
        this.assistantActions.renderAnswerActions(parentEl, conversation, message),
      openWebpageAttachmentPreview: (attachment) => {
        this.contextIntake.openWebpageAttachmentPreview(attachment);
      },
      syncComposerButtons: () => this.syncComposerButtons(),
      syncLeafHeader: () => this.syncLeafHeader(),
      syncScrollAffordances: () => this.syncScrollAffordances(),
      getScrollHost: () => this.getScrollHost(),
      getScrollPinnedToBottom: () => this.scrollPinnedToBottom,
      setScrollHostTop: (scrollTop) => this.setScrollHostTop(scrollTop),
      setScrollPinnedToBottom: (value) => {
        this.scrollPinnedToBottom = value;
        if (value) {
          this.conversationRuntime?.ensureVirtualWindowAtBottom();
        }
      },
      closeInlineSuggests: () => this.inlineSuggests.closeAll(),
      cancelComposerScrollRestore: () => this.cancelComposerScrollRestore(),
      highlightMessage: (messageId) => this.highlightMessage(messageId),
      renderHome: (parentEl) => this.renderHome(parentEl),
      setHomeComposerSlot: (slotEl) => this.setHomeComposerSlot(slotEl)
    });
    this.mobileComposer = new ChatViewMobileComposer({
      desktopBottomMessageGap: ChatView.DESKTOP_BOTTOM_MESSAGE_GAP,
      bottomPinThreshold: ChatView.BOTTOM_PIN_THRESHOLD,
      getContentEl: () => this.contentEl,
      getRootEl: () => this.rootEl,
      getMessagesBottomSpacerEl: () => this.messagesBottomSpacerEl,
      getScrollHost: () => this.getScrollHost(),
      setScrollHostTop: (scrollTop) => this.setScrollHostTop(scrollTop),
      updatePinnedToBottom: () => this.updatePinnedToBottom(),
      syncScrollBottomButtonVisibility: () => this.syncScrollBottomButtonVisibility(),
      syncScrollAffordances: () => this.syncScrollAffordances(),
      positionFloatingControls: () => this.positionFloatingControls(),
      syncLayoutClasses: () => this.syncLayoutClasses(),
      getDraftText: () => this.draftRuntime.getLocalDraft(),
      getComposerPlaceholder: () => this.getComposerPlaceholder(),
      focusComposerTextarea: (textareaEl) => this.focusComposerTextarea(textareaEl),
      syncComposerButtons: () => this.syncComposerButtons(),
      isComposerReadOnly: () => this.controller.isLeafConversationArchived(this.leaf),
      isPhoneLayout: () => this.isPhoneLayout(),
      isMobileRuntime: () => this.isMobileRuntime(),
      getPendingScrollIntent: () => this.conversationRuntime.getPendingScrollIntent(),
      hasComposerResizeObserver: () => this.composerResizeObserver !== null,
      isHomeState: () => this.homeComposerSlotEl !== null,
      onNativeActivationEvent: (event) => {
        this.recordMobileHomeInputLifecycle(event);
      },
      onKeyboardPresentationSettled: () => {
        this.handleMobileKeyboardPresentationFollow();
      },
      onKeyboardPresentationFrame: () => {
        this.handleMobileKeyboardPresentationFrame();
      },
      onKeyboardReservedSpaceChanged: () => {
        this.handleMobileKeyboardPresentationFollow();
      },
      onComposerLayerChange: (active) => {
        if (active) {
          this.captureMobileHomeWorkspaceAnchor();
          // Keep every home DOM reparent ahead of native textarea focus.
          // Moving siblings into the focused subtree can make mobile WebViews
          // emit a transient blur and immediately dismiss the keyboard.
          this.enterMobileHomeInputState();
        } else {
          this.exitMobileHomeInputState();
        }
        this.recordMobileHomeInputLifecycle(
          active ? "layer.change.active" : "layer.change.inactive"
        );
      }
    });
    this.draftRuntime = new ChatViewDraftRuntime({
      controller: this.controller,
      leaf: this.leaf,
      getLocalDraft: () => this.localDraft,
      setLocalDraftValue: (draft) => {
        this.localDraft = draft;
      },
      getDraftOrigin: () => this.draftOrigin,
      getLastFocusComposerNonce: () => this.lastFocusComposerNonce,
      setLastFocusComposerNonce: (value) => {
        this.lastFocusComposerNonce = value;
      },
      getTextareaEl: () => this.textareaEl,
      getPreferredComposerTextarea: () => this.getPreferredComposerTextarea(),
      focusComposerTextarea: (textareaEl) => this.focusComposerTextarea(textareaEl),
      focusActiveComposerTextarea: () => this.focusActiveComposerTextarea(),
      scheduleViewportSync: () => this.scheduleViewportSync(),
      syncComposerLayout: () => this.syncComposerLayout(),
      syncComposerButtons: () => this.syncComposerButtons(),
      getDraftAttachments: () => this.contextIntake.getDraftAttachments(),
      clearDraftAttachments: () => this.contextIntake.clearDraftAttachments(),
      setDraftAttachments: (attachments) => {
        this.contextIntake.setDraftAttachments(attachments);
      },
      syncDraftAttachmentChips: () => this.contextIntake.syncDraftAttachmentChips(),
      addWebpageAttachmentFromUrl: (url) => this.contextIntake.addWebpageAttachmentFromUrl(url),
      closeInlineSuggests: () => this.inlineSuggests.closeAll(),
      getEditingMessageState: () => this.messageActions.getEditingMessageState(),
      hasEditingMessageState: () => this.messageActions.hasEditingMessageState(),
      setEditingMessageState: (state) => {
        this.messageActions.setEditingMessageState(state);
      },
      queueScrollIntent: (intent) => this.queueScrollIntent(intent),
      clearPendingScrollIntent: () => {
        this.conversationRuntime.clearPendingScrollIntent();
      },
      showSendError: (error) => this.controller.showSendError(error)
    });
  }

  override getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return this.controller.getChatLeafDisplayText(this.leaf);
  }

  override getIcon(): string {
    return CHAT_VIEW_ICON;
  }

  override async onOpen(): Promise<void> {
    this.controller.ensureChatLeafState(this.leaf);
    this.ensureViewReady();
    this.renderConversation();
    this.renderViewState();
    this.registerEvent(
      this.controller.getApp().workspace.on("layout-change", () => {
        this.scheduleMobileHomeWorkspaceOwnershipSync(
          "workspace.layout-change"
        );
        window.requestAnimationFrame(() => {
          this.syncDesktopPaneMinWidth();
          this.scheduleViewportSync();
          this.positionFloatingControls();
        });
      })
    );
    this.registerEvent(
      this.controller.getApp().workspace.on("resize", () => {
        this.scheduleMobileHomeWorkspaceOwnershipSync("workspace.resize");
      })
    );
    this.registerEvent(
      this.controller.getApp().workspace.on("active-leaf-change", () => {
        this.recordMobileHomeInputLifecycle("active-leaf-change");
        if (this.controller.getApp().workspace.activeLeaf !== this.leaf) {
          if (document.activeElement === this.textareaEl) {
            this.textareaEl?.blur();
          } else if (this.mobileComposer.isComposerLayerActive()) {
            this.syncMobileComposerFocusState(false);
          }
        }
      })
    );
  }

  override getState(): ChatLeafState {
    return this.controller.getChatLeafState(this.leaf);
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    result.history = false;
    this.controller.hydrateChatLeafState(this.leaf, state);
    this.ensureViewReady();
    this.renderConversation();
    this.renderViewState();
  }

  override async onClose(): Promise<void> {
    this.cancelMobileHomeLifecycleGeometryCapture();
    this.stopMobileInputProbe();
    this.commitDraft({ immediatePersistence: true });
    this.mobileComposer.release();
    this.inlineSuggests.closeAll();
    this.sourceModal?.close();
    this.sourceModal = null;
    this.clearMessageHighlight();
    this.containerEl.removeClass(ChatView.CHAT_LEAF_CONTENT_CLASS);
    this.containerEl.removeClass("is-android-runtime");
    this.containerEl.removeClass("is-ios-runtime");
    this.controller.releaseChatLeaf(this.leaf);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeAssistantChunk?.();
    this.unsubscribeAssistantChunk = null;
    this.viewStateUnsubscribe?.();
    this.viewStateUnsubscribe = null;
    this.composerModal?.close();
    this.composerModal = null;
    this.cancelHomeComposerPositionSync();
    this.clearHomeComposerPosition();
    this.exitMobileHomeInputState();
    this.cancelHomeComposerPositionSync();
    this.homeComposerSlotEl = null;
    this.mobileHomeWorkspaceAnchor = null;
    this.homeCapabilityRowEl = null;
    this.homeCapabilityEls.clear();
    this.contextIntake.release();
    this.messageActions.closeMessageMenu();
    this.closeModelMenu();
    this.rootEl = null;
    this.messagesEl = null;
    this.messagesListEl = null;
    this.messagesBottomSpacerEl = null;
    this.composerWrapEl = null;
    this.composerEl = null;
    this.attachmentStripEl = null;
    this.composerInputShellEl = null;
    this.composerInputWrapEl = null;
    this.textareaEl = null;
    this.textareaMirrorEl = null;
    this.mobileExpandButtonEl = null;
    this.sendButtons = [];
    this.scrollBottomButtonEl = null;
    this.scrollPinnedToBottom = true;
    this.resetMessageRenderComponents();
    this.assistantRendering.resetStreamingMarkdownRenderer();
    this.conversationRuntime.release();
    this.clearDesktopPaneMinWidth();
    this.assistantRendering.release();
    this.disconnectComposerResizeObserver();
    this.disconnectMessageListResizeObserver();
    for (const dispose of this.disposeCallbacks) {
      dispose();
    }
    this.disposeCallbacks = [];
  }

  private ensureViewReady(): void {
    if (this.rootEl && this.messagesListEl && this.textareaEl) {
      return;
    }

    this.contentEl.empty();
    this.containerEl.addClass(ChatView.CHAT_LEAF_CONTENT_CLASS);
    this.contentEl.addClass("sidet-chat-view");
    this.syncLayoutClasses();
    this.syncDesktopPaneMinWidth();

    this.rootEl = this.contentEl.createDiv({ cls: "sidet-chat-root" });
    this.contextIntake.ensureImageInputReady();
    this.messagesEl = this.rootEl.createDiv({ cls: "sidet-messages" });
    this.messagesListEl = this.messagesEl.createDiv({ cls: "sidet-messages-list" });
    this.messagesBottomSpacerEl = this.messagesEl.createDiv({ cls: "sidet-messages-bottom-spacer" });

    this.composerWrapEl = this.rootEl.createDiv({ cls: "sidet-composer-wrap" });
    this.composerEl = this.composerWrapEl.createDiv({ cls: "sidet-composer" });

    const mobileLeadingActions = this.composerEl.createDiv({
      cls: "sidet-composer-mobile-leading sidet-composer-actions"
    });
    this.contextIntake.createContextButton(mobileLeadingActions);

    this.attachmentStripEl = this.composerEl.createDiv({ cls: "sidet-composer-attachments is-empty" });

    this.composerInputShellEl = this.composerEl.createDiv({ cls: "sidet-composer-input-shell" });
    this.composerInputWrapEl = this.composerInputShellEl.createDiv({ cls: "sidet-composer-input-wrap" });
    this.textareaEl = this.composerInputWrapEl.createEl("textarea", {
      cls: "sidet-textarea"
    });
    this.textareaMirrorEl = this.composerInputWrapEl.createDiv({ cls: "sidet-textarea-mirror" });
    this.textareaMirrorEl.setAttr("aria-hidden", "true");
    this.textareaEl.placeholder = this.getComposerPlaceholder();
    this.textareaEl.readOnly = this.controller.isLeafConversationArchived(this.leaf);
    this.textareaEl.setAttribute("aria-readonly", this.textareaEl.readOnly ? "true" : "false");
    this.localDraft = this.controller.getLeafViewState(this.leaf).composerDraft;
    this.textareaEl.value = this.draftRuntime.getLocalDraft();
    this.textareaEl.addEventListener("input", () => {
      this.setLocalDraft(this.textareaEl?.value ?? "", {
        syncController: !this.messageActions.isEditingDraftActive(),
        suppressEchoToOrigin: true
      });
      this.inlineSuggests.syncInlineSuggests(this.textareaEl);
    });
    this.textareaEl.addEventListener("pointerdown", (event) => {
      if (
        !event.isPrimary ||
        event.button !== 0 ||
        !event.cancelable ||
        this.textareaEl?.readOnly
      ) {
        return;
      }
      this.recordMobileHomeInputLifecycle("native.pointerdown.before");
      const activationOwned =
        this.mobileComposer.beginComposerActivationFromNativePointer(
          event.pointerId
        );
      if (!activationOwned) {
        this.recordMobileHomeInputLifecycle(
          "native.pointerdown.not-owned"
        );
        return;
      }
      event.preventDefault();
      this.recordMobileHomeInputLifecycle(
        "native.pointerdown.default-prevented"
      );
      this.recordMobileHomeInputLifecycle("native.pointerdown.after");
    });
    this.textareaEl.addEventListener("pointerup", (event) => {
      this.recordMobileHomeInputLifecycle("native.pointerup.before");
      this.mobileComposer.completeComposerActivationPointer(event.pointerId);
      this.recordMobileHomeInputLifecycle("native.pointerup.after");
    });
    this.textareaEl.addEventListener("pointercancel", (event) => {
      this.recordMobileHomeInputLifecycle("native.pointercancel");
      this.mobileComposer.cancelComposerActivationPointer(event.pointerId);
    });
    this.textareaEl.addEventListener("blur", () => {
      this.commitDraft({ immediatePersistence: true });
      this.scheduleViewportSync();
    });
    this.textareaEl.addEventListener("keydown", (event) => {
      if (event.isComposing) {
        return;
      }
      if (this.inlineSuggests.handleMentionSuggestKeydown(event)) {
        return;
      }
      if (this.inlineSuggests.handleLinkSuggestKeydown(event)) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !this.isPhoneLayout()) {
        event.preventDefault();
        void this.handleSend();
      }
    });

    const mobileExpandActions = this.composerEl.createDiv({
      cls: "sidet-composer-mobile-expand sidet-composer-actions"
    });
    this.mobileExpandButtonEl = createIconButton(mobileExpandActions, {
      icon: "maximize-2",
      label: "展开输入",
      className: "sidet-composer-inline-expand is-hidden",
      preserveFocus: true,
      onClick: () => {
        this.openComposerModal();
      }
    });
    this.mobileComposer.attachMainComposerElements({
      composerWrapEl: this.composerWrapEl,
      composerEl: this.composerEl,
      attachmentStripEl: this.attachmentStripEl,
      inputShellEl: this.composerInputShellEl,
      textareaEl: this.textareaEl,
      textareaMirrorEl: this.textareaMirrorEl,
      expandButtonEl: this.mobileExpandButtonEl
    });

    const mobileTrailingActions = this.composerEl.createDiv({
      cls: "sidet-composer-mobile-trailing sidet-composer-actions"
    });
    this.createMoreActionsButton(mobileTrailingActions);
    this.createSendButton(mobileTrailingActions);

    const desktopFooter = this.composerEl.createDiv({ cls: "sidet-composer-desktop-footer" });
    const desktopLeadingActions = desktopFooter.createDiv({
      cls: "sidet-composer-desktop-leading sidet-composer-actions"
    });
    this.contextIntake.createContextButton(desktopLeadingActions);
    this.createMoreActionsButton(desktopLeadingActions);

    const desktopTrailingActions = desktopFooter.createDiv({
      cls: "sidet-composer-desktop-trailing sidet-composer-actions"
    });
    this.createSendButton(desktopTrailingActions);

    this.scrollBottomButtonEl = this.composerEl.createEl("button", {
      cls: "sidet-scroll-bottom-button"
    });
    this.scrollBottomButtonEl.type = "button";
    this.scrollBottomButtonEl.setAttribute("aria-label", "回到底部");
    this.scrollBottomButtonEl.setAttribute("data-tooltip-position", "top");
    setTooltip(this.scrollBottomButtonEl, "回到底部");
    const scrollBottomIcon = this.scrollBottomButtonEl.createSpan({
      cls: "sidet-scroll-bottom-button-icon"
    });
    scrollBottomIcon.setAttribute("aria-hidden", "true");
    setIcon(scrollBottomIcon, "arrow-down");
    this.scrollBottomButtonEl.addEventListener("click", (event) => {
      event.preventDefault();
      this.jumpToConversationBottom();
    });

    this.startComposerResizeObserver();
    this.startMessageListResizeObserver();
    this.contextIntake.syncDraftAttachmentChips();
    this.syncComposerLayout();
    this.syncComposerButtons();
    this.syncScrollAffordances();

    this.unsubscribe?.();
    this.unsubscribe = this.controller.store.subscribe(() => this.handleStoreChange());
    this.unsubscribeAssistantChunk?.();
    this.unsubscribeAssistantChunk = this.controller.store.subscribeAssistantChunk((event) => {
      this.handleAssistantChunkEvent(event);
    });
    this.viewStateUnsubscribe?.();
    this.viewStateUnsubscribe = this.controller.subscribeLeafViewState(this.leaf, () => this.handleLeafStateChange());
    this.bindRuntimeListeners();
    this.scheduleViewportSync();
  }

  private async handleSend(): Promise<boolean> {
    return this.draftRuntime.handleSend();
  }

  private renderConversation(): void {
    this.sourceModal?.close();
    this.sourceModal = null;
    this.clearMessageHighlight();
    this.conversationRuntime.renderConversation();
  }

  private openSourceModal(target: AnswerSourceTarget): void {
    this.sourceModal?.close();
    this.sourceModal = new ChatViewSourceModal(
      {
        app: this.controller.getApp(),
        copyText: (text) => this.messageActions.copyTextToClipboard(text)
      },
      target
    );
    this.sourceModal.open();
  }

  private renderAnswerMarkdown(parentEl: HTMLElement, markdown: string): void {
    const renderComponent = new Component();
    this.addChild(renderComponent);
    this.messageRenderComponents.push(renderComponent);
    void MarkdownRenderer.render(
      this.controller.getApp(),
      markdown,
      parentEl,
      this.controller.getApp().workspace.getActiveFile()?.path ?? "",
      renderComponent
    ).catch((error) => {
      console.error("Sidet：渲染来源列表失败", error);
    });
  }

  private renderHome(parentEl: HTMLElement): HTMLDivElement {
    const result = renderChatHome(parentEl, this.controller, {
      capabilities: this.buildHomeCapabilities()
    });
    this.homeCapabilityRowEl = result.capabilityRowEl;
    this.homeCapabilityEls = result.capabilityEls;
    return result.composerSlotEl;
  }

  private buildHomeCapabilities(): ChatHomeCapability[] {
    return [
      {
        id: "web-clipping",
        label: CHAT_HOME_CAPABILITY_LABELS["web-clipping"],
        icon: "clipboard",
        selected: this.isHomeCapabilitySelected("web-clipping"),
        onSelect: (anchorEl) => {
          if (this.isHomeCapabilitySelected("web-clipping")) {
            this.contextIntake.clearDraftWebpageAttachments();
            this.finishHomeCapabilityToggle(anchorEl);
            return;
          }
          this.contextIntake.openWebpageAttachmentPicker();
        }
      },
      {
        id: "web-search",
        label: CHAT_HOME_CAPABILITY_LABELS["web-search"],
        icon: "globe",
        selected: this.isHomeCapabilitySelected("web-search"),
        onSelect: (anchorEl) => {
          if (this.isHomeCapabilitySelected("web-search")) {
            this.controller.setWebSearchEnabled(this.leaf, false);
          } else {
            this.controller.setWebSearchEnabled(this.leaf, true);
          }
          this.finishHomeCapabilityToggle(anchorEl);
        }
      }
    ];
  }

  private finishHomeCapabilityToggle(anchorEl: HTMLElement): void {
    // 移动端宿主可能在点击后补一次焦点，chip 会留在 focus 态；先清掉
    // chip 自己的焦点，再把焦点交回输入框。
    if (anchorEl.ownerDocument.activeElement === anchorEl) {
      anchorEl.blur();
    }
    this.focusActiveComposerTextarea();
  }

  private isHomeCapabilitySelected(capabilityId: ChatHomeCapabilityId): boolean {
    if (capabilityId === "web-clipping") {
      return this.contextIntake.getDraftAttachments().some((attachment) => attachment.type === "webpage");
    }
    return this.controller.isWebSearchEnabled(this.leaf);
  }

  private setHomeComposerSlot(slotEl: HTMLDivElement | null): void {
    if (slotEl === null) {
      this.exitMobileHomeInputState();
      this.mobileHomeWorkspaceAnchor = null;
    }
    this.homeComposerSlotEl = slotEl;
    if (slotEl === null) {
      // 等这一轮对话 DOM 渲染完再补留白；主页槽位清空发生在消息列表重建之前。
      window.setTimeout(() => this.mobileComposer.handleHomeStateExited(), 0);
    }
    const isHomeState = slotEl !== null;
    this.rootEl?.classList.toggle("is-home-state", isHomeState);

    if (isHomeState) {
      this.setScrollHostTop(0);
      this.contextIntake.syncDraftAttachmentChips();
      this.syncHomeCapabilityVisibility();
      // 新槽位必须马上有一份坐标：只排下一帧 rAF 时，后台叶子、刚创建还没
      // 拿到尺寸或 rAF 被节流都会留下空变量，composer 会按默认值落到根顶部
      // （用户 2026-11-28 反馈「+ 新建对话偶尔浮到 chip 上方」）。同步写一次，
      // 尺寸为 0 或输入层仍激活时由 writer 自己拒绝，调度仍然保留。
      this.syncHomeComposerPosition();
      this.scheduleHomeComposerPositionSync();
    } else {
      this.homeCapabilityRowEl = null;
      this.homeCapabilityEls.clear();
      this.cancelHomeComposerPositionSync();
      this.clearHomeComposerPosition();
    }

    this.mobileComposer.syncMobileComposerLayerState();
    this.syncComposerLayout();
  }

  private enterMobileHomeInputState(): void {
    const capabilityRowEl = this.homeCapabilityRowEl;
    const composerWrapEl = this.composerWrapEl;
    if (
      !this.homeComposerSlotEl ||
      !capabilityRowEl?.isConnected ||
      !composerWrapEl?.isConnected ||
      !this.isPhoneLayout() ||
      !this.isMobileRuntime()
    ) {
      return;
    }

    if (capabilityRowEl.parentElement !== composerWrapEl) {
      composerWrapEl.insertBefore(capabilityRowEl, composerWrapEl.firstChild);
    }
    composerWrapEl.addClass("is-home-input-state");
    this.rootEl?.addClass("is-home-input-state");
  }

  private resumeMobileHomeInputPresentation(): void {
    if (
      !this.homeComposerSlotEl ||
      !this.mobileComposer.isComposerLayerActive() ||
      !this.isPhoneLayout() ||
      !this.isMobileRuntime()
    ) {
      return;
    }

    this.composerWrapEl?.addClass("is-home-input-state");
    this.rootEl?.addClass("is-home-input-state");
  }

  private exitMobileHomeInputState(): void {
    const capabilityRowEl = this.homeCapabilityRowEl;
    const composerSlotEl = this.homeComposerSlotEl;
    if (
      capabilityRowEl &&
      composerSlotEl?.parentElement &&
      capabilityRowEl.parentElement !== composerSlotEl.parentElement
    ) {
      composerSlotEl.parentElement.insertBefore(
        capabilityRowEl,
        composerSlotEl
      );
    }
    this.composerWrapEl?.removeClass("is-home-input-state");
    this.rootEl?.removeClass("is-home-input-state");
    // 退出输入态时 capability row 已回到主页，槽位几何就是休息态；丢掉输入期
    // 的锚点并立刻重写一次，避免旧变量/空变量把 composer 留在 chip 上方。
    // 输入层仍激活（主页重建等）或视图尺寸为 0 时由 writer 自己拒绝。
    this.mobileHomeWorkspaceAnchor = null;
    this.syncHomeComposerPosition();
    this.scheduleHomeComposerPositionSync();
  }

  private syncHomeCapabilityVisibility(): void {
    if (!this.homeComposerSlotEl) {
      return;
    }
    for (const [capabilityId, chipEl] of this.homeCapabilityEls) {
      setChatHomeCapabilitySelected(
        chipEl,
        this.isHomeCapabilitySelected(capabilityId),
        CHAT_HOME_CAPABILITY_LABELS[capabilityId]
      );
    }
    this.scheduleHomeComposerPositionSync();
  }

  private scheduleHomeComposerPositionSync(): void {
    if (!this.homeComposerSlotEl || !this.rootEl) {
      return;
    }
    if (this.homeComposerPositionFrame !== null) {
      window.cancelAnimationFrame(this.homeComposerPositionFrame);
    }
    this.homeComposerPositionFrame = window.requestAnimationFrame(() => {
      this.homeComposerPositionFrame = null;
      this.syncHomeComposerPosition();
    });
  }

  private cancelHomeComposerPositionSync(): void {
    if (this.homeComposerPositionFrame === null) {
      return;
    }
    window.cancelAnimationFrame(this.homeComposerPositionFrame);
    this.homeComposerPositionFrame = null;
  }

  private syncHomeComposerPosition(): void {
    const slotEl = this.homeComposerSlotEl;
    const rootEl = this.rootEl;
    if (!slotEl?.isConnected || !rootEl?.isConnected) {
      return;
    }
    // 输入层激活时 composer 在 body layer，主页槽位坐标不参与显示；此时 chip
    // 行已被搬进 composer wrapper，读到的 slot 是「chip 已搬走」的过渡几何，
    // 写下去会让退出输入态后的 composer 停在 chip 上方。
    if (this.mobileComposer.isComposerLayerActive()) {
      return;
    }
    // 隐藏叶子 / 刚创建还没有尺寸：0 尺寸写进去会把 composer 钉在根左上角；
    // 等视图可见后的尺寸变化或后续调度再写。
    const slotProbe = slotEl.getBoundingClientRect();
    if (slotProbe.width <= 0 || slotProbe.height <= 0) {
      this.recordMobileHomeInputLifecycle("home.position.hidden");
      return;
    }
    if (this.shouldPreserveMobileHomeWorkspaceAnchor()) {
      this.recordMobileHomeInputLifecycle("home.position.anchor-preserved");
      return;
    }

    const homeEl = slotEl.closest<HTMLElement>(".sidet-home");
    if (homeEl) {
      const homeRect = homeEl.getBoundingClientRect();
      // Drawer gestures transform the whole workspace without a layout
      // change, so a viewport-anchored inset would cancel the shift and
      // glue the row and slot to the screen edge. Measuring against the
      // view content keeps these values at their rest levels while a
      // sidebar is open or animating; the homepage rides the workspace.
      const contentRect = this.contentEl.getBoundingClientRect();
      const homeInline = resolveHomeComposerInline(homeRect, contentRect);
      if (
        homeEl.style.getPropertyValue("--sidet-home-inline-left") !==
        homeInline.left
      ) {
        homeEl.style.setProperty(
          "--sidet-home-inline-left",
          homeInline.left
        );
      }
      if (
        homeEl.style.getPropertyValue("--sidet-home-inline-right") !==
        homeInline.right
      ) {
        homeEl.style.setProperty(
          "--sidet-home-inline-right",
          homeInline.right
        );
      }
    }

    const slotRect = slotProbe;
    const rootRect = rootEl.getBoundingClientRect();
    const scrollTop = this.messagesEl?.scrollTop ?? 0;
    const slotMetrics = resolveHomeComposerSlot(slotRect, rootRect, scrollTop);
    rootEl.style.setProperty(
      "--sidet-home-composer-top",
      slotMetrics.top
    );
    rootEl.style.setProperty(
      "--sidet-home-composer-left",
      slotMetrics.left
    );
    rootEl.style.setProperty(
      "--sidet-home-composer-width",
      slotMetrics.width
    );
    if (!this.isMobileRuntime() && this.composerEl?.isConnected) {
      const composerHeight = resolveHomeComposerSlotHeight(
        this.composerEl.getBoundingClientRect()
      );
      if (
        slotEl.style.getPropertyValue(
          "--sidet-home-composer-slot-height"
        ) !== composerHeight
      ) {
        slotEl.style.setProperty(
          "--sidet-home-composer-slot-height",
          composerHeight
        );
      }
    }
    if (!this.mobileComposer.isComposerLayerActive()) {
      this.mobileHomeWorkspaceAnchor = null;
    }
  }

  private clearHomeComposerPosition(): void {
    this.rootEl?.style.removeProperty("--sidet-home-composer-top");
    this.rootEl?.style.removeProperty("--sidet-home-composer-left");
    this.rootEl?.style.removeProperty("--sidet-home-composer-width");
  }

  private renderViewState(): void {
    this.draftRuntime.renderViewState();
    this.contextIntake.syncDraftAttachmentChips();
    this.consumeMessageRevealRequest();
  }

  private consumeMessageRevealRequest(): void {
    const request = this.controller.getLeafViewState(this.leaf).messageRevealRequest;
    if (!request) {
      return;
    }
    this.controller.clearMessageReveal(this.leaf);
    const conversationId = this.controller.getChatLeafState(this.leaf).conversationId;
    if (request.conversationId !== conversationId) {
      return;
    }
    this.conversationRuntime.revealMessage(request.messageId);
  }

  private highlightMessage(messageId: string): void {
    this.clearMessageHighlight();
    const itemEl = this.contentEl.querySelector<HTMLElement>(
      `.sidet-message[data-message-id="${messageId}"]`
    );
    if (!itemEl) {
      return;
    }
    itemEl.addClass("is-search-hit");
    this.messageHighlightTimer = window.setTimeout(() => {
      this.messageHighlightTimer = null;
      itemEl.removeClass("is-search-hit");
    }, 1600);
  }

  private clearMessageHighlight(): void {
    if (this.messageHighlightTimer !== null) {
      window.clearTimeout(this.messageHighlightTimer);
      this.messageHighlightTimer = null;
    }
    this.contentEl.querySelectorAll(".sidet-message.is-search-hit").forEach((element) => {
      element.classList.remove("is-search-hit");
    });
  }

  private handleLeafStateChange(): void {
    this.conversationRuntime.handleLeafStateChange();
    this.renderViewState();
  }

  private handleStoreChange(): void {
    this.conversationRuntime.handleStoreChange();
  }

  private handleAssistantChunkEvent(event: {
    conversationId: string;
    messageId: string;
    segment: "content" | "reasoning" | "meta";
    text: string;
  }): void {
    this.conversationRuntime.handleAssistantChunkEvent(event);
  }

  private syncLeafHeader(): void {
    syncLeafHeaderTitle(this.leaf, this.controller.getChatLeafDisplayText(this.leaf), CHAT_VIEW_ICON);
  }

  private setLocalDraft(
    draft: string,
    options: {
      syncController?: boolean;
      suppressEchoToOrigin?: boolean;
      immediatePersistence?: boolean;
    } = {}
  ): void {
    this.draftRuntime.setLocalDraft(draft, options);
  }

  private commitDraft(options: { immediatePersistence: boolean }): void {
    this.draftRuntime.commitDraft(options);
  }

  private syncComposerLayout(): void {
    this.mobileComposer.syncComposerLayout();
  }

  private handleComposerResize(nextHeight: number, options: { preserveScroll: boolean }): void {
    this.mobileComposer.handleComposerResize(nextHeight, options);
    this.scheduleHomeComposerPositionSync();
  }

  private syncComposerButtons(): void {
    const draft = this.draftRuntime.getLocalDraft().trim();
    const isStreaming = this.controller.isLeafStreaming(this.leaf);
    const isArchived = this.controller.isLeafConversationArchived(this.leaf);
    const attachmentCount = this.contextIntake.getDraftAttachments().length;
    const canSend = draft.length > 0 || attachmentCount > 0;
    const isWebSearchMode = this.controller.getLeafViewState(this.leaf).webSearchEnabled && attachmentCount === 0;
    this.mobileComposer.syncPlaceholder();
    this.mobileComposer.syncReadOnly();
    if (this.textareaEl) {
      this.textareaEl.readOnly = isArchived;
      this.textareaEl.setAttribute("aria-readonly", isArchived ? "true" : "false");
      this.textareaEl.placeholder = this.getComposerPlaceholder();
    }
    for (const sendButton of this.sendButtons) {
      sendButton.setState({
        disabled: isArchived || (!isStreaming && !canSend),
        streaming: isStreaming,
        idleLabel: isWebSearchMode ? "检索" : "发送"
      });
    }
    this.mobileComposer.syncInlineExpandControls();
    this.syncHomeCapabilityVisibility();
  }

  private getComposerPlaceholder(): string {
    if (this.controller.isLeafConversationArchived(this.leaf)) {
      return "已归档对话，恢复后才能继续发送";
    }
    if (this.contextIntake.getDraftAttachments().length > 0) {
      return "输入消息";
    }
    if (this.controller.getLeafViewState(this.leaf).webSearchEnabled) {
      return "联网搜索";
    }
    return "输入消息";
  }

  private getPreferredComposerTextarea(): HTMLTextAreaElement | null {
    return this.mobileComposer.getPreferredComposerTextarea();
  }

  private focusActiveComposerTextarea(): void {
    this.focusComposerTextarea(this.getPreferredComposerTextarea());
  }

  private holdMobileComposerForAttachmentPicker(durationMs = 15000): void {
    this.mobileComposer.holdMobileComposerForAttachmentPicker(durationMs);
  }

  private shouldHoldMobileComposerForAttachmentPicker(): boolean {
    return this.mobileComposer.shouldHoldMobileComposerForAttachmentPicker();
  }

  private restoreComposerFocusAfterAttachment(): void {
    this.mobileComposer.restoreComposerFocusAfterAttachment();
  }

  private closeMobileComposerLayer(options: { blur: boolean }): void {
    this.mobileComposer.closeMobileComposerLayer(options);
  }

  private syncMobileComposerLayerState(): void {
    this.mobileComposer.syncMobileComposerLayerState();
  }

  private bindRuntimeListeners(): void {
    if (!this.textareaEl || this.disposeCallbacks.length > 0) {
      return;
    }

    this.mobileComposer.bindKeyboardFollow();
    this.mobileComposer.bindTailCompatibilityGuard();
    this.disposeCallbacks.push(this.controller.subscribeWorkspaceState(() => {
      this.syncComposerButtons();
    }));
    const scrollHost = this.getScrollHost();
    const onScroll = () => {
      this.conversationRuntime.handleVirtualScroll();
      this.assistantRendering.refreshStreamingMarkdownAfterScroll();
      if (this.assistantRendering.handleScroll(scrollHost.scrollTop)) {
        return;
      }
      this.updatePinnedToBottom();
      this.syncScrollBottomButtonVisibility();
    };
    scrollHost.addEventListener("scroll", onScroll);
    // 展开 / 版本切换期间的布局滚动不算用户滚动；真实手势立即释放贴底锁定。
    const releaseBottomFollowIntent = () => {
      this.assistantRendering.releaseBottomFollowIntent();
      if (this.mobileFocusPinnedToBottom) {
        this.mobileFocusFollowCancelled = true;
      }
    };
    scrollHost.addEventListener("wheel", releaseBottomFollowIntent, { passive: true });
    scrollHost.addEventListener("touchstart", releaseBottomFollowIntent, { passive: true });
    scrollHost.addEventListener("pointerdown", releaseBottomFollowIntent);
    this.disposeCallbacks.push(() => {
      scrollHost.removeEventListener("scroll", onScroll);
      scrollHost.removeEventListener("wheel", releaseBottomFollowIntent);
      scrollHost.removeEventListener("touchstart", releaseBottomFollowIntent);
      scrollHost.removeEventListener("pointerdown", releaseBottomFollowIntent);
    });

    const onViewportChange = () => this.scheduleViewportSync();
    const onVisibilityChange = () => {
      if (!document.hidden) {
        this.scheduleViewportSync();
      }
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    window.addEventListener("pageshow", onViewportChange);
    document.addEventListener("visibilitychange", onVisibilityChange);

    const onComposerFocusChange = () => {
      const isFocused = document.activeElement === this.textareaEl;
      this.recordMobileHomeInputLifecycle(
        isFocused ? "focus.event" : "blur.event"
      );
      if (!isFocused && this.shouldHoldMobileComposerForAttachmentPicker()) {
        return;
      }

      this.syncMobileComposerFocusState(isFocused);
      if (isFocused) {
        this.resumeMobileHomeInputPresentation();
      }
      this.cancelComposerScrollRestore();
      this.mobileComposer.syncComposerLayout();
      this.scheduleViewportSync();
    };
    this.textareaEl.addEventListener("focus", onComposerFocusChange);
    this.textareaEl.addEventListener("blur", onComposerFocusChange);
    // Read-only capture probe for the delayed-blur evidence gate: it never
    // preventDefaults, retargets, or blocks these compatibility events.
    const readNativeTailEvent = (
      event: MouseEvent
    ): MobileHomeTailEventObservation => {
      const targetEl = event.target instanceof Element ? event.target : null;
      const textareaEl = this.textareaEl;
      return {
        type: event.type,
        target: readMobileHomeElementSignature(targetEl),
        targetIsTextarea: !!targetEl && targetEl === textareaEl,
        targetContainsTextarea:
          !!targetEl && !!textareaEl && targetEl.contains(textareaEl),
        textareaContainsTarget:
          !!targetEl && !!textareaEl && textareaEl.contains(targetEl),
        activeElement: readMobileHomeElementSignature(document.activeElement)
      };
    };
    const recordNativeTailEvent = (event: MouseEvent): void => {
      if (Date.now() > this.mobileTailObservationUntilMs) {
        return;
      }
      const tailEvent = readNativeTailEvent(event);
      this.recordMobileHomeInputLifecycle(
        event.type === "contextmenu"
          ? "native.tail.contextmenu"
          : "native.tail.click",
        { tailEvent }
      );
    };
    // The press events of the same compatibility sequence answer whether the
    // tail press ever reached the DOM at all; they stay observation-only.
    const recordNativeTailPress = (event: MouseEvent): void => {
      if (Date.now() > this.mobileTailObservationUntilMs) {
        return;
      }
      this.recordMobileHomeInputLifecycle(`native.tail.${event.type}`, {
        tailEvent: readNativeTailEvent(event)
      });
    };
    window.addEventListener("click", recordNativeTailEvent, true);
    window.addEventListener("contextmenu", recordNativeTailEvent, true);
    window.addEventListener("mousedown", recordNativeTailPress, true);
    window.addEventListener("mouseup", recordNativeTailPress, true);
    this.disposeCallbacks.push(() => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
      window.removeEventListener("pageshow", onViewportChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("click", recordNativeTailEvent, true);
      window.removeEventListener("contextmenu", recordNativeTailEvent, true);
      window.removeEventListener("mousedown", recordNativeTailPress, true);
      window.removeEventListener("mouseup", recordNativeTailPress, true);
      this.textareaEl?.removeEventListener("focus", onComposerFocusChange);
      this.textareaEl?.removeEventListener("blur", onComposerFocusChange);
    });

    const viewport = window.visualViewport;
    if (viewport) {
      viewport.addEventListener("resize", onViewportChange);
      viewport.addEventListener("scroll", onViewportChange);
      this.disposeCallbacks.push(() => {
        viewport.removeEventListener("resize", onViewportChange);
        viewport.removeEventListener("scroll", onViewportChange);
      });

      if ("onscrollend" in viewport) {
        const onViewportScrollEnd = () => this.scheduleViewportSync();
        (viewport as EventTarget).addEventListener("scrollend", onViewportScrollEnd);
        this.disposeCallbacks.push(() => {
          (viewport as EventTarget).removeEventListener("scrollend", onViewportScrollEnd);
        });
      }
    }

    // Keep messages on ItemView.contentEl and move the existing composer node
    // to the stable body layer only for mobile focus. VirtualKeyboard
    // overlaysContent remains disabled, so Sidet does not take global
    // ownership of Obsidian's keyboard avoidance.
  }

  private scheduleViewportSync(): void {
    this.mobileComposer.scheduleViewportSync();
  }

  private syncMobileComposerFocusState(isFocused: boolean): void {
    if (isFocused && this.isPhoneLayout() && this.isMobileRuntime()) {
      // 用真实几何在聚焦瞬间记录意图，不读可能已过期的 pin；键盘让位期间
      // 布局滚动不清意图，真实滚轮 / 触摸 / 按下会取消。
      this.mobileFocusPinnedToBottom = this.isScrollHostAtBottom();
      this.mobileFocusFollowCancelled = false;
      if (this.mobileFocusPinnedToBottom) {
        this.assistantRendering.holdBottomFollowIntent(1500);
      }
      this.startMobileInputProbe();
    } else {
      if (this.mobileInputProbeTimer !== null) {
        this.captureMobileInputProbeSample("focus.blur");
        this.continueMobileInputProbeAfterBlur();
      } else {
        this.stopMobileInputProbe();
      }
      this.mobileFocusPinnedToBottom = false;
      this.mobileFocusFollowCancelled = false;
      this.assistantRendering.releaseBottomFollowIntent();
    }
    this.mobileComposer.syncMobileComposerFocusState(isFocused);
  }

  /**
   * 排障探针：聚焦后连续采样 6 秒（60ms 一次），覆盖两段式键盘避让、
   * 留白重算与跟随全过程；只留在内存，由诊断命令复制回传。
   */
  private startMobileInputProbe(): void {
    this.stopMobileInputProbe();
    resetMobileInputProbe();
    this.captureMobileInputProbeSample("focus.begin");
    this.mobileInputProbeTimer = window.setInterval(() => {
      this.captureMobileInputProbeSample("sample");
    }, 60);
    this.mobileInputProbeStopTimer = window.setTimeout(() => {
      this.stopMobileInputProbe();
    }, 6000);
  }

  private stopMobileInputProbe(): void {
    if (this.mobileInputProbeTimer !== null) {
      window.clearInterval(this.mobileInputProbeTimer);
      this.mobileInputProbeTimer = null;
    }
    if (this.mobileInputProbeStopTimer !== null) {
      window.clearTimeout(this.mobileInputProbeStopTimer);
      this.mobileInputProbeStopTimer = null;
    }
  }

  /**
   * 失焦后键盘回落、宿主恢复内容区高度是另一段时间线；单独补采 1.6 秒，
   * 让「收回是否也割裂」有同一份数据可对齐。
   */
  private continueMobileInputProbeAfterBlur(): void {
    if (this.mobileInputProbeTimer === null) {
      return;
    }
    window.clearInterval(this.mobileInputProbeTimer);
    if (this.mobileInputProbeStopTimer !== null) {
      window.clearTimeout(this.mobileInputProbeStopTimer);
      this.mobileInputProbeStopTimer = null;
    }
    this.mobileInputProbeTimer = window.setInterval(() => {
      this.captureMobileInputProbeSample("blur.sample");
    }, 60);
    this.mobileInputProbeStopTimer = window.setTimeout(() => {
      this.stopMobileInputProbe();
    }, 1600);
  }

  private captureMobileInputProbeSample(label: string): void {
    const contentEl = this.contentEl;
    const scrollHost = this.getScrollHost();
    const round = (value: number): number => Math.round(value);
    const readRect = (element: Element | null): Record<string, number> | null => {
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return { top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height) };
    };
    const viewport = window.visualViewport;
    const contentStyle = getComputedStyle(contentEl);
    recordMobileInputProbeSample(label, {
      viewport: {
        innerWidth: round(window.innerWidth),
        innerHeight: round(window.innerHeight),
        visualHeight: viewport ? round(viewport.height) : null,
        visualOffsetTop: viewport ? round(viewport.offsetTop) : null,
        visualPageTop: viewport ? round(viewport.pageTop) : null,
        hasFocus: document.hasFocus(),
        hidden: document.hidden
      },
      content: {
        rect: readRect(contentEl),
        paddingBottom: contentStyle.paddingBottom,
        className: contentEl.className,
        reservedSpace: contentStyle.getPropertyValue("--sidet-composer-reserved-space")
      },
      scrollHost: {
        isContentEl: scrollHost === contentEl,
        rect: readRect(scrollHost),
        scrollTop: round(scrollHost.scrollTop),
        scrollHeight: round(scrollHost.scrollHeight),
        clientHeight: round(scrollHost.clientHeight),
        distance: round(
          scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight
        )
      },
      intent: {
        focusPinned: this.mobileFocusPinnedToBottom,
        cancelled: this.mobileFocusFollowCancelled,
        pinned: this.scrollPinnedToBottom
      },
      hostVars: {
        keyboardHeight: getComputedStyle(document.body).getPropertyValue("--keyboard-height"),
        restingComposerBottom: contentStyle.getPropertyValue(
          "--sidet-mobile-resting-composer-bottom"
        )
      },
      composer: this.mobileComposer.getMobileInputDiagnosticSnapshot()
    });
  }

  /**
   * 贴底聚焦时键盘 inset 会把最后一段内容压到输入框下面。键盘开始上浮后，
   * 留白每帧都由 composer 的实时位置重算；这里在同一帧把滚动补到新底部，
   * 内容与输入框共用一条运动，不再叠第三段平滑追底。浏览中聚焦或用户已
   * 动手取消时保持阅读锚点不动。
   */
  private handleMobileKeyboardPresentationFollow(): void {
    if (this.mobileInputProbeTimer !== null) {
      this.captureMobileInputProbeSample("follow.trigger");
    }
    if (!this.mobileFocusPinnedToBottom || this.mobileFocusFollowCancelled) {
      return;
    }
    this.assistantRendering.holdBottomFollowIntent(600);
    this.assistantRendering.anchorBottomForKeyboardPresentation();
  }

  /**
   * 开场逐帧只补滚动。意图与 pin 在开场那一帧已经锁定；每帧再走一遍
   * 虚拟窗口 / affordances 会把主线程拖出抖动，观感就不丝滑了。
   */
  private handleMobileKeyboardPresentationFrame(): void {
    if (!this.mobileFocusPinnedToBottom || this.mobileFocusFollowCancelled) {
      return;
    }
    this.setScrollHostTop(this.getScrollBottomTarget());
  }

  private startComposerResizeObserver(): void {
    if (!this.composerEl || typeof ResizeObserver === "undefined") {
      return;
    }

    this.disconnectComposerResizeObserver();
    this.composerResizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      this.handleComposerResize(Math.round(entry.contentRect.height), {
        preserveScroll: true
      });
    });
    this.composerResizeObserver.observe(this.composerEl);
    this.handleComposerResize(Math.round(this.composerEl.getBoundingClientRect().height), {
      preserveScroll: false
    });
  }

  private disconnectComposerResizeObserver(): void {
    this.composerResizeObserver?.disconnect();
    this.composerResizeObserver = null;
  }

  /**
   * 消息内容展开 / 异步补齐只改变列表高度，不产生滚动事件；这里把高度变化
   * 接回现有贴底跟随入口，避免贴底阅读在「查看内容」「展开来源」等动作后
   * 停在半空。主页展示态与空态不参与。
   */
  private startMessageListResizeObserver(): void {
    if (!this.messagesListEl || typeof ResizeObserver === "undefined") {
      return;
    }

    this.disconnectMessageListResizeObserver();
    this.messageListResizeObserver = new ResizeObserver(() => {
      if (!this.conversationRuntime.hasConversationMessagesRendered()) {
        return;
      }
      this.assistantRendering.handleContentResize();
    });
    this.messageListResizeObserver.observe(this.messagesListEl);
    this.assistantRendering.resetContentHeightBaseline();
  }

  private disconnectMessageListResizeObserver(): void {
    this.messageListResizeObserver?.disconnect();
    this.messageListResizeObserver = null;
  }

  private updatePinnedToBottom(): void {
    this.assistantRendering.updatePinnedToBottom(ChatView.BOTTOM_PIN_THRESHOLD);
  }

  private suppressContentFollowForToggle(): void {
    this.assistantRendering.suppressContentResizeFollow(320);
    window.setTimeout(() => this.updatePinnedToBottom(), 340);
  }

  /** 滚动宿主是否贴在底部；动作前快照用它，不看可能已被瞬时事件改写的 pin。 */
  private isScrollHostAtBottom(): boolean {
    const scrollHost = this.getScrollHost();
    return (
      scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight <=
      ChatView.BOTTOM_PIN_THRESHOLD
    );
  }

  /**
   * 用户主动开合内容：展开时如果本来就在底部，锁定贴底意图并跟到底；
   * 收起保持现状（浏览器夹紧即可），不把展开的增长抑制掉。
   */
  private handleContentToggle(expanded: boolean): void {
    if (!expanded) {
      this.suppressContentFollowForToggle();
      return;
    }
    this.holdBottomIntentForUserAction();
  }

  /** 版本切换等内容变化前调用：用户本来在底部时，跨过异步渲染继续跟底。 */
  private holdBottomIntentForUserAction(): void {
    if (!this.isScrollHostAtBottom()) {
      return;
    }
    this.assistantRendering.holdBottomFollowIntent(1200);
    this.assistantRendering.requestBottomFollow("smooth");
  }

  private scrollMessagesToBottom(options: { keepPinned?: boolean } = {}): void {
    this.cancelComposerScrollRestore();
    this.conversationRuntime.ensureVirtualWindowAtBottom();
    this.assistantRendering.scrollMessagesToBottom(options);
  }

  private jumpToConversationBottom(): void {
    if (!this.isPhoneLayout() || !this.isMobileRuntime()) {
      this.scrollMessagesToBottom({ keepPinned: true });
      return;
    }

    // WebView 的原生惯性不会因为程序化 scrollTop 停下；先刹住动量再跳到底部，
    // 否则松手后的动量会在跳转后继续把内容带走。
    haltMobileScrollMomentum(this.getScrollHost(), () => {
      this.scrollMessagesToBottom({ keepPinned: true });
    });
  }

  private openComposerModal(): void {
    if (!this.mobileComposer.canExpandComposerInModal() || this.composerModal) {
      return;
    }

    if (document.activeElement === this.textareaEl) {
      this.textareaEl?.blur();
    }
    this.closeMobileComposerLayer({ blur: true });
    this.composerModal = new ComposerModal(this.controller, this.leaf, {
      onSend: () => this.handleSend(),
      canSend: () => this.draftRuntime.getLocalDraft().trim().length > 0 || this.contextIntake.getDraftAttachments().length > 0,
      onAfterClose: () => {
        this.composerModal = null;
        this.scheduleViewportSync();
      }
    });
    this.composerModal.open();
  }

  private closeMessageMenu(): void {
    this.messageActions.closeMessageMenu();
  }

  private closeChatMenus(except?: ChatMenuKind): void {
    if (except !== "context") {
      this.contextIntake.closeContextMenu();
    }
    if (except !== "message") {
      this.closeMessageMenu();
    }
    if (except !== "model") {
      this.closeModelMenu();
    }
  }

  private closeModelMenu(): void {
    this.modelMenuClose?.();
    this.modelMenuClose = null;
    this.modelMenuAnchorEl = null;
  }

  private openModelMenu(anchorEl: HTMLElement): void {
    if (this.modelMenuClose && this.modelMenuAnchorEl === anchorEl) {
      this.closeModelMenu();
      return;
    }

    this.closeChatMenus("model");
    const handle = openChatModelMenu(anchorEl, this.controller, () => {
      this.modelMenuClose = null;
      this.modelMenuAnchorEl = null;
    }, this.leaf);
    this.modelMenuAnchorEl = anchorEl;
    this.modelMenuClose = () => handle.close();
  }

  private createMoreActionsButton(parent: HTMLElement): HTMLButtonElement {
    const button = createIconButton(parent, {
      icon: "atom",
      label: "切换模型",
      preserveFocus: true,
      onClick: (event) => {
        event.stopPropagation();
        void this.openModelMenu(event.currentTarget as HTMLElement);
      }
    });
    return button;
  }

  private createSendButton(parent: HTMLElement): HTMLButtonElement {
    const button = createSendButtonControl(parent, {
      className: parent.closest(".sidet-composer-mobile-trailing") ? "is-mobile-send-button" : undefined,
      preserveFocus: true,
      onClick: () => {
        if (this.controller.isLeafStreaming(this.leaf)) {
          this.controller.stopStreamingForLeaf(this.leaf);
          return;
        }
        void this.handleSend();
      }
    });
    this.sendButtons.push(button);
    return button.buttonEl;
  }

  private syncScrollAffordances(): void {
    this.positionFloatingControls();
    this.syncScrollBottomButtonVisibility();
  }

  private positionFloatingControls(): void {
    this.scrollBottomButtonEl?.removeAttribute("style");
    this.inlineSuggests.reposition();
  }

  private syncScrollBottomButtonVisibility(): void {
    if (!this.scrollBottomButtonEl) {
      return;
    }

    const isVisible = shouldShowScrollBottomButton(
      this.conversationRuntime.hasConversationMessagesRendered(),
      this.scrollPinnedToBottom
    );
    this.scrollBottomButtonEl.classList.toggle("is-visible", isVisible);
    this.scrollBottomButtonEl.setAttribute("aria-hidden", isVisible ? "false" : "true");
    this.scrollBottomButtonEl.tabIndex = isVisible ? 0 : -1;
  }

  private setScrollHostTop(
    scrollTop: number
  ): void {
    const scrollHost = this.getScrollHost();
    scrollHost.scrollTop = scrollTop;
  }

  private getScrollBottomTarget(scrollHost = this.getScrollHost()): number {
    return resolveScrollBottomTarget(scrollHost.scrollHeight, scrollHost.clientHeight);
  }

  private focusComposerTextarea(textareaEl: HTMLTextAreaElement | null): void {
    if (!textareaEl) {
      return;
    }

    if (this.isPhoneLayout() && this.isMobileRuntime()) {
      this.recordMobileHomeInputLifecycle("focus.request.before");
      this.mobileComposer.prepareComposerLayerForFocus();
      this.recordMobileHomeInputLifecycle("focus.request.prepared");
      textareaEl.focus({ preventScroll: true });
      this.recordMobileHomeInputLifecycle("focus.request.after");
      return;
    }

    textareaEl.focus();
  }

  private recordMobileHomeInputLifecycle(
    event: string,
    extras?: MobileHomeInputLifecycleExtras
  ): void {
    if (!this.isPhoneLayout() || !this.isMobileRuntime()) {
      return;
    }

    if (MOBILE_TAIL_OBSERVATION_ARM_EVENTS.has(event)) {
      this.mobileTailObservationUntilMs =
        Date.now() + MOBILE_TAIL_OBSERVATION_WINDOW_MS;
    }
    this.writeMobileHomeInputLifecycle(event, false, extras);
    this.pendingMobileHomeLifecycleGeometryEvent = event;
    if (this.mobileHomeLifecycleDiagnosticFrame !== null) {
      return;
    }
    this.mobileHomeLifecycleDiagnosticFrame = window.requestAnimationFrame(() => {
      this.mobileHomeLifecycleDiagnosticFrame = null;
      const geometryEvent = this.pendingMobileHomeLifecycleGeometryEvent;
      this.pendingMobileHomeLifecycleGeometryEvent = null;
      if (!geometryEvent || !this.rootEl?.isConnected) {
        return;
      }
      this.writeMobileHomeInputLifecycle(`${geometryEvent}.frame`, true);
    });
  }

  private writeMobileHomeInputLifecycle(
    event: string,
    includeGeometry: boolean,
    extras?: MobileHomeInputLifecycleExtras
  ): void {
    const composerParentEl = this.composerWrapEl?.parentElement ?? null;
    const capabilityParentEl = this.homeCapabilityRowEl?.parentElement ?? null;
    const layerEl = composerParentEl?.classList.contains(
      "sidet-mobile-composer-layer"
    )
      ? composerParentEl
      : null;
    const visualViewport = window.visualViewport;
    // A blur event fires after the browser already moved focus, so this
    // signature is the new focus owner; for focus events it is the textarea.
    const changedActiveElement =
      event === "focus.event" || event === "blur.event"
        ? readMobileHomeElementSignature(document.activeElement)
        : null;
    recordMobileHomeLifecycleDiagnostic(event, {
      activeLeafIsView:
        this.controller.getApp().workspace.activeLeaf === this.leaf,
      activeElementIsTextarea: document.activeElement === this.textareaEl,
      homeState: this.homeComposerSlotEl !== null,
      layerActive: this.mobileComposer.isComposerLayerActive(),
      rootInputState:
        this.rootEl?.classList.contains("is-home-input-state") ?? false,
      composerInputState:
        this.composerWrapEl?.classList.contains("is-home-input-state") ??
        false,
      ownership: {
        composerParent: !composerParentEl
          ? "none"
          : composerParentEl.classList.contains("sidet-mobile-composer-layer")
            ? "mobile-layer"
            : composerParentEl === this.rootEl
              ? "chat-root"
              : "other",
        capabilityParent: !capabilityParentEl
          ? "none"
          : capabilityParentEl === this.composerWrapEl
            ? "composer-wrap"
            : capabilityParentEl.classList.contains("sidet-home")
              ? "home"
              : "other"
      },
      viewport: {
        innerWidth: roundMobileHomeDiagnosticNumber(window.innerWidth),
        innerHeight: roundMobileHomeDiagnosticNumber(window.innerHeight),
        visualViewportWidth: normalizeMobileHomeDiagnosticNumber(
          visualViewport?.width
        ),
        visualViewportHeight: normalizeMobileHomeDiagnosticNumber(
          visualViewport?.height
        ),
        visualViewportOffsetTop: normalizeMobileHomeDiagnosticNumber(
          visualViewport?.offsetTop
        )
      },
      geometry: {
        content: includeGeometry
          ? readMobileHomeDiagnosticRect(this.contentEl)
          : null,
        root: includeGeometry
          ? readMobileHomeDiagnosticRect(this.rootEl)
          : null,
        slot: includeGeometry
          ? readMobileHomeDiagnosticRect(this.homeComposerSlotEl)
          : null,
        capability: includeGeometry
          ? readMobileHomeDiagnosticRect(this.homeCapabilityRowEl)
          : null,
        composer: includeGeometry
          ? readMobileHomeDiagnosticRect(this.composerWrapEl)
          : null,
        layer: includeGeometry
          ? readMobileHomeDiagnosticRect(layerEl)
          : null
      },
      tailEvent: extras?.tailEvent ?? null,
      changedActiveElement
    });
  }

  private cancelMobileHomeLifecycleGeometryCapture(): void {
    if (this.mobileHomeLifecycleDiagnosticFrame !== null) {
      window.cancelAnimationFrame(this.mobileHomeLifecycleDiagnosticFrame);
      this.mobileHomeLifecycleDiagnosticFrame = null;
    }
    this.pendingMobileHomeLifecycleGeometryEvent = null;
  }

  private captureMobileHomeWorkspaceAnchor(): void {
    if (!this.isPhoneLayout() || !this.isMobileRuntime()) {
      return;
    }
    this.mobileHomeWorkspaceAnchor = this.readMobileHomeRestGeometry();
  }

  private readMobileHomeRestGeometry(): MobileHomeRestGeometry | null {
    const rootEl = this.rootEl;
    const slotEl = this.homeComposerSlotEl;
    if (!rootEl?.isConnected || !slotEl?.isConnected) {
      return null;
    }

    const rootRect = rootEl.getBoundingClientRect();
    const slotRect = slotEl.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    return {
      rootLeft: rootRect.left,
      rootRight: rootRect.right,
      rootWidth: rootRect.width,
      composerTop:
        slotRect.top -
        rootRect.top +
        (this.messagesEl?.scrollTop ?? 0),
      composerLeft: slotRect.left - rootRect.left,
      composerWidth: slotRect.width,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      visualViewportHeight:
        typeof visualViewport?.height === "number"
          ? visualViewport.height
          : null,
      visualViewportOffsetTop:
        typeof visualViewport?.offsetTop === "number"
          ? visualViewport.offsetTop
          : null
    };
  }

  private shouldPreserveMobileHomeWorkspaceAnchor(): boolean {
    const anchor = this.mobileHomeWorkspaceAnchor;
    if (
      !anchor ||
      !this.isPhoneLayout() ||
      !this.isMobileRuntime()
    ) {
      return false;
    }

    const current = this.readMobileHomeRestGeometry();
    if (!current) {
      return false;
    }
    if (Math.abs(current.viewportWidth - anchor.viewportWidth) > 1) {
      this.mobileHomeWorkspaceAnchor = current;
      return false;
    }

    return isMobileHomeRestGeometryDisplaced(anchor, current);
  }

  private scheduleMobileHomeWorkspaceOwnershipSync(event: string): void {
    if (
      !this.homeComposerSlotEl ||
      !this.isPhoneLayout() ||
      !this.isMobileRuntime()
    ) {
      return;
    }

    this.recordMobileHomeInputLifecycle(event);
    this.mobileComposer.requestWorkspaceOwnershipCheck(event);
    this.scheduleHomeComposerPositionSync();
  }

  private getScrollHost(): HTMLElement {
    return this.isPhoneLayout() && this.isMobileRuntime()
      ? this.contentEl
      : this.messagesEl ?? this.contentEl;
  }

  private isPhoneLayout(): boolean {
    return Platform.isPhone || window.innerWidth <= 700;
  }

  private isMobileRuntime(): boolean {
    return Platform.isMobile || Platform.isPhone;
  }

  private queueScrollIntent(intent: Exclude<ChatViewScrollIntent, "none">): void {
    this.conversationRuntime.queueScrollIntent(intent);
  }

  private cancelComposerScrollRestore(): void {
    this.mobileComposer.cancelComposerScrollRestore();
  }

  private syncLayoutClasses(): void {
    this.contentEl.classList.toggle("is-phone-layout", this.isPhoneLayout());
    this.contentEl.classList.toggle("is-mobile-runtime", this.isMobileRuntime());
    this.contentEl.classList.toggle("is-android-runtime", Platform.isAndroidApp);
    this.contentEl.classList.toggle("is-ios-runtime", Platform.isIosApp);
    this.containerEl.classList.toggle("is-android-runtime", Platform.isAndroidApp);
    this.containerEl.classList.toggle("is-ios-runtime", Platform.isIosApp);
    this.syncMobileComposerLayerState();
    this.syncDesktopPaneMinWidth();
    this.scheduleHomeComposerPositionSync();
  }

  private shouldRenderAssistantMessageMarkdown(message: MessageRecord): boolean {
    if (message.role !== "assistant" || !message.text.trim()) {
      return false;
    }
    return message.status === "done" || (message.status === "error" && hasPartialErrorContent(message));
  }
  private renderAssistantMetaBlocks(
    itemEl: HTMLDivElement,
    contentEl: HTMLDivElement,
    message: MessageRecord
  ): void {
    this.assistantRendering.syncMetaBlocks(itemEl, contentEl, message);
  }

  private setPlainMessageContent(contentEl: HTMLDivElement, text: string): void {
    contentEl.empty();
    contentEl.removeClass("markdown-rendered");
    contentEl.addClass("-plain");
    contentEl.setText(text);
  }

  private resetMessageRenderComponents(): void {
    for (const component of this.messageRenderComponents) {
      component.unload();
    }
    this.messageRenderComponents = [];
  }

  private syncDesktopPaneMinWidth(): void {
    const nextPaneItemEl = this.isMobileRuntime()
      ? null
      : resolveDesktopPaneItemElement(this.leaf);

    if (this.desktopPaneItemEl && this.desktopPaneItemEl !== nextPaneItemEl) {
      this.releaseDesktopPaneMinWidth(this.desktopPaneItemEl);
    }

    this.desktopPaneItemEl = nextPaneItemEl;
    if (!nextPaneItemEl) {
      return;
    }

    nextPaneItemEl.style.minWidth = `${ChatView.DESKTOP_MIN_LEAF_WIDTH}px`;
  }

  private clearDesktopPaneMinWidth(): void {
    if (!this.desktopPaneItemEl) {
      return;
    }

    this.releaseDesktopPaneMinWidth(this.desktopPaneItemEl);
    this.desktopPaneItemEl = null;
  }

  private releaseDesktopPaneMinWidth(paneItemEl: HTMLElement): void {
    releaseDesktopPaneMinWidthIfUnused(paneItemEl, this.leaf, this.controller.getApp(), CHAT_VIEW_TYPE);
  }
}
