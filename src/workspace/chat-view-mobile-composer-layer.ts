interface ChatViewMobileComposerLayerRuntimeOptions {
  getContentEl: () => HTMLElement;
  getRootEl: () => HTMLElement | null;
  getComposerWrapEl: () => HTMLDivElement | null;
  getComposerTextareaEl: () => HTMLTextAreaElement | null;
  focusComposerTextarea: (textareaEl: HTMLTextAreaElement | null) => void;
  syncComposerLayout: () => void;
  syncComposerButtons: () => void;
  scheduleViewportSync: () => void;
  updatePinnedToBottom: () => void;
  syncScrollBottomButtonVisibility: () => void;
  onLayerChange: () => void;
  isPhoneLayout: () => boolean;
  isMobileRuntime: () => boolean;
}

const PRESENTATION_CLASSES = [
  "is-phone-layout",
  "is-mobile-runtime",
  "is-android-runtime",
  "is-ios-runtime"
] as const;

export class ChatViewMobileComposerLayerRuntime {
  private layerEl: HTMLDivElement | null = null;
  private originalParentEl: ParentNode | null = null;
  private originalNextSibling: ChildNode | null = null;
  private attachmentPickerHeld = false;
  private attachmentPickerHoldTimer: number | null = null;
  private attachmentFocusRestoreFrame: number | null = null;
  private active = false;

  constructor(private readonly options: ChatViewMobileComposerLayerRuntimeOptions) {}

  getLayerEl(): HTMLDivElement | null {
    return this.layerEl;
  }

  isActive(): boolean {
    return this.hasActiveLayerOwnership();
  }

  prepareForFocus(): boolean {
    this.clearStaleActiveState();
    if (this.hasActiveLayerOwnership()) {
      return true;
    }
    if (!this.canUseLayer()) {
      return false;
    }
    return this.open();
  }

  activateForFocus(): boolean {
    const contentEl = this.options.getContentEl();
    const anchorScrollTop = contentEl.scrollTop;
    if (!this.prepareForFocus()) {
      return false;
    }

    const textareaEl = this.options.getComposerTextareaEl();
    if (!textareaEl) {
      return false;
    }
    if (contentEl.ownerDocument.activeElement !== textareaEl) {
      this.options.focusComposerTextarea(textareaEl);
    }

    // Keep the 90-point baseline ordering: iOS may scroll the host while
    // focus() runs, so the reading anchor must be restored after focus.
    contentEl.scrollTop = anchorScrollTop;
    this.options.updatePinnedToBottom();
    this.options.syncScrollBottomButtonVisibility();
    return contentEl.ownerDocument.activeElement === textareaEl;
  }

  close(options: { blur: boolean }): void {
    const textareaEl = this.options.getComposerTextareaEl();
    if (options.blur && document.activeElement === textareaEl) {
      textareaEl?.blur();
    }

    const composerWrapEl = this.options.getComposerWrapEl();
    if (composerWrapEl && this.originalParentEl) {
      if (
        this.originalNextSibling &&
        this.originalNextSibling.parentNode === this.originalParentEl
      ) {
        this.originalParentEl.insertBefore(composerWrapEl, this.originalNextSibling);
      } else {
        this.originalParentEl.appendChild(composerWrapEl);
      }
    }

    const wasActive = this.active;
    this.active = false;
    this.originalParentEl = null;
    this.originalNextSibling = null;
    this.layerEl?.classList.remove("is-visible");
    this.options.getContentEl().classList.remove("has-mobile-composer-layer");
    if (wasActive) {
      this.options.onLayerChange();
      this.options.syncComposerLayout();
      this.options.syncComposerButtons();
      this.options.scheduleViewportSync();
    }
  }

  release(): void {
    this.clearAttachmentFocusLifecycle();
    this.close({ blur: false });
    this.layerEl?.remove();
    this.layerEl = null;
  }

  syncPresentationState(): void {
    const layerEl = this.layerEl;
    if (!layerEl) {
      return;
    }

    const contentEl = this.options.getContentEl();
    for (const className of PRESENTATION_CLASSES) {
      layerEl.classList.toggle(className, contentEl.classList.contains(className));
    }

  }

  holdForAttachmentPicker(durationMs = 15000): void {
    if (!this.canUseLayer()) {
      return;
    }
    this.attachmentPickerHeld = true;
    if (this.attachmentPickerHoldTimer !== null) {
      window.clearTimeout(this.attachmentPickerHoldTimer);
    }
    this.attachmentPickerHoldTimer = window.setTimeout(() => {
      this.attachmentPickerHoldTimer = null;
      this.attachmentPickerHeld = false;
    }, durationMs);
  }

  shouldHoldForAttachmentPicker(): boolean {
    return this.canUseLayer() && this.attachmentPickerHeld;
  }

  restoreFocusAfterAttachment(): void {
    this.attachmentPickerHeld = false;
    if (this.attachmentPickerHoldTimer !== null) {
      window.clearTimeout(this.attachmentPickerHoldTimer);
      this.attachmentPickerHoldTimer = null;
    }
    if (!this.canUseLayer()) {
      this.options.focusComposerTextarea(this.options.getComposerTextareaEl());
      return;
    }

    this.prepareForFocus();
    if (this.attachmentFocusRestoreFrame !== null) {
      window.cancelAnimationFrame(this.attachmentFocusRestoreFrame);
    }
    this.attachmentFocusRestoreFrame = window.requestAnimationFrame(() => {
      this.attachmentFocusRestoreFrame = null;
      if (!this.options.getRootEl()?.isConnected || !this.active) {
        return;
      }
      const textareaEl = this.options.getComposerTextareaEl();
      this.options.focusComposerTextarea(textareaEl);
      const length = textareaEl?.value.length ?? 0;
      textareaEl?.setSelectionRange(length, length);
      this.options.scheduleViewportSync();
    });
  }

  private open(): boolean {
    const composerWrapEl = this.options.getComposerWrapEl();
    if (!composerWrapEl || !this.options.getComposerTextareaEl()) {
      return false;
    }

    const layerEl = this.ensureLayer();
    const contentEl = this.options.getContentEl();
    const anchorScrollTop = contentEl.scrollTop;
    this.originalParentEl = composerWrapEl.parentNode;
    this.originalNextSibling = composerWrapEl.nextSibling;
    if (!this.originalParentEl) {
      return false;
    }

    this.active = true;
    this.syncPresentationState();
    layerEl.classList.add("is-visible");
    layerEl.appendChild(composerWrapEl);
    contentEl.classList.add("has-mobile-composer-layer");
    this.options.onLayerChange();
    this.options.syncComposerLayout();
    this.options.syncComposerButtons();

    contentEl.scrollTop = anchorScrollTop;
    this.options.updatePinnedToBottom();
    this.options.syncScrollBottomButtonVisibility();
    return true;
  }

  private ensureLayer(): HTMLDivElement {
    if (this.layerEl) {
      if (!this.layerEl.isConnected) {
        this.options.getContentEl().ownerDocument.body.appendChild(this.layerEl);
      }
      return this.layerEl;
    }

    const ownerDocument = this.options.getContentEl().ownerDocument;
    const layerEl = ownerDocument.createElement("div");
    layerEl.className = "sidet-chat-view sidet-mobile-composer-layer";
    ownerDocument.body.appendChild(layerEl);
    this.layerEl = layerEl;
    this.syncPresentationState();
    return layerEl;
  }

  private hasActiveLayerOwnership(): boolean {
    const layerEl = this.layerEl;
    const composerWrapEl = this.options.getComposerWrapEl();
    return (
      this.active &&
      Boolean(layerEl?.isConnected) &&
      Boolean(composerWrapEl) &&
      composerWrapEl?.parentNode === layerEl
    );
  }

  private clearStaleActiveState(): void {
    if (!this.active || this.hasActiveLayerOwnership()) {
      return;
    }

    this.active = false;
    this.originalParentEl = null;
    this.originalNextSibling = null;
    this.layerEl?.classList.remove("is-visible");
    this.options.getContentEl().classList.remove("has-mobile-composer-layer");
    this.options.onLayerChange();
  }

  private canUseLayer(): boolean {
    return (
      this.options.isPhoneLayout() &&
      this.options.isMobileRuntime() &&
      Boolean(this.options.getRootEl()?.isConnected)
    );
  }

  private clearAttachmentFocusLifecycle(): void {
    if (this.attachmentFocusRestoreFrame !== null) {
      window.cancelAnimationFrame(this.attachmentFocusRestoreFrame);
      this.attachmentFocusRestoreFrame = null;
    }
    if (this.attachmentPickerHoldTimer !== null) {
      window.clearTimeout(this.attachmentPickerHoldTimer);
      this.attachmentPickerHoldTimer = null;
    }
    this.attachmentPickerHeld = false;
  }
}
