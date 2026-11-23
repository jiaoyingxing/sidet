import { ChatViewMobileComposerLayerRuntime } from "./chat-view-mobile-composer-layer";
import { ChatViewMobileKeyboardFollowRuntime } from "./chat-view-mobile-keyboard-follow";
import { ChatViewMobileWorkspaceOwnershipGuard } from "./chat-view-mobile-workspace-ownership";
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
  getPendingScrollIntent: () => "none" | "after-send" | "conversation-switch-or-initial-open";
  hasComposerResizeObserver: () => boolean;
  isHomeState: () => boolean;
  onComposerLayerChange: (active: boolean) => void;
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
  private viewportSyncTimer: number | null = null;
  private nativeActivationPointerId: number | null = null;
  private composerScrollRestoreFrame: number | null = null;
  private composerScrollRestoreVersion = 0;
  private canExpandComposer = false;
  private lastComposerHeight = 0;
  private lastTextareaHeight = 0;
  private lastOverflowMode: "hidden" | "auto" = "hidden";
  private lastReservedSpace = 0;
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
      isMobileRuntime: () => this.options.isMobileRuntime()
    });
    this.workspaceOwnershipGuard =
      new ChatViewMobileWorkspaceOwnershipGuard({
        getRootEl: () => this.options.getRootEl(),
        getViewportWidth: () => window.innerWidth,
        isLayerActive: () => this.layerRuntime.isActive(),
        onOwnershipLoss: (trigger) => {
          this.interruptForWorkspaceOwnershipLoss(trigger);
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
  }

  cancelComposerActivationPointer(pointerId: number): void {
    if (this.nativeActivationPointerId !== pointerId) {
      return;
    }
    this.abortNativeComposerActivation("pointer-cancel");
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
    if (this.viewportSyncTimer !== null) {
      window.clearTimeout(this.viewportSyncTimer);
      this.viewportSyncTimer = null;
    }
    this.clearNativeComposerActivation();
    this.cancelComposerScrollRestore();
    this.workspaceOwnershipGuard.stop();
    this.keyboardFollowRuntime.release();
    this.layerRuntime.release();
    this.lastComposerHeight = 0;
    this.lastTextareaHeight = 0;
    this.lastOverflowMode = "hidden";
    this.lastReservedSpace = 0;
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
    this.layerRuntime.close(options);
  }

  requestWorkspaceOwnershipCheck(trigger: string): void {
    this.workspaceOwnershipGuard.requestCheck(trigger);
  }

  syncMobileComposerLayerState(): void {
    this.layerRuntime.syncPresentationState();
  }

  scheduleViewportSync(): void {
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
      this.layerRuntime.close({ blur: false });
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
        this.layerRuntime.close({ blur: false });
        this.options.syncScrollAffordances();
      });
      return;
    }
    this.layerRuntime.syncPresentationState();
    this.syncComposerLayout();
    this.updateComposerReservedSpace();
    this.options.syncScrollAffordances();
  }

  private interruptForWorkspaceOwnershipLoss(trigger: string): void {
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
    this.layerRuntime.close({ blur: false });
    this.options.syncScrollAffordances();
    recordChatScrollTrace("mobile-composer-workspace-ownership-restored", {
      trigger
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
    this.layerRuntime.close({ blur: false });
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
    const reservedSpace = this.options.isHomeState()
      ? 0
      : this.usesMobileOverlayComposer()
      ? this.layerRuntime.isActive()
        ? 0
        : this.getMobileRestingReservedSpace()
      : this.usesDesktopOverlayComposer()
        ? this.getDesktopOverlayReservedSpace()
        : this.options.desktopBottomMessageGap;

    if (reservedSpace === this.lastReservedSpace) {
      return;
    }

    this.lastReservedSpace = reservedSpace;
    this.options.getContentEl().style.setProperty("--sidet-composer-reserved-space", `${reservedSpace}px`);
    this.options.getMessagesBottomSpacerEl()?.style.setProperty("height", `${reservedSpace}px`);
  }

  private getMirrorText(): string {
    return this.options.getDraftText().length > 0 ? `${this.options.getDraftText()}\n` : " \n";
  }

  private applyViewportState(): void {
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
    const activeComposerEl = this.mainComposer.composerWrapEl;
    const wrapHeight = Math.round(activeComposerEl?.getBoundingClientRect().height ?? 0);
    if (wrapHeight > 0) {
      return wrapHeight + this.options.desktopBottomMessageGap;
    }

    return this.lastComposerHeight > 0
      ? this.lastComposerHeight + 32
      : this.options.desktopBottomMessageGap;
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

  private getMobileRestingReservedSpace(): number {
    if (!this.shouldReserveMobileRestingComposerSpace()) {
      return 0;
    }

    return this.getMobileOverlayReservedSpace();
  }

  private shouldReserveMobileRestingComposerSpace(): boolean {
    if (!this.options.isPhoneLayout() || !this.options.isMobileRuntime()) {
      return false;
    }

    const contentEl = this.options.getContentEl();
    const overflowWithoutCurrentSpacer =
      contentEl.scrollHeight - contentEl.clientHeight - this.lastReservedSpace;
    return overflowWithoutCurrentSpacer > 24;
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
