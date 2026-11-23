interface MobileWorkspaceAnchor {
  left: number;
  right: number;
  width: number;
  viewportWidth: number;
}

interface ChatViewMobileWorkspaceOwnershipGuardOptions {
  getRootEl: () => HTMLElement | null;
  getViewportWidth: () => number;
  isLayerActive: () => boolean;
  onOwnershipLoss: (trigger: string) => void;
}

const WORKSPACE_DRIFT_TOLERANCE_PX = 1;
const WORKSPACE_INTERSECTION_THRESHOLDS = Array.from(
  { length: 101 },
  (_, index) => index / 100
);

export class ChatViewMobileWorkspaceOwnershipGuard {
  private anchor: MobileWorkspaceAnchor | null = null;
  private observer: IntersectionObserver | null = null;
  private checkFrame: number | null = null;
  private fallbackFrame: number | null = null;

  constructor(
    private readonly options: ChatViewMobileWorkspaceOwnershipGuardOptions
  ) {}

  start(): void {
    this.stop();
    const rootEl = this.options.getRootEl();
    if (!this.options.isLayerActive() || !rootEl?.isConnected) {
      return;
    }

    this.anchor = this.readAnchor(rootEl);
    if (typeof IntersectionObserver === "undefined") {
      this.scheduleFallbackCheck();
      return;
    }
    this.observeRoot(rootEl);
  }

  requestCheck(trigger: string): void {
    if (!this.anchor || !this.options.isLayerActive()) {
      return;
    }
    if (this.checkFrame !== null) {
      return;
    }
    this.checkFrame = window.requestAnimationFrame(() => {
      this.checkFrame = null;
      this.checkCurrentGeometry(trigger);
    });
  }

  stop(): void {
    this.anchor = null;
    this.observer?.disconnect();
    this.observer = null;
    if (this.checkFrame !== null) {
      window.cancelAnimationFrame(this.checkFrame);
      this.checkFrame = null;
    }
    if (this.fallbackFrame !== null) {
      window.cancelAnimationFrame(this.fallbackFrame);
      this.fallbackFrame = null;
    }
  }

  private observeRoot(rootEl: HTMLElement): void {
    const anchor = this.anchor;
    if (!anchor || typeof IntersectionObserver === "undefined") {
      return;
    }
    this.observer?.disconnect();
    const rightGap = Math.max(
      0,
      anchor.viewportWidth - anchor.right - WORKSPACE_DRIFT_TOLERANCE_PX
    );
    const leftGap = Math.max(
      0,
      anchor.left - WORKSPACE_DRIFT_TOLERANCE_PX
    );
    this.observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((candidate) => candidate.target === rootEl);
        if (!entry) {
          return;
        }
        this.evaluateRect(entry.boundingClientRect, "intersection");
      },
      {
        root: null,
        rootMargin: `0px -${rightGap}px 0px -${leftGap}px`,
        threshold: WORKSPACE_INTERSECTION_THRESHOLDS
      }
    );
    this.observer.observe(rootEl);
  }

  private checkCurrentGeometry(trigger: string): void {
    const rootEl = this.options.getRootEl();
    if (!this.options.isLayerActive() || !rootEl?.isConnected) {
      this.stop();
      return;
    }
    this.evaluateRect(rootEl.getBoundingClientRect(), trigger);
  }

  private evaluateRect(rect: DOMRectReadOnly, trigger: string): void {
    const anchor = this.anchor;
    const rootEl = this.options.getRootEl();
    if (!anchor || !this.options.isLayerActive() || !rootEl?.isConnected) {
      this.stop();
      return;
    }

    const viewportWidth = this.options.getViewportWidth();
    if (
      Math.abs(viewportWidth - anchor.viewportWidth) >
      WORKSPACE_DRIFT_TOLERANCE_PX
    ) {
      this.anchor = this.readAnchor(rootEl);
      this.observeRoot(rootEl);
      return;
    }

    if (
      Math.abs(rect.left - anchor.left) <= WORKSPACE_DRIFT_TOLERANCE_PX &&
      Math.abs(rect.right - anchor.right) <= WORKSPACE_DRIFT_TOLERANCE_PX &&
      Math.abs(rect.width - anchor.width) <= WORKSPACE_DRIFT_TOLERANCE_PX
    ) {
      return;
    }

    this.stop();
    this.options.onOwnershipLoss(trigger);
  }

  private scheduleFallbackCheck(): void {
    if (this.fallbackFrame !== null || !this.anchor) {
      return;
    }
    this.fallbackFrame = window.requestAnimationFrame(() => {
      this.fallbackFrame = null;
      this.checkCurrentGeometry("animation-frame-fallback");
      if (this.anchor && this.options.isLayerActive()) {
        this.scheduleFallbackCheck();
      }
    });
  }

  private readAnchor(rootEl: HTMLElement): MobileWorkspaceAnchor {
    const rect = rootEl.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      viewportWidth: this.options.getViewportWidth()
    };
  }
}
