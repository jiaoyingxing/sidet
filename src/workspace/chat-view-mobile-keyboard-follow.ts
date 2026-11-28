import { recordChatScrollTrace } from "./chat-scroll-trace";
import {
  beginIosKeyboardPhaseDiagnosticCycle,
  IosKeyboardPhaseDiagnosticPhase,
  recordIosKeyboardPhaseDiagnosticSample
} from "./chat-view-mobile-keyboard-phase-diagnostics";
import { recordMobileInputProbeEvent } from "./chat-view-mobile-input-probe";

interface ChatViewMobileKeyboardFollowRuntimeOptions {
  getContentEl: () => HTMLElement;
  getStableHostEl: () => HTMLElement | null;
  getActiveComposerLayer: () => HTMLElement | null;
  getActiveComposerTextarea: () => HTMLTextAreaElement | null;
  isComposerLayerActive: () => boolean;
  isPhoneLayout: () => boolean;
  isMobileRuntime: () => boolean;
  /** 键盘呈现落定（终点 inset 已写入并完成 iOS dock 校正）后通知视图层决定是否贴底跟随。 */
  onPresentationSettled?: (trigger: string) => void;
  /** 输入框开始上浮（开场表面动画起点）时通知，内容可与键盘同一段动画让位。 */
  onPresentationStarted?: () => void;
  /**
   * 开场动画每一帧（输入框位移写入后）通知。视图层必须在同一回调里重算留白
   * 并补滚动：输入框和内容共用一个 rAF，才是一段运动而不是两套引擎。
   * 参数是这一帧输入框的可视顶边，视图层不必再读一次 composer rect。
   */
  onPresentationFrame?: (visualComposerTop: number) => void;
  /** 开场表面动画结束；composer 已到终点，输入态可据此再校正一次留白。 */
  onPresentationAnimationEnded?: () => void;
  /** 关闭时是否进入「输入框与内容一起下落」的共帧路径（贴底阅读时为真）。 */
  shouldFollowClose?: () => boolean;
  /** 共帧关闭开始（输入框还在展示位）时通知，用来抓取内容侧起点几何。 */
  onPresentationCloseStarted?: () => void;
  /** 共帧关闭每帧（输入框位移写入后）通知，参数是当前可视顶边。 */
  onPresentationCloseFrame?: (visualComposerTop: number) => void;
  /** 共帧关闭收口：输入框已到休息位、内容几何已落定，交给输入态清理。 */
  onPresentationCloseFinished?: () => void;
  /** 键盘呈现结束（hide / owner 丢失 / release）后通知输入态撤回键盘期留白。 */
  onPresentationClosed?: () => void;
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
/**
 * iOS 首轮没有历史键盘时长可学时用的兜底：真机 willShow→didShow 实测约 400ms，
 * 取 400ms 让输入框与键盘同速；学到的真实时长会覆盖它。
 */
const IOS_HOST_SURFACE_DEFAULT_DURATION_MS = 400;
const HOST_SURFACE_LEARNED_MIN_DURATION_MS = 150;
const HOST_SURFACE_LEARNED_MAX_DURATION_MS = 520;
/**
 * 升降总行程按手感收紧：实测键盘时长仍决定终点节奏，但表面动画不再等满。
 * 升起封顶稍长（要领先键盘），共帧关闭封顶更短（键盘后段会盖住输入框）。
 */
const HOST_SURFACE_OPEN_MAX_DURATION_MS = 320;
const HOST_SURFACE_CLOSE_MAX_DURATION_MS = 210;
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
  private contentRestingPaddingBottom: string | null = null;
  private presentedHeight = 0;
  private animationEndsAt = 0;
  private framedOpeningActive = false;
  private framedOpeningFrame: number | null = null;
  private framedOpeningStartedAt = 0;
  private framedOpeningDuration = 0;
  private framedOpeningOffset = 0;
  private framedComposerEl: HTMLElement | null = null;
  private framedComposerLayoutTop = 0;
  private framedClosingActive = false;
  private framedClosingFrame: number | null = null;
  private framedClosingStartedAt = 0;
  private framedClosingDuration = 0;
  private framedClosingOffset = 0;
  private framedClosingRestTop = 0;
  private keyboardShowStartedAt: number | null = null;
  private keyboardHideStartedAt: number | null = null;
  private learnedShowDurationMs: number | null = null;
  private learnedHideDurationMs: number | null = null;
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

  /** 开场是否正由 JS 逐帧驱动；此时留白由 onPresentationFrame 同步，不再另起循环。 */
  isFramedOpeningActive(): boolean {
    return this.framedOpeningActive;
  }

  /** 排障快照：只读，不改变任何键盘状态。 */
  getDiagnosticSnapshot(): {
    following: boolean;
    presentedHeight: number;
    openingInset: number | null;
    appliedInset: number | null;
    focusActive: boolean;
    hostActive: boolean;
    isClosing: boolean;
    iosPanActive: boolean;
    lastFailure: string | null;
  } {
    return {
      following: this.isFollowing(),
      presentedHeight: this.presentedHeight,
      openingInset: this.openingInset,
      appliedInset: this.appliedInset,
      focusActive: this.isFocusActive,
      hostActive: this.hostEl !== null,
      isClosing: this.isClosing,
      iosPanActive: this.isIosHostPanActive,
      lastFailure: this.lastHostActivationFailure
    };
  }

  isManagingKeyboardViewport(): boolean {
    return this.hostEl !== null || this.isClosing;
  }

  /**
   * 键盘呈现落定不等于任意一次 inset 写入：iOS 还会经历 dock 校正与 pan 交接。
   * 视图层只有在终点稳定后才读取贴底快照，避免跟随到中间高度。
   */
  private notifyPresentationSettled(trigger: string): void {
    if (!this.isFocusActive || this.presentedHeight <= 0) {
      return;
    }
    this.options.onPresentationSettled?.(trigger);
  }

  private handleKeyboardEvent(
    event: Event,
    keyboardHeight = readKeyboardEventHeight(event)
  ): void {
    recordMobileInputProbeEvent(event.type, {
      keyboardHeight: keyboardHeight === null ? null : Math.round(keyboardHeight),
      focusActive: this.isFocusActive,
      presentedHeight: this.presentedHeight
    });
    if (event.type === "keyboardWillShow" || event.type === "keyboardDidShow") {
      if (
        this.isFocusActive &&
        this.canManageKeyboard() &&
        keyboardHeight !== null &&
        keyboardHeight > 0
      ) {
        if (event.type === "keyboardWillShow") {
          // 系统键盘的动画时长读不到，只能量 WillShow → DidShow；量到的值
          // 用于下一次呈现，让输入框和键盘同速。首次用平台兜底时长。
          // 同一聚焦周期内的重复 WillShow 不重开计时，避免把时长学短。
          if (this.presentedHeight <= 0) {
            this.keyboardShowStartedAt = this.now();
          }
        } else {
          this.learnKeyboardSurfaceDuration("opening");
        }
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
          if (this.shouldArbitrateIosHostPan()) {
            this.scheduleIosDockSettle(event.type);
          } else {
            this.notifyPresentationSettled(event.type);
          }
        }
      }
      return;
    }

    if (event.type === "keyboardWillHide") {
      // 没有活动 host 的 hide 不参与学习，避免杂散事件把时长学成 0。
      if (this.hostEl) {
        this.keyboardHideStartedAt = this.now();
      }
    } else if (event.type === "keyboardDidHide") {
      this.learnKeyboardSurfaceDuration("closing");
    }
    this.cancelIosDockSettle();
    if (event.type === "keyboardDidHide") {
      this.awaitingKeyboardDidHide = false;
    }
    if (this.hostEl) {
      if (this.framedClosingActive) {
        // 共帧关闭还没落完：didHide 只表示可以安全释放 host，
        // 不能再排一次早 cutover 把 composer 从句柄里抢走。
        return;
      }
      this.beginHostClose(event.type);
    }
  }

  /** 用一次真实键盘动画的时间差更新表面动画时长；越界或缺失时保留旧值。 */
  private learnKeyboardSurfaceDuration(phase: "opening" | "closing"): void {
    const startedAt = phase === "opening"
      ? this.keyboardShowStartedAt
      : this.keyboardHideStartedAt;
    if (phase === "opening") {
      this.keyboardShowStartedAt = null;
    } else {
      this.keyboardHideStartedAt = null;
    }
    if (startedAt === null) {
      return;
    }
    const normalized = normalizeLearnedKeyboardSurfaceDuration(
      this.now() - startedAt
    );
    if (phase === "opening") {
      this.learnedShowDurationMs = normalized;
    } else {
      this.learnedHideDurationMs = normalized;
    }
  }

  /**
   * 表面动画时长：优先用上一轮量到的真实键盘时长；iOS 首次用兜底值，
   * 其他平台沿用按表面高度收敛的旧曲线，保持行为不变。
   */
  private resolveHostSurfaceDuration(
    hostEl: HTMLElement,
    phase: "opening" | "closing"
  ): number {
    const learned = phase === "opening"
      ? this.learnedShowDurationMs
      : this.learnedHideDurationMs ?? this.learnedShowDurationMs;
    if (learned !== null) {
      return learned;
    }
    if (this.isIosRuntime()) {
      return IOS_HOST_SURFACE_DEFAULT_DURATION_MS;
    }
    return calculateMobileKeyboardHostSurfaceDuration(
      hostEl.getBoundingClientRect().height
    );
  }

  private isIosRuntime(): boolean {
    return this.options.getContentEl().classList.contains("is-ios-runtime");
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
    // 宿主 iOS 会把键盘高度写成内容区 padding-bottom（实测 34px → 374px）。
    // 键盘位置已由 layer 唯一负责，内容区保持聚焦前的底距，避免两套避让叠加。
    this.lockContentRestingPadding();
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
    // 输入框开始上浮时就通知视图层：内容跟着同一段动画一起让位，
    // 不再等落定后一次性弹上去。
    this.options.onPresentationStarted?.();
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
    const duration = Math.min(
      this.resolveHostSurfaceDuration(hostEl, "opening"),
      HOST_SURFACE_OPEN_MAX_DURATION_MS
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
      this.notifyPresentationSettled(`${trigger}.pan-handoff`);
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
      this.notifyPresentationSettled(trigger);
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
    const composerEl = this.options.getActiveComposerLayer();
    const closeStartTop = composerEl
      ? composerEl.getBoundingClientRect().top
      : null;
    const followClose = Boolean(
      wasPresented &&
      composerEl &&
      closeStartTop !== null &&
      (this.options.shouldFollowClose?.() ?? false)
    );
    if (followClose) {
      // 共帧关闭：输入框留在 body 层跟着键盘落，内容每帧跟着退；
      // 到休息位后再交回内容流，避免 32ms 早交回造成的「瞬间消失」。
      this.options.onPresentationCloseStarted?.();
    } else if (this.presentedHeight > 0) {
      this.options.onPresentationClosed?.();
    }
    this.presentedHeight = 0;
    this.writeHostInset(hostEl, openingInset);

    let settleDelay = Math.max(0, this.animationEndsAt - this.now());
    let cutoverDelay = Math.min(
      LAYER_CUTOVER_MIN_DELAY_MS,
      settleDelay
    );
    if (wasPresented) {
      const duration = this.resolveHostSurfaceDuration(hostEl, "closing");
      const travelDistance = Math.abs(previousInset - openingInset);
      if (followClose && composerEl && closeStartTop !== null) {
        const closeDuration = Math.min(
          duration,
          HOST_SURFACE_CLOSE_MAX_DURATION_MS
        );
        // 先收掉可能还在跑的开场帧，再读休息位；否则 rect 会把开场位移算进去。
        this.cancelHostAnimation();
        const restTop = composerEl.getBoundingClientRect().top;
        this.startFramedHostClosing(
          hostEl,
          composerEl,
          closeStartTop - restTop,
          restTop,
          closeDuration
        );
        settleDelay = closeDuration;
        cutoverDelay = closeDuration;
      } else {
        const composerHeight = Math.round(
          composerEl?.getBoundingClientRect().height ?? 0
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
    }
    this.layerRestoreCutoverDelay = cutoverDelay;
    recordChatScrollTrace("mobile-keyboard-host-surface-close", {
      trigger,
      previousInset,
      openingInset,
      settleDelay,
      cutoverDelay,
      followClose,
      focusActive: this.isFocusActive
    });

    if (this.isFocusActive) {
      return;
    }
    this.isClosing = true;
    if (followClose) {
      // 由共帧关闭的收口统一交回内容流；这里不再排早 cutover。
      if (this.framedClosingActive) {
        return;
      }
      // 时长之外没有动画可等（例如 followClose 但没有位移），直接走收口。
      this.finishHostClose();
      return;
    }
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
    if (phase === "opening") {
      this.startFramedHostOpening(hostEl, offset, duration);
      return;
    }
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
  }

  /**
   * 开场表面动画改由 JS 逐帧驱动：每一帧先写输入框位移，再通知视图层用同一帧
   * 几何重算留白并补滚动。CSS 动画跑在合成层、滚动跑在主线程，两套引擎即使
   * 时长相同也会被看成“内容在追输入框”；同一个 rAF 才能让它们成为一个刚体。
   *
   * 位移直接写 composer 的内联 transform（配 will-change），不再每帧穿过
   * 继承的 CSS 变量；布局顶边只在起点读一次，逐帧用「布局顶边 + 剩余位移」
   * 直接算可视位置，避免每帧再读 composer rect。
   */
  private startFramedHostOpening(
    hostEl: HTMLElement,
    offset: number,
    duration: number
  ): void {
    this.framedOpeningActive = true;
    this.framedOpeningStartedAt = this.now();
    this.framedOpeningDuration = Math.max(1, duration);
    this.framedOpeningOffset = offset;
    this.animationEndsAt = this.framedOpeningStartedAt + this.framedOpeningDuration;
    this.framedComposerEl = this.options.getActiveComposerLayer();
    if (this.framedComposerEl) {
      this.framedComposerEl.style.removeProperty("transform");
      this.framedComposerLayoutTop =
        this.framedComposerEl.getBoundingClientRect().top;
    } else {
      this.framedComposerLayoutTop = 0;
    }
    // 保留时长 / 起点变量：排障与 CSS 关闭阶段仍按同一口径读取。
    hostEl.style.setProperty(
      "--sidet-mobile-keyboard-host-offset",
      `${Math.round(offset)}px`
    );
    hostEl.style.setProperty(
      "--sidet-mobile-keyboard-host-duration",
      `${duration}ms`
    );
    hostEl.classList.add(
      "is-mobile-keyboard-host-opening",
      "is-mobile-keyboard-host-framed"
    );
    this.cancelCaretRevealTimer();
    hostEl.classList.remove("is-mobile-keyboard-caret-pending");
    // 后台 / 掉帧时 rAF 可能不再推进；兜底定时器保证动画一定收口。
    this.hostAnimationTimer = window.setTimeout(() => {
      this.hostAnimationTimer = null;
      this.finishFramedHostOpening(hostEl);
    }, duration);
    this.runFramedHostOpeningFrame(hostEl);
  }

  private runFramedHostOpeningFrame(hostEl: HTMLElement): void {
    this.framedOpeningFrame = null;
    if (
      !this.framedOpeningActive ||
      this.hostEl !== hostEl ||
      this.presentedHeight <= 0
    ) {
      return;
    }
    const elapsed = this.now() - this.framedOpeningStartedAt;
    const progress = Math.min(
      1,
      Math.max(0, elapsed / this.framedOpeningDuration)
    );
    const remaining = this.framedOpeningOffset * (1 - easeOutQuart(progress));
    if (this.framedComposerEl) {
      this.framedComposerEl.style.transform =
        `translate3d(0, ${remaining.toFixed(2)}px, 0)`;
    }
    this.options.onPresentationFrame?.(
      this.framedComposerLayoutTop + remaining
    );
    if (progress >= 1) {
      this.finishFramedHostOpening(hostEl);
      return;
    }
    this.framedOpeningFrame = window.requestAnimationFrame(() => {
      this.runFramedHostOpeningFrame(hostEl);
    });
  }

  private finishFramedHostOpening(hostEl: HTMLElement): void {
    if (!this.framedOpeningActive) {
      return;
    }
    this.framedOpeningActive = false;
    if (this.framedOpeningFrame !== null) {
      window.cancelAnimationFrame(this.framedOpeningFrame);
      this.framedOpeningFrame = null;
    }
    if (this.hostAnimationTimer !== null) {
      window.clearTimeout(this.hostAnimationTimer);
      this.hostAnimationTimer = null;
    }
    this.animationEndsAt = 0;
    this.clearFramedComposerTransform();
    hostEl.classList.remove("is-mobile-keyboard-host-framed");
    this.clearHostAnimation(hostEl);
    if (this.hostEl === hostEl && this.presentedHeight > 0) {
      // 终点帧用零位移再同步一次，随后让输入态按最终几何校正留白。
      this.options.onPresentationFrame?.(this.framedComposerLayoutTop);
      this.options.onPresentationAnimationEnded?.();
    }
  }

  private clearFramedComposerTransform(): void {
    if (this.framedComposerEl) {
      this.framedComposerEl.style.removeProperty("transform");
      this.framedComposerEl = null;
    }
  }

  /**
   * 共帧关闭：输入框留在 body 层，沿同一条 quart 曲线落到休息位；
   * 每帧把当前可视顶边交给内容侧，让内容跟着输入框一起退。
   */
  private startFramedHostClosing(
    hostEl: HTMLElement,
    composerEl: HTMLElement,
    offset: number,
    restTop: number,
    duration: number
  ): void {
    this.framedClosingActive = true;
    this.framedClosingStartedAt = this.now();
    this.framedClosingDuration = Math.max(1, duration);
    this.framedClosingOffset = offset;
    this.framedClosingRestTop = restTop;
    this.framedComposerEl = composerEl;
    this.animationEndsAt = this.framedClosingStartedAt + this.framedClosingDuration;
    composerEl.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
    hostEl.style.setProperty(
      "--sidet-mobile-keyboard-host-offset",
      `${Math.round(offset)}px`
    );
    hostEl.style.setProperty(
      "--sidet-mobile-keyboard-host-duration",
      `${duration}ms`
    );
    hostEl.classList.add(
      "is-mobile-keyboard-host-closing",
      "is-mobile-keyboard-host-framed"
    );
    // 后台 / 掉帧时 rAF 可能不再推进；兜底定时器保证动画一定收口。
    this.hostAnimationTimer = window.setTimeout(() => {
      this.hostAnimationTimer = null;
      this.finishFramedHostClosing(hostEl);
    }, duration);
    this.runFramedHostClosingFrame(hostEl, composerEl);
  }

  private runFramedHostClosingFrame(
    hostEl: HTMLElement,
    composerEl: HTMLElement
  ): void {
    this.framedClosingFrame = null;
    if (!this.framedClosingActive || this.hostEl !== hostEl) {
      return;
    }
    const elapsed = this.now() - this.framedClosingStartedAt;
    const progress = Math.min(
      1,
      Math.max(0, elapsed / this.framedClosingDuration)
    );
    const remaining = this.framedClosingOffset * (1 - easeOutSine(progress));
    composerEl.style.transform =
      `translate3d(0, ${remaining.toFixed(2)}px, 0)`;
    this.options.onPresentationCloseFrame?.(this.framedClosingRestTop + remaining);
    if (progress >= 1) {
      this.finishFramedHostClosing(hostEl);
      return;
    }
    this.framedClosingFrame = window.requestAnimationFrame(() => {
      this.runFramedHostClosingFrame(hostEl, composerEl);
    });
  }

  private finishFramedHostClosing(hostEl: HTMLElement): void {
    if (!this.framedClosingActive) {
      return;
    }
    this.framedClosingActive = false;
    if (this.framedClosingFrame !== null) {
      window.cancelAnimationFrame(this.framedClosingFrame);
      this.framedClosingFrame = null;
    }
    if (this.hostAnimationTimer !== null) {
      window.clearTimeout(this.hostAnimationTimer);
      this.hostAnimationTimer = null;
    }
    this.animationEndsAt = 0;
    this.clearFramedComposerTransform();
    hostEl.classList.remove("is-mobile-keyboard-host-framed");
    this.clearHostAnimation(hostEl);
    this.options.onPresentationCloseFrame?.(this.framedClosingRestTop);
    this.options.onPresentationCloseFinished?.();
    if (this.isFocusActive) {
      this.isClosing = false;
      return;
    }
    this.cancelHostCloseTimer();
    const pendingLayerRestore = this.takePendingLayerRestore();
    pendingLayerRestore?.();
    this.isClosing = true;
    this.finishHostClose();
  }

  private releaseHost(reason: string): void {
    const hostEl = this.hostEl;
    const wasPresented = this.presentedHeight > 0;
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
    if (wasPresented) {
      this.options.onPresentationClosed?.();
    }
    if (hostEl) {
      hostEl.classList.remove(
        "is-mobile-keyboard-safe-host",
        "is-mobile-keyboard-caret-pending"
      );
      this.clearHostAnimation(hostEl);
      hostEl.style.removeProperty("--sidet-mobile-keyboard-host-inset");
    }
    this.options.getContentEl().classList.remove("is-mobile-keyboard-safe-host");
    this.unlockContentRestingPadding();
    recordChatScrollTrace("mobile-keyboard-host-surface-release", { reason });
  }

  /**
   * 宿主 iOS 会把键盘高度写进内容区的 padding-bottom；composer 位置已由 layer
   * 唯一负责，这里把内容区固定在聚焦前的底距，避免宿主和插件各让一次。
   */
  private lockContentRestingPadding(): void {
    const contentEl = this.options.getContentEl();
    if (this.contentRestingPaddingBottom === null) {
      this.contentRestingPaddingBottom =
        readComputedStyle(contentEl)?.paddingBottom ?? null;
    }
    if (this.contentRestingPaddingBottom !== null) {
      contentEl.style.setProperty(
        "padding-bottom",
        this.contentRestingPaddingBottom
      );
    }
  }

  private unlockContentRestingPadding(): void {
    if (this.contentRestingPaddingBottom === null) {
      return;
    }
    this.contentRestingPaddingBottom = null;
    this.options.getContentEl().style.removeProperty("padding-bottom");
  }

  private clearHostAnimation(hostEl: HTMLElement): void {
    hostEl.classList.remove(
      "is-mobile-keyboard-host-opening",
      "is-mobile-keyboard-host-closing",
      "is-mobile-keyboard-host-framed"
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
    this.framedOpeningActive = false;
    this.framedClosingActive = false;
    this.clearFramedComposerTransform();
    if (this.framedOpeningFrame !== null) {
      window.cancelAnimationFrame(this.framedOpeningFrame);
      this.framedOpeningFrame = null;
    }
    if (this.framedClosingFrame !== null) {
      window.cancelAnimationFrame(this.framedClosingFrame);
      this.framedClosingFrame = null;
    }
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

/** 量到的键盘动画时长收进可用区间；非有限值按最短呈现处理。 */
export function normalizeLearnedKeyboardSurfaceDuration(
  measuredMs: number
): number {
  if (!Number.isFinite(measuredMs)) {
    return HOST_SURFACE_LEARNED_MIN_DURATION_MS;
  }
  return Math.round(Math.min(
    HOST_SURFACE_LEARNED_MAX_DURATION_MS,
    Math.max(HOST_SURFACE_LEARNED_MIN_DURATION_MS, measuredMs)
  ));
}

/** 开场逐帧驱动的减速曲线：前段果断、尾段迅速收口，避免 400ms 的长尾发拖。 */
export function easeOutQuart(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  const inverse = 1 - clamped;
  return 1 - inverse * inverse * inverse * inverse;
}

/** 关闭逐帧驱动的曲线：更匀速、减速度更低，避免「冲一下再刹住」的阻尼感。 */
export function easeOutSine(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.sin((Math.PI / 2) * clamped);
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
