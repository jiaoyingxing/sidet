/**
 * 原生 `<details>` 折叠块的高度过渡。
 *
 * 只给用户主动开合的轻块用：深度思考 / 过程面板、来源 footer。
 * 流式正文和工具过程内容会自己变高，不走这里，避免和贴底跟随打架。
 */
export interface SmoothDetailsToggleOptions {
  bodyEl: HTMLElement;
  /** 手动开合开始时调用，参数为开合方向；聊天据此决定展开跟随、收起保护锚点。 */
  onToggle?: (open: boolean) => void;
  durationMs?: number;
}

const installed = new WeakMap<HTMLDetailsElement, HTMLElement>();
const controllers = new WeakMap<HTMLDetailsElement, { open: () => void }>();
const DEFAULT_DURATION_MS = 160;
const MAX_MEASURE_ATTEMPTS = 3;
const MEASURE_RETRY_MS = 16;

export function installSmoothDetailsToggle(
  detailsEl: HTMLDetailsElement,
  options: SmoothDetailsToggleOptions
): void {
  const summaryEl = detailsEl.querySelector<HTMLElement>(":scope > summary");
  if (!summaryEl) {
    return;
  }
  if (installed.get(detailsEl) === summaryEl) {
    return;
  }
  installed.set(detailsEl, summaryEl);

  const bodyEl = options.bodyEl;
  const duration = options.durationMs ?? DEFAULT_DURATION_MS;
  let animation: Animation | null = null;
  let measureTimer: number | null = null;
  let finishTimer: number | null = null;

  const clearStyles = (): void => {
    bodyEl.classList.remove("is-smooth-animating");
  };

  const clearTimers = (): void => {
    if (measureTimer !== null) {
      window.clearTimeout(measureTimer);
      measureTimer = null;
    }
    if (finishTimer !== null) {
      window.clearTimeout(finishTimer);
      finishTimer = null;
    }
  };

  const cancelPending = (): void => {
    clearTimers();
    if (animation) {
      animation.cancel();
      animation = null;
    }
    detailsEl.classList.remove("is-smooth-closing");
    clearStyles();
  };

  const finish = (open: boolean): void => {
    clearTimers();
    if (animation) {
      animation.cancel();
      animation = null;
    }
    detailsEl.classList.remove("is-smooth-closing");
    detailsEl.open = open;
    clearStyles();
  };

  const animateTo = (open: boolean, startHeight: number, endHeight: number): void => {
    const styles = getComputedStyle(bodyEl);
    const startPadding = open ? "0px" : styles.paddingBottom;
    const startMargin = open ? "0px" : styles.marginTop;
    bodyEl.classList.add("is-smooth-animating");
    animation = bodyEl.animate(
      [
        {
          height: `${Math.max(0, startHeight)}px`,
          paddingBottom: startPadding,
          marginTop: startMargin
        },
        {
          height: `${Math.max(0, endHeight)}px`,
          paddingBottom: open ? styles.paddingBottom : "0px",
          marginTop: open ? styles.marginTop : "0px"
        }
      ],
      { duration, easing: "ease" }
    );
    // 隐藏窗口里 Web Animations 的 finish 事件可能被挂起；定时器兜底。
    finishTimer = window.setTimeout(() => finish(open), duration + 40);
    animation.onfinish = () => finish(open);
  };

  const openAnimated = (): void => {
    if (detailsEl.open && animation === null) {
      return;
    }
    options.onToggle?.(true);
    cancelPending();
    detailsEl.open = true;
    let attempts = 0;
    const measure = (): void => {
      measureTimer = null;
      if (!detailsEl.open || animation) {
        return;
      }
      // 开合时正文可能是按需渲染的；等内容真正挂上再量高度。
      const hasContent = bodyEl.childElementCount > 0
        || (bodyEl.textContent?.trim().length ?? 0) > 0;
      const height = bodyEl.getBoundingClientRect().height;
      if (!hasContent || height <= 0) {
        if (attempts < MAX_MEASURE_ATTEMPTS) {
          attempts += 1;
          measureTimer = window.setTimeout(measure, MEASURE_RETRY_MS);
        } else if (!hasContent) {
          clearStyles();
        }
        return;
      }
      animateTo(true, 0, height);
    };
    measureTimer = window.setTimeout(measure, 0);
  };

  const closeAnimated = (): void => {
    if (!detailsEl.open || animation) {
      return;
    }
    options.onToggle?.(false);
    const startHeight = bodyEl.getBoundingClientRect().height;
    if (startHeight <= 0) {
      detailsEl.open = false;
      clearStyles();
      return;
    }
    detailsEl.classList.add("is-smooth-closing");
    animateTo(false, startHeight, 0);
  };

  summaryEl.addEventListener("click", (event) => {
    event.preventDefault();
    if (detailsEl.open) {
      closeAnimated();
    } else {
      openAnimated();
    }
  });

  controllers.set(detailsEl, { open: openAnimated });
}

/** 让程序化的「查看来源」等入口复用同一段展开过渡；未安装时返回 false。 */
export function openSmoothDetails(detailsEl: HTMLDetailsElement): boolean {
  const controller = controllers.get(detailsEl);
  if (!controller) {
    return false;
  }
  controller.open();
  return true;
}
