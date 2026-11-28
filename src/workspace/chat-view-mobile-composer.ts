import { resolveMobileComposerReservedSpace } from "./chat-view-layout-metrics";
import { ChatViewMobileComposerLayerRuntime } from "./chat-view-mobile-composer-layer";
import { ChatViewMobileKeyboardFollowRuntime } from "./chat-view-mobile-keyboard-follow";
import {
  ChatViewMobileWorkspaceOwnershipGuard,
  type MobileWorkspaceOwnershipLossDetail
} from "./chat-view-mobile-workspace-ownership";
import { recordChatScrollTrace } from "./chat-scroll-trace";

interface ComposerLayout {
  targetHeight: number;
  overflowMode: "hidden" | "auto";
  visibleRows: number;
  canExpand: boolean;
}

interface MainComposerElements {
  composerWrapEl: HTMLDivElement | null;
  composerEl: HTMLDivElement | null;
  attachmentStripEl: HTMLDivElement | null;
  inputShellEl: HTMLDivElement | null;
  textareaEl: HTMLTextAreaElement | null;
  textareaMirrorEl: HTMLDivElement | null;
  expandButtonEl: HTMLButtonElement | null;
}

interface ChatViewMobileComposerOptions {
  desktopBottomMessageGap: number;
  bottomPinThreshold: number;
  getContentEl: () => HTMLElement;
  getRootEl: () => HTMLElement | null;
  getMessagesBottomSpacerEl: () => HTMLElement | null;
  getScrollHost: () => HTMLElement;
  setScrollHostTop: (scrollTop: number) => void;
  updatePinnedToBottom: () => void;
  syncScrollBottomButtonVisibility: () => void;
  syncScrollAffordances: () => void;
  positionFloatingControls: () => void;
  syncLayoutClasses: () => void;
  getDraftText: () => string;
  getComposerPlaceholder: () => string;
  focusComposerTextarea: (textareaEl: HTMLTextAreaElement | null) => void;
  syncComposerButtons: () => void;
  isComposerReadOnly: () => boolean;
  isPhoneLayout: () => boolean;
  isMobileRuntime: () => boolean;
  getPendingScrollIntent: () =>
    | "none"
    | "after-send"
    | "conversation-switch-or-initial-open"
    | "reveal-message";
  hasComposerResizeObserver: () => boolean;
  isHomeState: () => boolean;
  onComposerLayerChange: (active: boolean) => void;
  onKeyboardPresentationSettled?: () => void;
  /** 开场逐帧回调：输入框位移写入后，同一帧只补滚动（不再重算 pin / affordances）。 */
  onKeyboardPresentationFrame?: () => void;
  /** 键盘期宿主尺寸变化、留白重算后通知视图层重新贴底。 */
  onKeyboardReservedSpaceChanged?: () => void;
  onNativeActivationEvent?: (event: string) => void;
}

export class ChatViewMobileComposer {
  private mainComposer: MainComposerElements = {
    composerWrapEl: null,
    composerEl: null,
    attachmentStripEl: null,
    inputShellEl: null,
    textareaEl: null,
    textareaMirrorEl: null,
    expandButtonEl: null
  };

  private readonly keyboardFollowRuntime: ChatViewMobileKeyboardFollowRuntime;
  private readonly layerRuntime: ChatViewMobileComposerLayerRuntime;
  private readonly workspaceOwnershipGuard: ChatViewMobileWorkspaceOwnershipGuard;
  private disposed = false;
  private viewportSyncTimer: number | null = null;
  private nativeActivationPointerId: number | null = null;
  private tailCompatibilityGuardArmed = false;
  private tailCompatibilityGuardCleanup: (() => void) | null = null;
  private composerScrollRestoreFrame: number | null = null;
  private composerScrollRestoreVersion = 0;
  private canExpandComposer = false;
  private lastComposerHeight = 0;
  private lastTextareaHeight = 0;
  private lastOverflowMode: "hidden" | "auto" = "hidden";
  private lastReservedSpace = 0;
  private lastRestingReservedSpace = 0;
  /** 键盘呈现落定后用真实几何算出的输入态留白；收起键盘即回退到冻结值。 */
  private focusedReservedSpace: number | null = null;
  /** 键盘期内容区 padding 已被键盘运行时锁定，缓存后逐帧不再重读 computed style。 */
  private focusedContentPaddingBottom: number | null = null;
  /** 聚焦前内容区底缘（全高）；关闭时用它算「全高口径」的留白，宿主收缩也不跳。 */
  private restingContentBoxBottom: number | null = null;
  private closeFollowActive = false;
  private closingSpacerContentTop: number | null = null;
  private closingContentTop = 0;
  private closingContentBoxBottom: number | null = null;
  private postCloseBottomSyncFrame: number | null = null;
  private postCloseBottomSyncPending = false;
  private contentHostResizeObserver: ResizeObserver | null = null;
  private contentHostResizeFrame: number | null = null;
  private focusedStabilizeFrame: number | null = null;
  private mobileComposerVisualState: "single-line" | "multi-line" = "single-line";

  constructor(private readonly options: ChatViewMobileComposerOptions) {
    this.layerRuntime = new ChatViewMobileComposerLayerRuntime({
      getContentEl: () => this.options.getContentEl(),
      getRootEl: () => this.options.getRootEl(),
      getComposerWrapEl: () => this.mainComposer.composerWrapEl,
      getComposerTextareaEl: () => this.mainComposer.textareaEl,
      focusComposerTextarea: (textareaEl) => this.options.focusComposerTextarea(textareaEl),
      syncComposerLayout: () => this.syncComposerLayout(),
      syncComposerButtons: () => this.options.syncComposerButtons(),
      scheduleViewportSync: () => this.scheduleViewportSync(),
      updatePinnedToBottom: () => this.options.updatePinnedToBottom(),
      syncScrollBottomButtonVisibility: () => this.options.syncScrollBottomButtonVisibility(),
      onLayerChange: () => {
        const isActive = this.layerRuntime.isActive();
        if (isActive) {
          // 输入层激活通常早于键盘收缩；先记全高底缘，关闭时才有「全高口径」可用。
          this.captureRestingContentBoxBottom();
          this.workspaceOwnershipGuard.start();
        } else {
          this.workspaceOwnershipGuard.stop();
        }
        this.keyboardFollowRuntime?.handleActiveComposerLayerChange();
        this.options.onComposerLayerChange(isActive);
      },
      isPhoneLayout: () => this.options.isPhoneLayout(),
      isMobileRuntime: () => this.options.isMobileRuntime()
    });
    this.keyboardFollowRuntime = new ChatViewMobileKeyboardFollowRuntime({
      getContentEl: () => this.options.getContentEl(),
      getStableHostEl: () => this.layerRuntime.getLayerEl(),
      getActiveComposerLayer: () => this.mainComposer.composerWrapEl,
      getActiveComposerTextarea: () => this.mainComposer.textareaEl,
      isComposerLayerActive: () => this.layerRuntime.isActive(),
      isPhoneLayout: () => this.options.isPhoneLayout(),
      isMobileRuntime: () => this.options.isMobileRuntime(),
      onPresentationStarted: () => {
        // 输入框开始上浮：立即按当前几何起算，后续每帧随输入框位置校正，
        // 内容和键盘走同一段动画。
        this.syncFocusedReservedSpace();
        this.options.onKeyboardPresentationSettled?.();
      },
      onPresentationFrame: (visualComposerTop) => {
        // 与输入框位移同一个 rAF：先写输入框，再算留白、补滚动，两件事一段运动。
        this.syncFocusedReservedSpaceFrame(visualComposerTop);
      },
      onPresentationSettled: () => {
        // 键盘落定后按真实几何重算输入态留白：宿主是否变矮、输入框是否抬起
        // 都由当前 rect 反映，避免冻结值在多补或少补之间二选一。
        this.syncFocusedReservedSpace();
        this.options.onKeyboardPresentationSettled?.();
      },
      onPresentationAnimationEnded: () => {
        // didShow 可能早于表面动画结束，此时 composer 还没到终点；动画结束后
        // 再按最终几何校正一次，避免留白按中途位置算少或算多。
        this.syncFocusedReservedSpace();
        this.options.onKeyboardPresentationSettled?.();
      },
      shouldFollowClose: () => this.shouldFollowKeyboardClose(),
      onPresentationCloseStarted: () => {
        this.beginKeyboardCloseFollow();
      },
      onPresentationCloseFrame: (visualComposerTop) => {
        this.syncKeyboardCloseFrame(visualComposerTop);
      },
      onPresentationCloseFinished: () => {
        this.finishKeyboardCloseFollow();
      },
      onPresentationClosed: () => {
        this.clearFocusedReservedSpace();
      }
    });
    this.workspaceOwnershipGuard =
      new ChatViewMobileWorkspaceOwnershipGuard({
        getRootEl: () => this.options.getRootEl(),
        getViewportWidth: () => window.innerWidth,
        isLayerActive: () => this.layerRuntime.isActive(),
        onOwnershipLoss: (trigger, detail) => {
          this.interruptForWorkspaceOwnershipLoss(trigger, detail);
        }
      });
  }

  attachMainComposerElements(elements: MainComposerElements): void {
    this.mainComposer = elements;
    this.layerRuntime.syncPresentationState();
  }

  bindKeyboardFollow(): void {
    this.keyboardFollowRuntime.bind();
  }

  canExpandComposerInModal(): boolean {
    return this.canExpandComposer;
  }

  getPreferredComposerTextarea(): HTMLTextAreaElement | null {
    return this.mainComposer.textareaEl;
  }

  isComposerLayerActive(): boolean {
    return this.layerRuntime.isActive();
  }

  /** 排障快照：聚焦后键盘 / 留白 / 输入框的真实几何，只读。 */
  getMobileInputDiagnosticSnapshot(): Record<string, unknown> {
    const readRect = (element: HTMLElement | null): Record<string, number> | null => {
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height)
      };
    };
    const layerEl = this.layerRuntime.getLayerEl();
    const wrapEl = this.mainComposer.composerWrapEl;
    const spacerEl = this.options.getMessagesBottomSpacerEl();
    const layerStyle = layerEl ? getComputedStyle(layerEl) : null;
    return {
      layerActive: this.layerRuntime.isActive(),
      focusedReservedSpace: this.focusedReservedSpace,
      keyboard: this.keyboardFollowRuntime.getDiagnosticSnapshot(),
      wrap: readRect(wrapEl),
      spacer: readRect(spacerEl),
      layerPaddingBottom: layerStyle?.paddingBottom ?? null,
      layerClass: layerEl?.className ?? null,
      wrapPosition: wrapEl ? getComputedStyle(wrapEl).position : null
    };
  }

  prepareComposerLayerForFocus(): void {
    this.clearNativeComposerActivation();
    this.layerRuntime.prepareForFocus();
  }

  beginComposerActivationFromNativePointer(pointerId: number): boolean {
    this.clearNativeComposerActivation();
    if (!this.options.isPhoneLayout() || !this.options.isMobileRuntime()) {
      return false;
    }
    const textareaEl = this.mainComposer.textareaEl;
    if (!textareaEl || textareaEl.readOnly) {
      return false;
    }
    if (document.activeElement === textareaEl) {
      return false;
    }
    this.nativeActivationPointerId = pointerId;
    // The activation reparents the textarea mid-gesture, so the iOS
    // compatibility mousedown/click would otherwise retarget to whatever now
    // covers the tap point (the home container) and WebKit resigns the fresh
    // focus to body. Capturing the textarea's own pointer pins the whole
    // compatibility sequence back to the textarea (PE3 §4.1.3.2); capture
    // releases itself with the gesture, so no explicit teardown is wanted.
    try {
      textareaEl.setPointerCapture(pointerId);
      this.options.onNativeActivationEvent?.(
        "native.activation.pointer-captured"
      );
    } catch {
      this.options.onNativeActivationEvent?.(
        "native.activation.capture-failed"
      );
    }
    this.options.onNativeActivationEvent?.("native.activation.pending");
    return true;
  }

  completeComposerActivationPointer(pointerId: number): void {
    if (this.nativeActivationPointerId !== pointerId) {
      return;
    }
    this.options.onNativeActivationEvent?.("native.pointerup.accepted");
    this.clearNativeComposerActivation();
    const textareaEl = this.mainComposer.textareaEl;
    if (
      !textareaEl ||
      textareaEl.readOnly
    ) {
      this.abortNativeComposerActivation("native-pointerup-invalid");
      return;
    }
    if (!this.layerRuntime.activateForFocus()) {
      this.abortNativeComposerActivation("native-pointerup-focus-failed");
      return;
    }
    this.options.onNativeActivationEvent?.("native.pointerup.focused");
    // The reparent is already done, so the compatibility mouse press iOS
    // synthesises for this same tap would hit-test to the vacated home area
    // and WebKit would resign the fresh focus to body. Pointer capture pins
    // that sequence when the engine honours it; this guard covers the case
    // where the press still reaches the home surface.
    this.armTailCompatibilityGuard();
  }

  cancelComposerActivationPointer(pointerId: number): void {
    if (this.nativeActivationPointerId !== pointerId) {
      return;
    }
    this.abortNativeComposerActivation("pointer-cancel");
  }

  bindTailCompatibilityGuard(): void {
    if (this.tailCompatibilityGuardCleanup) {
      return;
    }
    const rootEl = this.options.getRootEl();
    if (!rootEl) {
      return;
    }
    // Only the compatibility press that trails an owned activation can be
    // consumed, and only its default action (the focus walk), never its
    // propagation: a new physical gesture always starts with pointerdown, so
    // tapping outside the composer still resigns focus and closes the keyboard.
    const onPointerDown = (): void => {
      this.tailCompatibilityGuardArmed = false;
    };
    const onCompatMouseEvent = (event: MouseEvent): void => {
      if (!this.tailCompatibilityGuardArmed || !event.cancelable) {
        return;
      }
      const textareaEl = this.mainComposer.textareaEl;
      const composerWrapEl = this.mainComposer.composerWrapEl;
      if (
        !textareaEl ||
        !composerWrapEl ||
        !this.layerRuntime.isActive() ||
        document.activeElement !== textareaEl
      ) {
        return;
      }
      const targetEl = event.target as Node | null;
      if (targetEl && composerWrapEl.contains(targetEl)) {
        return;
      }
      this.tailCompatibilityGuardArmed = false;
      event.preventDefault();
      this.options.onNativeActivationEvent?.(
        "native.tail.compat-default-suppressed"
      );
    };
    rootEl.addEventListener("pointerdown", onPointerDown, true);
    rootEl.addEventListener("mousedown", onCompatMouseEvent, true);
    rootEl.addEventListener("mouseup", onCompatMouseEvent, true);
    this.tailCompatibilityGuardCleanup = () => {
      rootEl.removeEventListener("pointerdown", onPointerDown, true);
      rootEl.removeEventListener("mousedown", onCompatMouseEvent, true);
      rootEl.removeEventListener("mouseup", onCompatMouseEvent, true);
      this.tailCompatibilityGuardArmed = false;
    };
  }

  syncPlaceholder(): void {
    if (this.mainComposer.textareaEl) {
      this.mainComposer.textareaEl.placeholder = this.options.getComposerPlaceholder();
    }
  }

  syncReadOnly(): void {
    const isReadOnly = this.options.isComposerReadOnly();
    if (this.mainComposer.textareaEl) {
      this.mainComposer.textareaEl.readOnly = isReadOnly;
      this.mainComposer.textareaEl.setAttribute("aria-readonly", isReadOnly ? "true" : "false");
    }
  }

  release(): void {
    // 先置 disposed：layerRuntime.release() 会回调 onLayerChange / scheduleViewportSync，
    // 那里若再排定时器，会在视图销毁后对已清空的 DOM 读写。
    this.disposed = true;
    if (this.viewportSyncTimer !== null) {
      window.clearTimeout(this.viewportSyncTimer);
      this.viewportSyncTimer = null;
    }
    this.clearNativeComposerActivation();
    this.tailCompatibilityGuardCleanup?.();
    this.tailCompatibilityGuardCleanup = null;
    this.cancelComposerScrollRestore();
    this.stopContentHostResizeObserver();
    this.workspaceOwnershipGuard.stop();
    this.keyboardFollowRuntime.release();
    this.layerRuntime.release();
    this.lastComposerHeight = 0;
    this.lastTextareaHeight = 0;
    this.lastOverflowMode = "hidden";
    this.lastReservedSpace = 0;
    this.lastRestingReservedSpace = 0;
    this.focusedReservedSpace = null;
    this.focusedContentPaddingBottom = null;
    this.cancelPostCloseBottomSync();
    this.closeFollowActive = false;
    this.closingSpacerContentTop = null;
    this.closingContentBoxBottom = null;
    this.restingContentBoxBottom = null;
    this.mobileComposerVisualState = "single-line";
    this.canExpandComposer = false;
  }

  syncComposerLayout(): void {
    const textareaEl = this.mainComposer.textareaEl;
    const textareaMirrorEl = this.mainComposer.textareaMirrorEl;
    if (!textareaEl || !textareaMirrorEl) {
      return;
    }

    const layout = this.measureComposerLayout(textareaEl, textareaMirrorEl);
    if (layout.targetHeight !== this.lastTextareaHeight) {
      textareaEl.style.height = `${layout.targetHeight}px`;
      this.lastTextareaHeight = layout.targetHeight;
    }

    if (layout.overflowMode !== this.lastOverflowMode) {
      const preservedScrollTop = textareaEl.scrollTop;
      textareaEl.style.overflowY = layout.overflowMode;
      textareaEl.scrollTop = layout.overflowMode === "auto" ? preservedScrollTop : 0;
      this.lastOverflowMode = layout.overflowMode;
    }

    this.canExpandComposer = layout.canExpand;
    this.mobileComposerVisualState =
      this.options.isPhoneLayout() && layout.visibleRows <= 1 ? "single-line" : "multi-line";

    this.mainComposer.composerEl?.classList.toggle(
      "is-mobile-single-line",
      this.mobileComposerVisualState === "single-line"
    );
    this.mainComposer.composerEl?.classList.toggle(
      "is-mobile-multi-line",
      this.mobileComposerVisualState === "multi-line"
    );

    this.syncInlineExpandControls();
    if (!this.options.hasComposerResizeObserver() && this.mainComposer.composerEl) {
      this.handleComposerResize(Math.round(this.mainComposer.composerEl.getBoundingClientRect().height), {
        preserveScroll: true
      });
    } else {
      this.updateComposerReservedSpace();
    }
  }

  syncInlineExpandControls(): void {
    const showInlineExpand = this.canExpandComposer && this.options.isPhoneLayout();
    this.mainComposer.expandButtonEl?.classList.toggle("is-hidden", !showInlineExpand);
    this.mainComposer.inputShellEl?.classList.toggle("has-inline-expand", showInlineExpand);
  }

  handleComposerResize(nextHeight: number, options: { preserveScroll: boolean }): void {
    if (!nextHeight) {
      return;
    }

    const roundedHeight = Math.round(nextHeight);
    const previousHeight = this.lastComposerHeight;
    const scrollHost = this.options.getScrollHost();
    const preservedScrollTop = scrollHost.scrollTop;
    this.lastComposerHeight = roundedHeight;
    this.options.getContentEl().style.setProperty("--sidet-composer-height", `${roundedHeight}px`);
    this.updateComposerReservedSpace();
    this.options.positionFloatingControls();
    this.options.syncScrollBottomButtonVisibility();

    if (
      options.preserveScroll &&
      previousHeight > 0 &&
      roundedHeight !== previousHeight &&
      this.options.getPendingScrollIntent() === "none" &&
      !this.layerRuntime.isActive()
    ) {
      this.scheduleComposerScrollRestore(preservedScrollTop);
    }
  }

  holdMobileComposerForAttachmentPicker(durationMs = 15000): void {
    this.layerRuntime.holdForAttachmentPicker(durationMs);
  }

  shouldHoldMobileComposerForAttachmentPicker(): boolean {
    return this.layerRuntime.shouldHoldForAttachmentPicker();
  }

  restoreComposerFocusAfterAttachment(): void {
    this.layerRuntime.restoreFocusAfterAttachment();
  }

  closeMobileComposerLayer(options: { blur: boolean }): void {
    this.clearNativeComposerActivation();
    this.closeComposerLayer(options);
  }

  /**
   * 输入态把底部留白置 0 并会夹紧滚动位置；回到休息态时留白重新计入，
   * 原本贴底阅读的对话需要重新贴到新的底部，否则最后一段会落回输入框下面。
   */
  private closeComposerLayer(options: { blur: boolean }): void {
    const scrollHost = this.usesMobileOverlayComposer()
      ? this.options.getScrollHost()
      : null;
    const restoreBottom =
      scrollHost !== null &&
      scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight <=
        this.options.bottomPinThreshold;
    this.layerRuntime.close(options);
    this.stopContentHostResizeObserver();
    this.focusedReservedSpace = null;
    this.focusedContentPaddingBottom = null;
    if (!scrollHost) {
      return;
    }
    if (restoreBottom) {
      this.options.setScrollHostTop(
        Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight)
      );
    }
    this.options.updatePinnedToBottom();
  }

  requestWorkspaceOwnershipCheck(trigger: string): void {
    this.workspaceOwnershipGuard.requestCheck(trigger);
  }

  syncMobileComposerLayerState(): void {
    this.layerRuntime.syncPresentationState();
  }

  scheduleViewportSync(): void {
    if (this.disposed) {
      return;
    }
    if (this.viewportSyncTimer !== null) {
      window.clearTimeout(this.viewportSyncTimer);
    }

    this.viewportSyncTimer = window.setTimeout(() => {
      this.viewportSyncTimer = null;
      this.applyViewportState();
    }, 36);
  }

  syncMobileComposerFocusState(isFocused: boolean): void {
    if (this.nativeActivationPointerId !== null) {
      this.options.onNativeActivationEvent?.(
        isFocused
          ? "native.focus.clears-pending"
          : "native.blur.clears-pending"
      );
    }
    this.clearNativeComposerActivation();
    if (!this.options.isPhoneLayout() || !this.options.isMobileRuntime()) {
      this.keyboardFollowRuntime.endFocus();
      this.closeComposerLayer({ blur: false });
      return;
    }

    if (isFocused) {
      if (!this.layerRuntime.isActive()) {
        if (document.activeElement === this.mainComposer.textareaEl) {
          this.mainComposer.textareaEl?.blur();
        }
        this.keyboardFollowRuntime.endFocus();
        this.layerRuntime.syncPresentationState();
        return;
      }
      this.keyboardFollowRuntime.beginFocus();
      this.layerRuntime.syncPresentationState();
      return;
    }

    this.keyboardFollowRuntime.endFocus();
    if (this.layerRuntime.isActive()) {
      this.keyboardFollowRuntime.scheduleLayerRestoreAfterBlur(() => {
        if (document.activeElement === this.mainComposer.textareaEl) {
          return;
        }
        this.closeComposerLayer({ blur: false });
        this.options.syncScrollAffordances();
      });
      return;
    }
    this.layerRuntime.syncPresentationState();
    this.syncComposerLayout();
    this.updateComposerReservedSpace();
    this.options.syncScrollAffordances();
  }

  private interruptForWorkspaceOwnershipLoss(
    trigger: string,
    detail?: MobileWorkspaceOwnershipLossDetail
  ): void {
    this.options.onNativeActivationEvent?.(`ownership.loss.${trigger}`);
    this.clearNativeComposerActivation();
    if (!this.layerRuntime.isActive()) {
      return;
    }

    const textareaEl = this.mainComposer.textareaEl;
    if (document.activeElement === textareaEl) {
      textareaEl?.blur();
    }
    this.keyboardFollowRuntime.interruptForHostOwnershipLoss(trigger);
    this.closeComposerLayer({ blur: false });
    this.options.syncScrollAffordances();
    recordChatScrollTrace("mobile-composer-workspace-ownership-restored", {
      trigger,
      ...(detail ?? {})
    });
  }

  cancelComposerScrollRestore(): void {
    this.composerScrollRestoreVersion += 1;
    if (this.composerScrollRestoreFrame !== null) {
      window.cancelAnimationFrame(this.composerScrollRestoreFrame);
      this.composerScrollRestoreFrame = null;
    }
  }

  private clearNativeComposerActivation(): void {
    this.nativeActivationPointerId = null;
  }

  private armTailCompatibilityGuard(): void {
    if (!this.tailCompatibilityGuardCleanup) {
      return;
    }
    this.tailCompatibilityGuardArmed = true;
  }

  private abortNativeComposerActivation(reason: string): void {
    this.options.onNativeActivationEvent?.(
      `native.activation.abort.${reason}`
    );
    this.clearNativeComposerActivation();
    if (
      document.activeElement === this.mainComposer.textareaEl ||
      !this.layerRuntime.isActive()
    ) {
      return;
    }
    this.keyboardFollowRuntime.endFocus();
    this.closeComposerLayer({ blur: false });
    this.options.syncScrollAffordances();
    recordChatScrollTrace("mobile-composer-native-activation-aborted", {
      reason
    });
  }

  private measureComposerLayout(
    textareaEl: HTMLTextAreaElement,
    textareaMirrorEl: HTMLDivElement
  ): ComposerLayout {
    textareaMirrorEl.textContent = this.getMirrorText();

    const styles = window.getComputedStyle(textareaEl);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 22;
    const paddingY = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom) || 24;
    const viewportHeight = window.innerHeight;
    const isPhoneLayout = this.options.isPhoneLayout();
    const minRows = isPhoneLayout ? 1 : 2;
    const maxRows = isPhoneLayout ? 5 : 7;
    const minHeight = Math.round(lineHeight * minRows + paddingY);
    const rowsHeight = Math.round(lineHeight * maxRows + paddingY);
    const viewportMaxHeight = Math.round(viewportHeight * (isPhoneLayout ? 0.28 : 0.34));
    const maxHeight = Math.max(minHeight, Math.min(rowsHeight, isPhoneLayout ? 164 : 220, viewportMaxHeight));
    const measuredHeight = Math.max(
      minHeight,
      Math.ceil(textareaMirrorEl.getBoundingClientRect().height)
    );
    const targetHeight = Math.max(minHeight, Math.min(measuredHeight, maxHeight));
    const overflowMode = measuredHeight > maxHeight + 1 ? "auto" : "hidden";
    const visibleRows = Math.max(
      minRows,
      Math.round((targetHeight - paddingY) / Math.max(lineHeight, 1))
    );

    return {
      targetHeight,
      overflowMode,
      visibleRows,
      canExpand: isPhoneLayout && measuredHeight > maxHeight + 2
    };
  }

  private updateComposerReservedSpace(): void {
    const isMobileOverlay = this.usesMobileOverlayComposer();
    let reservedSpace: number;
    if (this.options.isHomeState()) {
      reservedSpace = 0;
    } else if (isMobileOverlay) {
      if (this.layerRuntime.isActive()) {
        // 聚焦瞬间仍冻结休息态留白，避免滚动高度收缩把贴底内容夹紧下沉；
        // 键盘落定后改用真实几何值（focusedReservedSpace），让底部空白正好
        // 覆盖输入框与键盘，不因宿主是否变矮而多补或少补。
        reservedSpace = this.focusedReservedSpace ?? this.lastRestingReservedSpace;
      } else {
        reservedSpace = this.getMobileOverlayReservedSpace();
        this.lastRestingReservedSpace = reservedSpace;
      }
    } else if (this.usesDesktopOverlayComposer()) {
      reservedSpace = this.getDesktopOverlayReservedSpace();
    } else {
      reservedSpace = this.options.desktopBottomMessageGap;
    }

    // 逐帧路径只写 spacer 内联高度、不回写 lastReservedSpace；只看缓存会把
    // 「键盘期撑大后该还原」的收口误判成没变化，在内容流底部留下一段
    // 滚不回去的空白。缓存与真实内联高度都一致才跳过。
    const spacerEl = this.options.getMessagesBottomSpacerEl();
    const spacerHeight = `${reservedSpace}px`;
    if (
      reservedSpace === this.lastReservedSpace &&
      (!spacerEl || spacerEl.style.getPropertyValue("height") === spacerHeight)
    ) {
      return;
    }

    this.lastReservedSpace = reservedSpace;
    this.options.getContentEl().style.setProperty("--sidet-composer-reserved-space", `${reservedSpace}px`);
    spacerEl?.style.setProperty("height", spacerHeight);
  }

  /**
   * 键盘完全呈现后才读取真实几何：宿主把聊天区压矮、或只抬起 composer，
   * 都由 contentRect / wrapRect 反映。落定后继续观察内容区尺寸，宿主晚一步
   * 完成收缩时再校正一次，避免读到旧底缘把内容多顶上去。
   */
  private syncFocusedReservedSpace(): void {
    if (!this.layerRuntime.isActive() || !this.keyboardFollowRuntime.isFollowing()) {
      return;
    }
    // 主页休息位在页面流的槽位里，从不向内容流要键盘期留白
    // （updateComposerReservedSpace 对主页恒为 0）。这里若按对话几何记录
    // focusedReservedSpace 并起稳帧观察，主页底部 spacer 会被撑成键盘高度，
    // 失焦后留下一大段空白并让主页可滚动。
    if (this.options.isHomeState()) {
      // 主页不向内容流要留白，但仍要记全高底缘：发送首条消息后切到对话态，
      // 关闭键盘时才能按同一个全高口径收口。
      this.captureRestingContentBoxBottom();
      return;
    }
    this.focusedContentPaddingBottom = this.readContentPaddingBottom();
    const contentRect = this.options.getContentEl().getBoundingClientRect();
    const contentBoxBottom = contentRect.bottom - this.focusedContentPaddingBottom;
    if (
      this.restingContentBoxBottom === null ||
      contentBoxBottom > this.restingContentBoxBottom
    ) {
      // 记下见过的最大内容区底缘（全高）：关闭时宿主已收缩也能按同一口径算，
      // 快速回焦时也不会把收缩后的底缘误当成全高。
      this.restingContentBoxBottom = contentBoxBottom;
    }
    this.focusedReservedSpace = this.getMobileOverlayReservedSpace();
    this.updateComposerReservedSpace();
    this.observeContentHostResize();
    // 开场由 JS 逐帧驱动时，留白每帧由 onPresentationFrame 同步，不再另起
    // 观察循环抢同一帧；动画结束后（或落定 / 取消）再交给稳定观察吸收第二段。
    if (!this.keyboardFollowRuntime.isFramedOpeningActive()) {
      // 真机是两段式避让（系统先让、composer 后抬）。落定后再观察几帧，
      // 用最终几何校正，避免按第一段的旧底缘把键盘高度重复补一遍。
      this.startFocusedReservedSpaceStabilization();
    }
  }

  /**
   * 主页发出首条消息时 `isHomeState()` 从真变假，但键盘和输入层都还开着；
   * 主页分支从未记录 focusedReservedSpace，这里补一次，否则首条回复会落在
   * 键盘下面，直到失焦才恢复。
   */
  handleHomeStateExited(): void {
    if (this.disposed || this.options.isHomeState()) {
      return;
    }
    if (!this.layerRuntime.isActive() || !this.keyboardFollowRuntime.isFollowing()) {
      return;
    }
    this.syncFocusedReservedSpace();
  }

  private captureRestingContentBoxBottom(): void {
    const contentEl = this.options.getContentEl();
    if (typeof contentEl?.getBoundingClientRect !== "function") {
      return;
    }
    const contentRect = contentEl.getBoundingClientRect();
    const padding = this.focusedContentPaddingBottom ?? this.readContentPaddingBottom();
    const bottom = contentRect.bottom - padding;
    if (this.restingContentBoxBottom === null || bottom > this.restingContentBoxBottom) {
      this.restingContentBoxBottom = bottom;
    }
  }

  /**
   * 开场逐帧回调：只做与输入框同一帧的留白重算与补底。
   * 每帧只读一次内容区 rect、只写一次 spacer 高度，不再重算 pin / affordances /
   * 虚拟窗口；这些都在开场那一帧统一处理过，逐帧重做会把主线程拖出抖动。
   */
  private syncFocusedReservedSpaceFrame(visualComposerTop: number): void {
    if (!this.layerRuntime.isActive() || !this.keyboardFollowRuntime.isFollowing()) {
      return;
    }
    // 逐帧留白只服务对话内容流的贴底阅读；主页不滚内容，写进去只会变成
    // 键盘高度的底部空白（且收口按“值没变”跳过还原，会一直留着）。
    if (this.options.isHomeState()) {
      return;
    }
    const contentRect = this.options.getContentEl().getBoundingClientRect();
    const next = resolveMobileComposerReservedSpace({
      scrollContentBottom:
        contentRect.bottom - (this.focusedContentPaddingBottom ?? 0),
      composerTop: visualComposerTop,
      gap: this.options.desktopBottomMessageGap
    });
    if (next === this.focusedReservedSpace) {
      return;
    }
    this.focusedReservedSpace = next;
    // 逐帧只写 spacer 内联高度；--sidet-composer-reserved-space 在收口时统一写。
    this.options.getMessagesBottomSpacerEl()?.style.setProperty(
      "height",
      `${next}px`
    );
    this.options.onKeyboardPresentationFrame?.();
  }

  /**
   * 贴底关闭才走共帧下落：起点距离底部在阈值内、且键盘期几何存在。
   * 浏览中聚焦（内容没被顶到底）或用户已滚动时保持原来的关闭路径。
   */
  private shouldFollowKeyboardClose(): boolean {
    // 主页的休息位是主页槽位（页面流里），不是 layer 底边；共帧下落的终点
    // 只对对话内容流的贴底休息位成立。主页继续走 layer 一次性交接，否则
    // Android 只在 didHide 才开始下落，键盘已收完，输入框和 chip 还会在
    // 底部多停一截再跳回主页。
    if (this.options.isHomeState()) {
      return false;
    }
    if (
      this.focusedReservedSpace === null ||
      this.restingContentBoxBottom === null
    ) {
      return false;
    }
    const scrollHost = this.options.getScrollHost();
    const distance =
      scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight;
    return distance <= this.options.bottomPinThreshold;
  }

  /** 抓取关闭起点：全高底缘、内容顶边、spacer 的内容坐标。 */
  private beginKeyboardCloseFollow(): void {
    this.closeFollowActive = false;
    this.closingSpacerContentTop = null;
    this.closingContentBoxBottom = null;
    if (this.restingContentBoxBottom === null) {
      return;
    }
    const contentEl = this.options.getContentEl();
    const contentRect = contentEl.getBoundingClientRect();
    const scrollHost = this.options.getScrollHost();
    const padding =
      this.focusedContentPaddingBottom ?? this.readContentPaddingBottom();
    const currentReserved = this.focusedReservedSpace ?? this.lastReservedSpace;
    this.closingContentTop = contentRect.top;
    this.closingContentBoxBottom = this.restingContentBoxBottom;
    this.closingSpacerContentTop =
      scrollHost.scrollTop +
      (contentRect.bottom - padding - currentReserved - contentRect.top);
    this.closeFollowActive = true;
  }

  /**
   * 共帧关闭每帧：用全高底缘算留白，把 spacer 顶边钉在输入框上方；
   * 内容随输入框一起退，宿主还没把内容区还原也不会在 didHide 跳一下。
   */
  private syncKeyboardCloseFrame(visualComposerTop: number): void {
    if (
      !this.closeFollowActive ||
      this.closingSpacerContentTop === null ||
      this.closingContentBoxBottom === null
    ) {
      return;
    }
    const gap = this.options.desktopBottomMessageGap;
    const reserved = resolveMobileComposerReservedSpace({
      scrollContentBottom: this.closingContentBoxBottom,
      composerTop: visualComposerTop,
      gap
    });
    this.focusedReservedSpace = reserved;
    this.options.getMessagesBottomSpacerEl()?.style.setProperty(
      "height",
      `${reserved}px`
    );
    const target =
      this.closingSpacerContentTop +
      this.closingContentTop +
      gap -
      visualComposerTop;
    const scrollHost = this.options.getScrollHost();
    const maxScrollTop = Math.max(
      0,
      scrollHost.scrollHeight - scrollHost.clientHeight
    );
    this.options.setScrollHostTop(
      Math.min(Math.max(0, target), maxScrollTop)
    );
  }

  /** 共帧关闭收口：输入框已到休息位，撤回键盘期留白并刷新底部状态。 */
  private finishKeyboardCloseFollow(): void {
    if (!this.closeFollowActive) {
      this.clearFocusedReservedSpace();
      return;
    }
    this.closeFollowActive = false;
    this.closingSpacerContentTop = null;
    this.closingContentBoxBottom = null;
    this.stopContentHostResizeObserver();
    this.focusedReservedSpace = null;
    this.focusedContentPaddingBottom = null;
    this.updateComposerReservedSpace();
    this.schedulePostCloseBottomSync();
  }

  /**
   * 宿主可能在 didHide 才把内容区还原；这时滚动位置已经是休息态值，
   * 只差 pin / affordances 的刷新。有界逐帧等一次几何稳定，不写死时间。
   */
  private schedulePostCloseBottomSync(): void {
    if (this.postCloseBottomSyncFrame !== null) {
      return;
    }
    this.postCloseBottomSyncPending = true;
    let frames = 0;
    const tick = () => {
      this.postCloseBottomSyncFrame = null;
      if (!this.postCloseBottomSyncPending) {
        return;
      }
      const scrollHost = this.options.getScrollHost();
      const distance =
        scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight;
      frames += 1;
      if (distance > this.options.bottomPinThreshold && frames < 20) {
        this.postCloseBottomSyncFrame = window.requestAnimationFrame(tick);
        return;
      }
      this.postCloseBottomSyncPending = false;
      this.options.updatePinnedToBottom();
      this.options.syncScrollAffordances();
    };
    this.postCloseBottomSyncFrame = window.requestAnimationFrame(tick);
  }

  private cancelPostCloseBottomSync(): void {
    this.postCloseBottomSyncPending = false;
    if (this.postCloseBottomSyncFrame !== null) {
      window.cancelAnimationFrame(this.postCloseBottomSyncFrame);
      this.postCloseBottomSyncFrame = null;
    }
  }

  private readContentPaddingBottom(): number {
    const value = Number.parseFloat(
      window.getComputedStyle(this.options.getContentEl()).paddingBottom
    );
    return Number.isFinite(value) ? value : 0;
  }

  private startFocusedReservedSpaceStabilization(): void {
    this.cancelFocusedReservedSpaceStabilization();
    let previous = this.focusedReservedSpace;
    let stableFrames = 0;
    let totalFrames = 0;
    const tick = () => {
      this.focusedStabilizeFrame = null;
      if (!this.layerRuntime.isActive() || !this.keyboardFollowRuntime.isFollowing()) {
        return;
      }
      const next = this.getMobileOverlayReservedSpace();
      if (next === previous) {
        stableFrames += 1;
      } else {
        previous = next;
        stableFrames = 0;
        this.focusedReservedSpace = next;
        this.updateComposerReservedSpace();
        this.options.onKeyboardReservedSpaceChanged?.();
      }
      totalFrames += 1;
      if (stableFrames < 12 && totalFrames < 45) {
        this.focusedStabilizeFrame = window.requestAnimationFrame(tick);
      }
    };
    this.focusedStabilizeFrame = window.requestAnimationFrame(tick);
  }

  private cancelFocusedReservedSpaceStabilization(): void {
    if (this.focusedStabilizeFrame !== null) {
      window.cancelAnimationFrame(this.focusedStabilizeFrame);
      this.focusedStabilizeFrame = null;
    }
  }

  private observeContentHostResize(): void {
    if (this.contentHostResizeObserver || typeof ResizeObserver === "undefined") {
      return;
    }
    this.contentHostResizeObserver = new ResizeObserver(() => {
      this.scheduleFocusedReservedSpaceSync();
    });
    this.contentHostResizeObserver.observe(this.options.getContentEl());
  }

  private scheduleFocusedReservedSpaceSync(): void {
    if (this.contentHostResizeFrame !== null) {
      return;
    }
    this.contentHostResizeFrame = window.requestAnimationFrame(() => {
      this.contentHostResizeFrame = null;
      if (this.keyboardFollowRuntime.isFramedOpeningActive()) {
        return;
      }
      this.startFocusedReservedSpaceStabilization();
    });
  }

  private stopContentHostResizeObserver(): void {
    this.contentHostResizeObserver?.disconnect();
    this.contentHostResizeObserver = null;
    this.cancelFocusedReservedSpaceStabilization();
    if (this.contentHostResizeFrame !== null) {
      window.cancelAnimationFrame(this.contentHostResizeFrame);
      this.contentHostResizeFrame = null;
    }
  }

  private clearFocusedReservedSpace(): void {
    this.stopContentHostResizeObserver();
    this.cancelPostCloseBottomSync();
    this.closeFollowActive = false;
    this.closingSpacerContentTop = null;
    this.closingContentBoxBottom = null;
    if (this.focusedReservedSpace === null) {
      return;
    }
    // 键盘收起会把留白还原成休息态值；贴着底看时同步跟到新的底部，
    // 否则最后一段会停在键盘期的位置，和回落后的 composer 拉开空档。
    const scrollHost = this.options.getScrollHost();
    const restoreBottom =
      scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight <=
        this.options.bottomPinThreshold;
    this.focusedReservedSpace = null;
    this.updateComposerReservedSpace();
    this.focusedContentPaddingBottom = null;
    if (restoreBottom) {
      this.options.setScrollHostTop(
        Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight)
      );
    }
    this.options.updatePinnedToBottom();
  }

  private getMirrorText(): string {
    return this.options.getDraftText().length > 0 ? `${this.options.getDraftText()}\n` : " \n";
  }

  private applyViewportState(): void {
    if (this.disposed) {
      return;
    }
    this.options.syncLayoutClasses();
    this.syncComposerLayout();
    this.updateComposerReservedSpace();
    this.options.positionFloatingControls();
    this.options.syncScrollAffordances();
  }

  private usesMobileOverlayComposer(): boolean {
    return this.options.isPhoneLayout() && this.options.isMobileRuntime();
  }

  private usesDesktopOverlayComposer(): boolean {
    return !this.options.isMobileRuntime();
  }

  private getMobileOverlayReservedSpace(): number {
    const gap = this.options.desktopBottomMessageGap;
    const contentEl = this.options.getContentEl();
    const contentRect = contentEl.getBoundingClientRect();
    const wrapRect = this.mainComposer.composerWrapEl?.getBoundingClientRect() ?? null;
    if (wrapRect && wrapRect.height > 0 && contentRect.height > 0) {
      const contentPaddingBottom =
        this.focusedContentPaddingBottom ?? this.readContentPaddingBottom();
      return resolveMobileComposerReservedSpace({
        scrollContentBottom: contentRect.bottom - contentPaddingBottom,
        composerTop: wrapRect.top,
        gap
      });
    }

    const wrapHeight = Math.round(wrapRect?.height ?? 0);
    if (wrapHeight > 0) {
      return wrapHeight + gap;
    }

    return this.lastComposerHeight > 0
      ? this.lastComposerHeight + 32
      : gap;
  }

  private getDesktopOverlayReservedSpace(): number {
    const desktopOverlayGap = Math.max(4, Math.round(this.options.desktopBottomMessageGap / 2));
    const wrapHeight = Math.round(this.mainComposer.composerWrapEl?.getBoundingClientRect().height ?? 0);
    if (wrapHeight > 0) {
      return wrapHeight + desktopOverlayGap;
    }

    return this.lastComposerHeight > 0
      ? this.lastComposerHeight + 24
      : this.options.desktopBottomMessageGap;
  }

  private scheduleComposerScrollRestore(scrollTop: number): void {
    this.cancelComposerScrollRestore();
    recordChatScrollTrace("schedule-composer-scroll-restore", {
      requestedScrollTop: scrollTop,
      pendingScrollIntent: this.options.getPendingScrollIntent()
    });
    const version = ++this.composerScrollRestoreVersion;
    this.composerScrollRestoreFrame = window.requestAnimationFrame(() => {
      this.composerScrollRestoreFrame = null;
      if (
        version !== this.composerScrollRestoreVersion ||
        this.options.getPendingScrollIntent() !== "none"
      ) {
        recordChatScrollTrace("skip-composer-scroll-restore", {
          requestedScrollTop: scrollTop,
          pendingScrollIntent: this.options.getPendingScrollIntent(),
          version,
          currentVersion: this.composerScrollRestoreVersion
        });
        return;
      }

      recordChatScrollTrace("apply-composer-scroll-restore", {
        requestedScrollTop: scrollTop
      });
      this.options.setScrollHostTop(scrollTop);
      this.options.updatePinnedToBottom();
      this.options.syncScrollAffordances();
    });
  }
}
