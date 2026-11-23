import { setIcon } from "obsidian";

interface NavigationRowOptions {
  title: string;
  active: boolean;
  icon?: string;
  onOpen: () => void;
  onOpenMenu?: (anchorEl: HTMLElement) => void;
}

interface BrowserViewTouchRuntimeOptions {
  getListEl: () => HTMLDivElement | null;
  isMobileRuntime: () => boolean;
}

export class BrowserViewTouchRuntime {
  private static readonly TOUCH_ROW_TAP_MAX_DISTANCE = 10;
  private static readonly TOUCH_PRESS_FEEDBACK_DELAY_MS = 60;
  private static readonly TOUCH_SYNTHETIC_CLICK_SUPPRESS_MS = 450;
  private static readonly TOUCH_SYNTHETIC_CLICK_SUPPRESS_RADIUS = 28;
  private static readonly TOUCH_ROW_MENU_LONG_PRESS_MS = 520;

  private suppressSyntheticClickUntil = 0;
  private suppressSyntheticClickPoint: { x: number; y: number } | null = null;

  constructor(private readonly options: BrowserViewTouchRuntimeOptions) {}

  createNavigationRow(options: NavigationRowOptions): {
    item: HTMLDivElement;
    navTarget: HTMLDivElement;
  } {
    const listEl = this.options.getListEl();
    if (!listEl) {
      throw new Error("Sidet browser list is not ready.");
    }

    let handledByPointerActivation = false;
    let cancelTouchActivation: (() => void) | null = null;
    const item = listEl.createDiv({
      cls: `tree-item nav-file sidet-browser-row${options.active ? " is-active" : ""}`
    });
    item.setAttr("role", "none");

    const navTarget = item.createDiv({
      cls: `tree-item-self nav-file-title sidet-browser-row-main${options.active ? " is-active" : ""}`
    });
    navTarget.setAttr("role", "treeitem");
    navTarget.setAttr("aria-selected", options.active ? "true" : "false");
    if (options.active) {
      navTarget.setAttr("aria-current", "page");
    }
    navTarget.tabIndex = 0;
    const setNavEngaged = (engaged: boolean) => {
      item.toggleClass("is-nav-engaged", engaged);
    };
    const releaseTransientState = (): void => {
      item.removeClass("is-touch-pressing");
      setNavEngaged(false);
    };
    navTarget.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse") {
        if (event.button !== 0) {
          return;
        }
        handledByPointerActivation = true;
        event.preventDefault();
        options.onOpen();
        return;
      }

      cancelTouchActivation?.();
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let cancelled = false;
      let longPressTriggered = false;
      let pressFeedbackTimer: number | null = window.setTimeout(() => {
        item.addClass("is-touch-pressing");
        pressFeedbackTimer = null;
      }, BrowserViewTouchRuntime.TOUCH_PRESS_FEEDBACK_DELAY_MS);
      let longPressTimer: number | null = window.setTimeout(() => {
        if (!options.onOpenMenu || !this.isMobileRuntime()) {
          return;
        }
        longPressTriggered = true;
        cancelled = true;
        handledByPointerActivation = true;
        this.suppressSyntheticClickAt(startX, startY);
        item.removeClass("is-touch-pressing");
        navigator.vibrate?.(10);
        options.onOpenMenu(navTarget);
        releaseTransientState();
      }, BrowserViewTouchRuntime.TOUCH_ROW_MENU_LONG_PRESS_MS);

      const cleanup = (): void => {
        window.removeEventListener("pointermove", handlePointerMove, { capture: true });
        window.removeEventListener("pointerup", handlePointerUp, { capture: true });
        window.removeEventListener("pointercancel", handlePointerCancel, { capture: true });
        if (pressFeedbackTimer !== null) {
          window.clearTimeout(pressFeedbackTimer);
          pressFeedbackTimer = null;
        }
        if (longPressTimer !== null) {
          window.clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        item.removeClass("is-touch-pressing");
        cancelTouchActivation = null;
      };

      const handlePointerMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }
        const distanceX = Math.abs(moveEvent.clientX - startX);
        const distanceY = Math.abs(moveEvent.clientY - startY);
        if (
          distanceX > BrowserViewTouchRuntime.TOUCH_ROW_TAP_MAX_DISTANCE ||
          distanceY > BrowserViewTouchRuntime.TOUCH_ROW_TAP_MAX_DISTANCE
        ) {
          cancelled = true;
          if (pressFeedbackTimer !== null) {
            window.clearTimeout(pressFeedbackTimer);
            pressFeedbackTimer = null;
          }
          if (longPressTimer !== null) {
            window.clearTimeout(longPressTimer);
            longPressTimer = null;
          }
          item.removeClass("is-touch-pressing");
        }
      };

      const handlePointerUp = (upEvent: PointerEvent): void => {
        if (upEvent.pointerId !== pointerId) {
          return;
        }
        cleanup();
        if (longPressTriggered) {
          return;
        }
        if (cancelled) {
          return;
        }
        handledByPointerActivation = true;
        upEvent.preventDefault();
        upEvent.stopPropagation();
        this.suppressSyntheticClickAt(upEvent.clientX, upEvent.clientY);
        options.onOpen();
        releaseTransientState();
      };

      const handlePointerCancel = (cancelEvent: PointerEvent): void => {
        if (cancelEvent.pointerId !== pointerId) {
          return;
        }
        cleanup();
      };

      cancelTouchActivation = cleanup;
      window.addEventListener("pointermove", handlePointerMove, { capture: true });
      window.addEventListener("pointerup", handlePointerUp, { capture: true });
      window.addEventListener("pointercancel", handlePointerCancel, { capture: true });
    });
    navTarget.addEventListener("click", (event) => {
      event.preventDefault();
      if (handledByPointerActivation) {
        handledByPointerActivation = false;
        return;
      }
      if (this.shouldSuppressSyntheticClick(event)) {
        event.stopPropagation();
        return;
      }
      options.onOpen();
      releaseTransientState();
    });
    navTarget.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      options.onOpen();
      releaseTransientState();
    });
    navTarget.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      setNavEngaged(true);
    });
    navTarget.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      setNavEngaged(false);
    });
    navTarget.addEventListener("focusin", () => {
      setNavEngaged(true);
    });
    navTarget.addEventListener("focusout", () => {
      window.requestAnimationFrame(() => {
        setNavEngaged(navTarget.contains(document.activeElement));
      });
    });
    navTarget.addEventListener("blur", releaseTransientState);

    if (options.icon) {
      const iconEl = navTarget.createSpan({ cls: "sidet-browser-row-leading-icon" });
      iconEl.setAttr("aria-hidden", "true");
      setIcon(iconEl, options.icon);
    }
    navTarget.createDiv({
      cls: "tree-item-inner nav-file-title-content sidet-browser-row-title",
      text: options.title
    });

    return { item, navTarget };
  }

  attachActionsEngagement(item: HTMLDivElement, actions: HTMLDivElement): void {
    const setActionsEngaged = (engaged: boolean) => {
      item.toggleClass("is-actions-engaged", engaged);
    };
    actions.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      setActionsEngaged(true);
    });
    actions.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      setActionsEngaged(false);
    });
    actions.addEventListener("focusin", () => {
      setActionsEngaged(true);
    });
    actions.addEventListener("focusout", () => {
      window.requestAnimationFrame(() => {
        setActionsEngaged(actions.contains(document.activeElement));
      });
    });
  }

  reset(): void {
    this.suppressSyntheticClickUntil = 0;
    this.suppressSyntheticClickPoint = null;
  }

  private suppressSyntheticClickAt(x: number, y: number): void {
    this.suppressSyntheticClickUntil = Date.now() + BrowserViewTouchRuntime.TOUCH_SYNTHETIC_CLICK_SUPPRESS_MS;
    this.suppressSyntheticClickPoint = { x, y };
  }

  private isMobileRuntime(): boolean {
    return this.options.isMobileRuntime();
  }

  private shouldSuppressSyntheticClick(event: MouseEvent): boolean {
    if (Date.now() > this.suppressSyntheticClickUntil) {
      this.suppressSyntheticClickPoint = null;
      return false;
    }

    const point = this.suppressSyntheticClickPoint;
    if (!point) {
      return true;
    }

    const distanceX = Math.abs(event.clientX - point.x);
    const distanceY = Math.abs(event.clientY - point.y);
    return (
      distanceX <= BrowserViewTouchRuntime.TOUCH_SYNTHETIC_CLICK_SUPPRESS_RADIUS &&
      distanceY <= BrowserViewTouchRuntime.TOUCH_SYNTHETIC_CLICK_SUPPRESS_RADIUS
    );
  }
}
