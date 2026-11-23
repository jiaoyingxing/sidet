import { recordChatScrollTrace } from "./chat-scroll-trace";
import {
  beginIosKeyboardPhaseDiagnosticCycle,
  IosKeyboardPhaseDiagnosticPhase,
  recordIosKeyboardPhaseDiagnosticSample
} from "./chat-view-mobile-keyboard-phase-diagnostics";

interface ChatViewMobileKeyboardFollowRuntimeOptions {
  getContentEl: () => HTMLElement;
  getStableHostEl: () => HTMLElement | null;
  getActiveComposerLayer: () => HTMLElement | null;
  getActiveComposerTextarea: () => HTMLTextAreaElement | null;
  isComposerLayerActive: () => boolean;
  isPhoneLayout: () => boolean;
  isMobileRuntime: () => boolean;
}

interface IosPhaseDiagnosticViewportSnapshot {
  innerHeight: number | null;
  scrollY: number | null;
  visualViewportHeight: number | null;
  visualViewportOffsetTop: number | null;
  visualViewportPageTop: number | null;
}

const HOST_SURFACE_MIN_DURATION_MS = 100;
const HOST_SURFACE_MAX_DURATION_MS = 250;
const LAYER_CUTOVER_MIN_DELAY_MS = 32;
const LAYER_CUTOVER_MAX_DELAY_MS = 72;
const LAYER_CUTOVER_MIN_TRAVEL_PX = 18;
const LAYER_CUTOVER_MAX_TRAVEL_PX = 40;
const IOS_FULL_HEIGHT_VIEWPORT_TOLERANCE_PX = 2;
const CAPACITOR_KEYBOARD_EVENT_NAMES = [
  "keyboardWillShow",
  "keyboardDidShow",
  "keyboardWillHide",
  "keyboardDidHide"
] as const;

type HostActivationFailure =
  | "focus-inactive"
  | "runtime-gate"
  | "missing-host"
  | "missing-composer"
  | "composer-parent-mismatch";

export class ChatViewMobileKeyboardFollowRuntime {
  private disposeCallbacks: Array<() => void> = [];
  private hostAnimationTimer: number | null = null;
  private hostCloseTimer: number | null = null;
  private caretRevealTimer: number | null = null;
  private iosDockSettleFrame: number | null = null;
  private layerRestoreTimer: number | null = null;
  private environmentFrame: number | null = null;
  private pendingLayerRestore: (() => void) | null = null;
  private layerRestoreCutoverDelay: number | null = null;
  private hostEl: HTMLElement | null = null;
  private openingInset: number | null = null;
  private appliedInset: number | null = null;
  private presentedHeight = 0;
  private animationEndsAt = 0;
  private isBound = false;
  private isFocusActive = false;
  private isClosing = false;
  private hasObservedIosHostPan = false;
  private isIosHostPanActive = false;
  private awaitingKeyboardDidHide = false;
  private lastHostActivationFailure: HostActivationFailure | null = null;
  private iosPhaseDiagnosticCycleId: number | null = null;
  private iosPhaseDiagnosticFrames = new Set<number>();

  constructor(private readonly options: ChatViewMobileKeyboardFollowRuntimeOptions) {}

  bind(): void {
    if (this.isBound) {
      return;
    }
    this.isBound = true;

    for (const eventName of CAPACITOR_KEYBOARD_EVENT_NAMES) {
      const onKeyboardEvent = (event: Event) => {
        const viewportSnapshot = this.readIosPhaseDiagnosticViewportSnapshot();
        const keyboardHeight = readKeyboardEventHeight(event);
        this.handleKeyboardEvent(event, keyboardHeight);
        this.captureIosPhaseDiagnosticTriplet(
          event.type,
          viewportSnapshot,
          keyboardHeight
        );
      };
      window.addEventListener(eventName, onKeyboardEvent);
      this.disposeCallbacks.push(() => {
        window.removeEventListener(eventName, onKeyboardEvent);
      });
    }

    const visualViewport = window.visualViewport;
    if (visualViewport) {
      const onVisualViewportResize = () => {
        const viewportSnapshot = this.readIosPhaseDiagnosticViewportSnapshot();
        this.handleVisualViewportChange("visualViewport.resize");
        this.captureIosPhaseDiagnosticTriplet(
          "visualViewport.resize",
          viewportSnapshot
        );
      };
      const onVisualViewportScroll = () => {
        const viewportSnapshot = this.readIosPhaseDiagnosticViewportSnapshot();
        this.handleVisualViewportChange("visualViewport.scroll");
        this.captureIosPhaseDiagnosticTriplet(
          "visualViewport.scroll",
          viewportSnapshot
        );
      };
      visualViewport.addEventListener("resize", onVisualViewportResize);
      visualViewport.addEventListener("scroll", onVisualViewportScroll);
      this.disposeCallbacks.push(() => {
        visualViewport.removeEventListener("resize", onVisualViewportResize);
        visualViewport.removeEventListener("scroll", onVisualViewportScroll);
      });
    }

    const onOrientationChange = () => this.handleEnvironmentReset("orientationchange");
    const onVisibilityChange = () => {
      if (document.hidden) {
        this.handleEnvironmentReset("hidden");
        return;
      }
      if (this.isFocusActive && this.canManageKeyboard()) {
        this.scheduleEnvironmentReactivation();
      }
    };
    window.addEventListener("orientationchange", onOrientationChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    this.disposeCallbacks.push(() => {
      window.removeEventListener("orientationchange", onOrientationChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
  }

  release(): void {
    this.isFocusActive = false;
    this.cancelIosPhaseDiagnosticFrames();
    this.iosPhaseDiagnosticCycleId = null;
    this.cancelPendingLayerRestore();
    this.cancelHostCloseTimer();
    this.cancelIosDockSettle();
    this.cancelEnvironmentFrame();
    this.releaseHost("runtime-release");
    for (const dispose of this.disposeCallbacks) {
      dispose();
    }
    this.disposeCallbacks = [];
    this.isBound = false;
  }

  beginFocus(): void {
    this.isFocusActive = true;
    this.cancelIosPhaseDiagnosticFrames();
    if (this.shouldCollectIosPhaseDiagnostics()) {
      this.iosPhaseDiagnosticCycleId =
        beginIosKeyboardPhaseDiagnosticCycle("focus.begin");
    } else {
      this.iosPhaseDiagnosticCycleId = null;
    }
    this.cancelPendingLayerRestore();
    this.cancelIosDockSettle();
    this.cancelEnvironmentFrame();

    if (!this.canManageKeyboard()) {
      this.cancelHostCloseTimer();
      this.releaseHost("runtime-gate");
      this.lastHostActivationFailure = "runtime-gate";
      this.captureIosPhaseDiagnosticTriplet("focus.begin");
      return;
    }

    if (
      this.isClosing &&
      this.hostEl &&
      this.presentedHeight > 0 &&
      this.isActiveComposerOwnedBy(this.hostEl)
    ) {
      this.cancelHostCloseTimer();
      this.isClosing = false;
      this.lastHostActivationFailure = null;
      recordChatScrollTrace("mobile-keyboard-host-refocus-kept", {
        presentedHeight: this.presentedHeight
      });
      this.captureIosPhaseDiagnosticTriplet("focus.begin");
      return;
    }
    if (this.isClosing) {
      this.cancelHostCloseTimer();
      this.releaseHost("focus-restart");
    }
    this.isClosing = false;
    this.activateHost();
    this.captureIosPhaseDiagnosticTriplet("focus.begin");
  }

  endFocus(): void {
    this.isFocusActive = false;
    this.cancelIosDockSettle();
    this.cancelEnvironmentFrame();
    if (!this.hostEl) {
      this.captureIosPhaseDiagnosticTriplet("focus.end");
      return;
    }
    this.isClosing = true;
    if (!this.awaitingKeyboardDidHide) {
      this.beginHostClose("focus-end");
    }
    this.captureIosPhaseDiagnosticTriplet("focus.end");
  }

  interruptForHostOwnershipLoss(trigger: string): void {
    this.isFocusActive = false;
    this.cancelIosPhaseDiagnosticFrames();
    this.cancelPendingLayerRestore();
    this.cancelHostCloseTimer();
    this.cancelIosDockSettle();
    this.cancelEnvironmentFrame();
    this.releaseHost(`host-ownership-loss:${trigger}`);
    this.isClosing = false;
    this.captureIosPhaseDiagnosticTriplet("host-ownership-loss");
  }

  scheduleLayerRestoreAfterBlur(restoreLayer: () => void): void {
    this.cancelPendingLayerRestore();
    if (this.hostEl || this.isClosing) {
      this.pendingLayerRestore = restoreLayer;
      this.schedulePendingLayerRestoreAtCutover("blur");
      return;
    }
    this.layerRestoreTimer = window.setTimeout(() => {
      this.layerRestoreTimer = null;
      restoreLayer();
    }, 0);
  }

  handleActiveComposerLayerChange(): void {
    if (!this.isFocusActive || !this.canManageKeyboard()) {
      return;
    }
    const activeLayerEl = this.options.getActiveComposerLayer();
    if (
      this.hostEl &&
      activeLayerEl &&
      (activeLayerEl.parentElement === this.hostEl ||
        activeLayerEl.parentNode === this.hostEl)
    ) {
      this.clearLegacyChildPosition(activeLayerEl);
      return;
    }
    this.releaseHost("active-layer-change");
    this.activateHost();
  }

  isFollowing(): boolean {
    return this.hostEl !== null && this.presentedHeight > 0;
  }

  isManagingKeyboardViewport(): boolean {
    return this.hostEl !== null || this.isClosing;
  }

  private handleKeyboardEvent(
    event: Event,
    keyboardHeight = readKeyboardEventHeight(event)
  ): void {
    if (event.type === "keyboardWillShow" || event.type === "keyboardDidShow") {
      if (
        this.isFocusActive &&
        this.canManageKeyboard() &&
        keyboardHeight !== null &&
        keyboardHeight > 0
      ) {
        this.awaitingKeyboardDidHide = true;
        if (this.presentedHeight <= 0) {
          this.presentHost(keyboardHeight, event.type);
        } else {
          recordChatScrollTrace("mobile-keyboard-host-show-confirmed", {
            trigger: event.type,
            confirmedHeight: Math.round(keyboardHeight),
            presentedHeight: this.presentedHeight
          });
        }
        if (event.type === "keyboardDidShow") {
          this.scheduleIosDockSettle(event.type);
        }
      }
      return;
    }

    this.cancelIosDockSettle();
    if (event.type === "keyboardDidHide") {
      this.awaitingKeyboardDidHide = false;
    }
    if (this.hostEl) {
      this.beginHostClose(event.type);
    }
  }

  private activateHost(): boolean {
    if (!this.isFocusActive) {
      this.lastHostActivationFailure = "focus-inactive";
      return false;
    }
    if (!this.canManageKeyboard()) {
      this.lastHostActivationFailure = "runtime-gate";
      return false;
    }
    if (this.hostEl) {
      if (this.isActiveComposerOwnedBy(this.hostEl)) {
        this.lastHostActivationFailure = null;
        return true;
      }
      this.releaseHost("host-ownership-drift");
    }

    const hostEl = this.options.getStableHostEl();
    const activeLayerEl = this.options.getActiveComposerLayer();
    if (!hostEl) {
      this.lastHostActivationFailure = "missing-host";
      recordChatScrollTrace("mobile-keyboard-host-unavailable", {
        hasHost: false,
        hasComposer: activeLayerEl !== null,
        reason: this.lastHostActivationFailure
      });
      return false;
    }
    if (!activeLayerEl) {
      this.lastHostActivationFailure = "missing-composer";
      recordChatScrollTrace("mobile-keyboard-host-unavailable", {
        hasHost: true,
        hasComposer: false,
        reason: this.lastHostActivationFailure
      });
      return false;
    }
    if (!this.isActiveComposerOwnedBy(hostEl, activeLayerEl)) {
      this.lastHostActivationFailure = "composer-parent-mismatch";
      recordChatScrollTrace("mobile-keyboard-host-unavailable", {
        hasHost: true,
        hasComposer: true,
        reason: this.lastHostActivationFailure
      });
      return false;
    }

    const rect = activeLayerEl.getBoundingClientRect();
    const measuredInset = Math.round(window.innerHeight - rect.bottom);
    const openingInset = Number.isFinite(measuredInset)
      ? Math.min(window.innerHeight, Math.max(0, measuredInset))
      : 0;

    this.clearLegacyChildPosition(activeLayerEl);
    this.hostEl = hostEl;
    this.openingInset = openingInset;
    this.appliedInset = openingInset;
    this.presentedHeight = 0;
    this.writeHostInset(hostEl, openingInset);
    hostEl.classList.add("is-mobile-keyboard-safe-host");
    hostEl.classList.add("is-mobile-keyboard-caret-pending");
    this.scheduleCaretReveal(hostEl);
    this.options.getContentEl().classList.add("is-mobile-keyboard-safe-host");
    this.lastHostActivationFailure = null;
    recordChatScrollTrace("mobile-keyboard-host-surface-ready", {
      openingInset,
      layoutHeight: window.innerHeight
    });
    return true;
  }

  private presentHost(keyboardHeight: number, trigger: string): void {
    if (!this.hostEl && !this.activateHost()) {
      return;
    }
    const hostEl = this.hostEl;
    const openingInset = this.openingInset;
    if (!hostEl || openingInset === null) {
      return;
    }

    this.cancelHostCloseTimer();
    this.isClosing = false;
    const targetInset = Math.round(keyboardHeight);
    if (this.presentedHeight === targetInset) {
      return;
    }

    this.presentedHeight = targetInset;
    this.applyAnimatedHostPresentation(hostEl, targetInset, trigger);
    if (this.shouldArbitrateIosHostPan()) {
      this.handleVisualViewportChange(`${trigger}.snapshot`);
    }
  }

  private applyAnimatedHostPresentation(
    hostEl: HTMLElement,
    targetInset: number,
    trigger: string
  ): void {
    const openingInset = this.openingInset;
    if (openingInset === null || this.presentedHeight !== targetInset) {
      return;
    }
    this.cancelIosDockSettle();
    const previousInset = this.appliedInset ?? openingInset;
    const offset = targetInset - previousInset;
    const duration = calculateMobileKeyboardHostSurfaceDuration(
      hostEl.getBoundingClientRect().height
    );
    this.writeHostInset(hostEl, targetInset);
    this.startHostAnimation(hostEl, "opening", offset, duration);
    recordChatScrollTrace("mobile-keyboard-host-surface-open", {
      trigger,
      keyboardHeight: targetInset,
      previousInset,
      offset,
      duration
    });
  }

  private handleVisualViewportChange(trigger: string): void {
    const hostEl = this.hostEl;
    const openingInset = this.openingInset;
    const visualViewport = window.visualViewport;
    if (
      !hostEl ||
      openingInset === null ||
      this.presentedHeight <= 0 ||
      !this.isFocusActive ||
      !this.shouldArbitrateIosHostPan() ||
      !visualViewport
    ) {
      return;
    }

    const layoutHeight = window.innerHeight;
    const isFullHeightPan = (
      visualViewport.height >=
      layoutHeight - IOS_FULL_HEIGHT_VIEWPORT_TOLERANCE_PX
    );
    const displacement = isFullHeightPan
      ? Math.min(
        this.presentedHeight,
        Math.max(0, visualViewport.offsetTop)
      )
      : 0;

    if (displacement > 0) {
      if (!this.isIosHostPanActive) {
        this.cancelIosDockSettle();
        this.cancelHostAnimation();
        this.hasObservedIosHostPan = true;
        this.isIosHostPanActive = true;
        recordChatScrollTrace("mobile-keyboard-host-ios-pan-start", {
          trigger,
          openingInset,
          keyboardHeight: this.presentedHeight
        });
      }
      const nextInset = calculateIosHostPanSafeInset(
        openingInset,
        this.presentedHeight,
        displacement
      );
      this.writeHostInset(hostEl, nextInset);
      if (displacement >= this.presentedHeight - 1) {
        this.revealCaret(hostEl);
      }
      return;
    }

    if (!this.hasObservedIosHostPan) {
      return;
    }
    const wasPanActive = this.isIosHostPanActive;
    this.isIosHostPanActive = false;
    this.cancelHostAnimation();
    const alignment = this.alignIosHostToKeyboardDock(hostEl);
    this.revealCaret(hostEl);
    if (wasPanActive) {
      recordChatScrollTrace("mobile-keyboard-host-ios-pan-handoff", {
        trigger,
        keyboardHeight: this.presentedHeight,
        viewportHeight: Math.round(visualViewport.height),
        viewportOffsetTop: Math.round(visualViewport.offsetTop),
        measuredBottom: alignment?.measuredBottom ?? null,
        desiredBottom: alignment?.desiredBottom ?? null,
        appliedInset: alignment?.appliedInset ?? this.appliedInset
      });
    }
  }

  private alignIosHostToKeyboardDock(
    hostEl: HTMLElement
  ): {
    measuredBottom: number;
    desiredBottom: number;
    appliedInset: number;
  } | null {
    if (
      !this.isFocusActive ||
      this.hostEl !== hostEl ||
      this.presentedHeight <= 0
    ) {
      return null;
    }

    const targetInset = this.presentedHeight;
    this.writeHostInset(hostEl, targetInset);
    const activeLayerEl = this.options.getActiveComposerLayer();
    if (
      !activeLayerEl ||
      (activeLayerEl.parentElement !== hostEl &&
        activeLayerEl.parentNode !== hostEl)
    ) {
      return null;
    }

    const measuredBottom = activeLayerEl.getBoundingClientRect().bottom;
    const desiredBottom = window.innerHeight - targetInset;
    if (!Number.isFinite(measuredBottom)) {
      return null;
    }
    const correctedInset = targetInset + measuredBottom - desiredBottom;
    this.writeHostInset(hostEl, correctedInset);
    return {
      measuredBottom: Math.round(measuredBottom),
      desiredBottom: Math.round(desiredBottom),
      appliedInset: this.appliedInset ?? targetInset
    };
  }

  private scheduleIosDockSettle(trigger: string): void {
    if (!this.shouldArbitrateIosHostPan()) {
      return;
    }
    const hostEl = this.hostEl;
    const targetInset = this.presentedHeight;
    if (!hostEl || targetInset <= 0) {
      return;
    }

    this.cancelIosDockSettle();
    let remainingPasses = 2;
    const settle = () => {
      this.iosDockSettleFrame = null;
      if (
        !this.isFocusActive ||
        this.hostEl !== hostEl ||
        this.presentedHeight !== targetInset
      ) {
        return;
      }
      this.cancelHostAnimation();
      const alignment = this.alignIosHostToKeyboardDock(hostEl);
      this.revealCaret(hostEl);
      remainingPasses -= 1;
      if (remainingPasses > 0) {
        this.iosDockSettleFrame = window.requestAnimationFrame(settle);
        return;
      }
      recordChatScrollTrace("mobile-keyboard-host-ios-dock-settled", {
        trigger,
        keyboardHeight: targetInset,
        measuredBottom: alignment?.measuredBottom ?? null,
        desiredBottom: alignment?.desiredBottom ?? null,
        appliedInset: alignment?.appliedInset ?? this.appliedInset
      });
    };
    this.iosDockSettleFrame = window.requestAnimationFrame(settle);
  }

  private beginHostClose(trigger: string): void {
    const hostEl = this.hostEl;
    const openingInset = this.openingInset;
    if (!hostEl || openingInset === null) {
      return;
    }

    this.cancelIosDockSettle();
    this.hasObservedIosHostPan = false;
    this.isIosHostPanActive = false;
    const previousInset = this.appliedInset ?? openingInset;
    const wasPresented = (
      this.presentedHeight > 0 &&
      Math.abs(previousInset - openingInset) > 0
    );
    this.presentedHeight = 0;
    this.writeHostInset(hostEl, openingInset);

    let settleDelay = Math.max(0, this.animationEndsAt - this.now());
    let cutoverDelay = Math.min(
      LAYER_CUTOVER_MIN_DELAY_MS,
      settleDelay
    );
    if (wasPresented) {
      const duration = calculateMobileKeyboardHostSurfaceDuration(
        hostEl.getBoundingClientRect().height
      );
      const travelDistance = Math.abs(previousInset - openingInset);
      const composerHeight = Math.round(
        this.options.getActiveComposerLayer()?.getBoundingClientRect().height ?? 0
      );
      this.startHostAnimation(
        hostEl,
        "closing",
        openingInset - previousInset,
        duration
      );
      settleDelay = duration;
      cutoverDelay = calculateMobileKeyboardLayerCutoverDelay(
        duration,
        travelDistance,
        composerHeight
      );
    }
    this.layerRestoreCutoverDelay = cutoverDelay;
    recordChatScrollTrace("mobile-keyboard-host-surface-close", {
      trigger,
      previousInset,
      openingInset,
      settleDelay,
      cutoverDelay,
      focusActive: this.isFocusActive
    });

    if (this.isFocusActive) {
      return;
    }
    this.isClosing = true;
    this.schedulePendingLayerRestoreAtCutover(trigger);
    this.scheduleHostClose(settleDelay);
  }

  private schedulePendingLayerRestoreAtCutover(trigger: string): void {
    if (
      this.pendingLayerRestore === null ||
      this.layerRestoreTimer !== null ||
      this.layerRestoreCutoverDelay === null
    ) {
      return;
    }

    const delay = Math.max(0, Math.ceil(this.layerRestoreCutoverDelay));
    this.layerRestoreTimer = window.setTimeout(() => {
      this.layerRestoreTimer = null;
      if (this.isFocusActive) {
        return;
      }
      const pendingLayerRestore = this.takePendingLayerRestore();
      recordChatScrollTrace("mobile-keyboard-layer-visual-cutover", {
        trigger,
        delay,
        restoredLayer: pendingLayerRestore !== null
      });
      pendingLayerRestore?.();
    }, delay);
  }

  private scheduleHostClose(delay: number): void {
    this.cancelHostCloseTimer();
    this.hostCloseTimer = window.setTimeout(() => {
      this.hostCloseTimer = null;
      this.finishHostClose();
    }, Math.max(0, Math.ceil(delay)));
  }

  private finishHostClose(): void {
    if (this.isFocusActive) {
      this.isClosing = false;
      return;
    }
    if (this.awaitingKeyboardDidHide) {
      this.isClosing = true;
      recordChatScrollTrace("mobile-keyboard-host-await-did-hide", {});
      return;
    }
    const pendingLayerRestore = this.takePendingLayerRestore();
    this.releaseHost("close-settled");
    this.isClosing = false;
    recordChatScrollTrace("mobile-keyboard-host-surface-settled", {
      restoredLayer: pendingLayerRestore !== null
    });
    pendingLayerRestore?.();
  }

  private startHostAnimation(
    hostEl: HTMLElement,
    phase: "opening" | "closing",
    offset: number,
    duration: number
  ): void {
    this.cancelHostAnimation();
    hostEl.style.setProperty(
      "--sidet-mobile-keyboard-host-offset",
      `${Math.round(offset)}px`
    );
    hostEl.style.setProperty(
      "--sidet-mobile-keyboard-host-duration",
      `${duration}ms`
    );
    hostEl.classList.add(`is-mobile-keyboard-host-${phase}`);
    this.animationEndsAt = this.now() + duration;
    this.hostAnimationTimer = window.setTimeout(() => {
      this.hostAnimationTimer = null;
      this.animationEndsAt = 0;
      this.clearHostAnimation(hostEl);
    }, duration);
    if (phase === "opening") {
      this.cancelCaretRevealTimer();
      hostEl.classList.remove("is-mobile-keyboard-caret-pending");
    }
  }

  private releaseHost(reason: string): void {
    const hostEl = this.hostEl;
    this.hostEl = null;
    this.openingInset = null;
    this.appliedInset = null;
    this.presentedHeight = 0;
    this.hasObservedIosHostPan = false;
    this.isIosHostPanActive = false;
    this.awaitingKeyboardDidHide = false;
    this.cancelIosDockSettle();
    this.cancelHostAnimation();
    this.cancelCaretRevealTimer();
    if (hostEl) {
      hostEl.classList.remove(
        "is-mobile-keyboard-safe-host",
        "is-mobile-keyboard-caret-pending"
      );
      this.clearHostAnimation(hostEl);
      hostEl.style.removeProperty("--sidet-mobile-keyboard-host-inset");
    }
    this.options.getContentEl().classList.remove("is-mobile-keyboard-safe-host");
    recordChatScrollTrace("mobile-keyboard-host-surface-release", { reason });
  }

  private clearHostAnimation(hostEl: HTMLElement): void {
    hostEl.classList.remove(
      "is-mobile-keyboard-host-opening",
      "is-mobile-keyboard-host-closing"
    );
    hostEl.style.removeProperty("--sidet-mobile-keyboard-host-offset");
    hostEl.style.removeProperty("--sidet-mobile-keyboard-host-duration");
  }

  private scheduleCaretReveal(hostEl: HTMLElement): void {
    this.cancelCaretRevealTimer();
    this.caretRevealTimer = window.setTimeout(() => {
      this.caretRevealTimer = null;
      hostEl.classList.remove("is-mobile-keyboard-caret-pending");
    }, HOST_SURFACE_MAX_DURATION_MS);
  }

  private revealCaret(hostEl: HTMLElement): void {
    this.cancelCaretRevealTimer();
    hostEl.classList.remove("is-mobile-keyboard-caret-pending");
  }

  /**
   * Stable positioning choke point, validated on iPhone and Android.
   * Keep every persistent keyboard endpoint write here.
   *
   * VisualViewport may arbitrate an iOS host pan, but it must feed this parent
   * inset instead of writing a composer child position. The direct wrapper may
   * animate the visible surface only; it must not regain a persistent bottom.
   * See scripts/test-mobile-keyboard-follow-logic.mjs for the regression lock.
   */
  private writeHostInset(hostEl: HTMLElement, inset: number): void {
    const normalizedInset = Number.isFinite(inset)
      ? Math.min(window.innerHeight, Math.max(0, Math.round(inset)))
      : 0;
    this.appliedInset = normalizedInset;
    hostEl.style.setProperty(
      "--sidet-mobile-keyboard-host-inset",
      `${normalizedInset}px`
    );
  }

  private clearLegacyChildPosition(layerEl: HTMLElement): void {
    layerEl.classList.remove(
      "is-mobile-keyboard-opening-isolated",
      "is-mobile-keyboard-following"
    );
    layerEl.style.removeProperty("bottom");
  }

  private handleEnvironmentReset(reason: string): void {
    const pendingLayerRestore = this.takePendingLayerRestore();
    this.cancelHostCloseTimer();
    this.cancelEnvironmentFrame();
    this.releaseHost(reason);
    this.isClosing = false;
    if (!this.isFocusActive) {
      pendingLayerRestore?.();
      return;
    }
    if (!document.hidden && this.canManageKeyboard()) {
      this.scheduleEnvironmentReactivation();
    }
  }

  private scheduleEnvironmentReactivation(): void {
    this.cancelEnvironmentFrame();
    this.environmentFrame = window.requestAnimationFrame(() => {
      this.environmentFrame = null;
      if (this.isFocusActive && !document.hidden && this.canManageKeyboard()) {
        this.activateHost();
      }
    });
  }

  private canManageKeyboard(): boolean {
    return this.options.isPhoneLayout() && this.options.isMobileRuntime();
  }

  private shouldArbitrateIosHostPan(): boolean {
    return (
      this.options.getContentEl().classList.contains("is-ios-runtime") &&
      Boolean(window.visualViewport)
    );
  }

  private shouldCollectIosPhaseDiagnostics(): boolean {
    return this.options.getContentEl().classList.contains("is-ios-runtime");
  }

  private captureIosPhaseDiagnosticTriplet(
    trigger: string,
    eventViewportSnapshot?: IosPhaseDiagnosticViewportSnapshot | null,
    keyboardHeight: number | null = null
  ): void {
    if (!this.captureIosPhaseDiagnostic(
      trigger,
      "event",
      eventViewportSnapshot ?? undefined,
      keyboardHeight
    )) {
      return;
    }
    const firstFrame = window.requestAnimationFrame(() => {
      this.iosPhaseDiagnosticFrames.delete(firstFrame);
      if (!this.captureIosPhaseDiagnostic(
        trigger,
        "rAF1",
        undefined,
        keyboardHeight
      )) {
        return;
      }
      const secondFrame = window.requestAnimationFrame(() => {
        this.iosPhaseDiagnosticFrames.delete(secondFrame);
        this.captureIosPhaseDiagnostic(
          trigger,
          "rAF2",
          undefined,
          keyboardHeight
        );
      });
      this.iosPhaseDiagnosticFrames.add(secondFrame);
    });
    this.iosPhaseDiagnosticFrames.add(firstFrame);
  }

  private captureIosPhaseDiagnostic(
    trigger: string,
    phase: IosKeyboardPhaseDiagnosticPhase,
    viewportSnapshot = this.readIosPhaseDiagnosticViewportSnapshot(),
    keyboardHeight: number | null = null
  ): boolean {
    const cycleId = this.iosPhaseDiagnosticCycleId;
    if (
      cycleId === null ||
      !this.shouldCollectIosPhaseDiagnostics() ||
      viewportSnapshot === null
    ) {
      return false;
    }

    const hostEl = this.hostEl ?? this.options.getStableHostEl();
    const composerEl = this.options.getActiveComposerLayer();
    const textareaEl = this.options.getActiveComposerTextarea();
    const documentElementRect = readElementRect(document.documentElement);
    const bodyRect = readElementRect(document.body);
    const hostRect = readElementRect(hostEl);
    const composerRect = readElementRect(composerEl);
    const hostStyle = readComputedStyle(hostEl);
    const composerStyle = readComputedStyle(composerEl);

    return recordIosKeyboardPhaseDiagnosticSample(cycleId, {
      trigger,
      phase,
      signal: {
        keyboardHeight: normalizeDiagnosticNumber(keyboardHeight)
      },
      layoutViewport: {
        innerHeight: viewportSnapshot.innerHeight,
        scrollY: viewportSnapshot.scrollY
      },
      visualViewport: {
        height: viewportSnapshot.visualViewportHeight,
        offsetTop: viewportSnapshot.visualViewportOffsetTop,
        pageTop: viewportSnapshot.visualViewportPageTop
      },
      document: {
        documentElementTop: normalizeDiagnosticNumber(documentElementRect?.top),
        bodyTop: normalizeDiagnosticNumber(bodyRect?.top)
      },
      host: {
        top: normalizeDiagnosticNumber(hostRect?.top),
        bottom: normalizeDiagnosticNumber(hostRect?.bottom),
        inlineInset: hostEl?.style.getPropertyValue(
          "--sidet-mobile-keyboard-host-inset"
        ) ?? "",
        computedInset: hostStyle?.getPropertyValue(
          "--sidet-mobile-keyboard-host-inset"
        ).trim() ?? "",
        inlineOffset: hostEl?.style.getPropertyValue(
          "--sidet-mobile-keyboard-host-offset"
        ) ?? "",
        computedTransform: hostStyle?.transform ?? ""
      },
      composer: {
        top: normalizeDiagnosticNumber(composerRect?.top),
        bottom: normalizeDiagnosticNumber(composerRect?.bottom),
        height: normalizeDiagnosticNumber(composerRect?.height),
        computedPosition: composerStyle?.position ?? "",
        computedBottom: composerStyle?.bottom ?? "",
        computedTransform: composerStyle?.transform ?? ""
      },
      runtime: {
        focusActive: this.isFocusActive,
        canManageKeyboard: this.canManageKeyboard(),
        composerLayerActive: this.options.isComposerLayerActive(),
        closing: this.isClosing,
        awaitingKeyboardDidHide: this.awaitingKeyboardDidHide,
        openingInset: normalizeDiagnosticNumber(this.openingInset),
        appliedInset: normalizeDiagnosticNumber(this.appliedInset),
        presentedHeight: this.presentedHeight,
        hasObservedIosHostPan: this.hasObservedIosHostPan,
        iosHostPanActive: this.isIosHostPanActive,
        hostConnected: hostEl?.isConnected ?? false,
        composerConnected: composerEl?.isConnected ?? false,
        composerParentIsHost: this.isActiveComposerOwnedBy(
          hostEl,
          composerEl
        ),
        hostHasSafeClass: hostEl?.classList.contains(
          "is-mobile-keyboard-safe-host"
        ) ?? false,
        hostActivationFailure: this.lastHostActivationFailure,
        hostOpening: hostEl?.classList.contains(
          "is-mobile-keyboard-host-opening"
        ) ?? false,
        hostClosing: hostEl?.classList.contains(
          "is-mobile-keyboard-host-closing"
        ) ?? false,
        activeElementIsTextarea: document.activeElement === textareaEl
      }
    });
  }

  private isActiveComposerOwnedBy(
    hostEl: HTMLElement | null,
    activeLayerEl = this.options.getActiveComposerLayer()
  ): boolean {
    return Boolean(
      hostEl &&
      activeLayerEl &&
      (activeLayerEl.parentElement === hostEl ||
        activeLayerEl.parentNode === hostEl)
    );
  }

  private readIosPhaseDiagnosticViewportSnapshot():
  IosPhaseDiagnosticViewportSnapshot | null {
    if (
      this.iosPhaseDiagnosticCycleId === null ||
      !this.shouldCollectIosPhaseDiagnostics()
    ) {
      return null;
    }
    const visualViewport = window.visualViewport;
    return {
      innerHeight: normalizeDiagnosticNumber(window.innerHeight),
      scrollY: normalizeDiagnosticNumber(window.scrollY),
      visualViewportHeight: normalizeDiagnosticNumber(visualViewport?.height),
      visualViewportOffsetTop: normalizeDiagnosticNumber(
        visualViewport?.offsetTop
      ),
      visualViewportPageTop: normalizeDiagnosticNumber(visualViewport?.pageTop)
    };
  }

  private cancelIosPhaseDiagnosticFrames(): void {
    for (const frame of this.iosPhaseDiagnosticFrames) {
      window.cancelAnimationFrame(frame);
    }
    this.iosPhaseDiagnosticFrames.clear();
  }

  private cancelPendingLayerRestore(): void {
    this.takePendingLayerRestore();
  }

  private takePendingLayerRestore(): (() => void) | null {
    const pendingLayerRestore = this.pendingLayerRestore;
    this.pendingLayerRestore = null;
    this.layerRestoreCutoverDelay = null;
    if (this.layerRestoreTimer !== null) {
      window.clearTimeout(this.layerRestoreTimer);
      this.layerRestoreTimer = null;
    }
    return pendingLayerRestore;
  }

  private cancelHostCloseTimer(): void {
    if (this.hostCloseTimer !== null) {
      window.clearTimeout(this.hostCloseTimer);
      this.hostCloseTimer = null;
    }
  }

  private cancelCaretRevealTimer(): void {
    if (this.caretRevealTimer !== null) {
      window.clearTimeout(this.caretRevealTimer);
      this.caretRevealTimer = null;
    }
  }

  private cancelIosDockSettle(): void {
    if (this.iosDockSettleFrame !== null) {
      window.cancelAnimationFrame(this.iosDockSettleFrame);
      this.iosDockSettleFrame = null;
    }
  }

  private cancelHostAnimation(): void {
    if (this.hostAnimationTimer !== null) {
      window.clearTimeout(this.hostAnimationTimer);
      this.hostAnimationTimer = null;
    }
    this.animationEndsAt = 0;
    if (this.hostEl) {
      this.clearHostAnimation(this.hostEl);
    }
  }

  private cancelEnvironmentFrame(): void {
    if (this.environmentFrame !== null) {
      window.cancelAnimationFrame(this.environmentFrame);
      this.environmentFrame = null;
    }
  }

  private now(): number {
    return typeof performance === "undefined" ? Date.now() : performance.now();
  }
}

export function calculateMobileKeyboardHostSurfaceDuration(
  surfaceHeight: number
): number {
  const normalizedHeight = Number.isFinite(surfaceHeight)
    ? Math.max(0, surfaceHeight - 1)
    : 0;
  return Math.round(Math.min(
    HOST_SURFACE_MAX_DURATION_MS,
    Math.max(HOST_SURFACE_MIN_DURATION_MS, normalizedHeight * 0.35)
  ));
}

export function calculateMobileKeyboardLayerCutoverDelay(
  duration: number,
  travelDistance: number,
  surfaceHeight: number
): number {
  const normalizedDuration = Number.isFinite(duration)
    ? Math.max(0, duration)
    : 0;
  const normalizedTravelDistance = Number.isFinite(travelDistance)
    ? Math.max(0, travelDistance)
    : 0;
  if (normalizedDuration <= 0 || normalizedTravelDistance <= 0) {
    return 0;
  }

  const normalizedSurfaceHeight = Number.isFinite(surfaceHeight)
    ? Math.max(0, surfaceHeight)
    : 0;
  const visibleDismissDistance = Math.min(
    LAYER_CUTOVER_MAX_TRAVEL_PX,
    Math.max(
      LAYER_CUTOVER_MIN_TRAVEL_PX,
      normalizedSurfaceHeight * 0.25
    )
  );
  const linearProgress = Math.min(
    0.32,
    visibleDismissDistance / normalizedTravelDistance
  );
  return Math.round(Math.min(
    LAYER_CUTOVER_MAX_DELAY_MS,
    Math.max(
      LAYER_CUTOVER_MIN_DELAY_MS,
      normalizedDuration * linearProgress
    )
  ));
}

export function calculateIosHostPanSafeInset(
  openingInset: number,
  keyboardHeight: number,
  viewportDisplacement: number
): number {
  const normalizedOpeningInset = Number.isFinite(openingInset)
    ? Math.max(0, openingInset)
    : 0;
  const normalizedKeyboardHeight = Number.isFinite(keyboardHeight)
    ? Math.max(0, keyboardHeight)
    : 0;
  if (normalizedKeyboardHeight <= 0) {
    return Math.round(normalizedOpeningInset);
  }
  const normalizedDisplacement = Number.isFinite(viewportDisplacement)
    ? Math.min(
      normalizedKeyboardHeight,
      Math.max(0, viewportDisplacement)
    )
    : 0;
  const progress = normalizedDisplacement / normalizedKeyboardHeight;
  return Math.round(normalizedOpeningInset * (1 - progress));
}

function readKeyboardEventHeight(event: Event): number | null {
  const candidate = event as Event & {
    keyboardHeight?: unknown;
    detail?: {
      keyboardHeight?: unknown;
      height?: unknown;
    };
  };
  const value = (
    candidate.keyboardHeight ??
    candidate.detail?.keyboardHeight ??
    candidate.detail?.height
  );
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

function readElementRect(
  element: Element | null | undefined
): DOMRect | null {
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return null;
  }
  return element.getBoundingClientRect();
}

function readComputedStyle(
  element: Element | null | undefined
): CSSStyleDeclaration | null {
  if (!element || typeof getComputedStyle !== "function") {
    return null;
  }
  return getComputedStyle(element);
}

function normalizeDiagnosticNumber(
  value: number | null | undefined
): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : null;
}
