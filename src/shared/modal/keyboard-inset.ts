/**
 * 手机软键盘避让（2026-11-27 按 Resojot 已跑通机制移植）。
 *
 * - 可见区下沿按宿主键盘行为分型取信号，三线取最保守值：悬浮型（iOS 只写
 *   `--keyboard-height`）＝无键盘视口底 − 宿主键盘高度；压矮型（Android resize）
 *   ＝当前视口底；可视区收缩型＝`visualViewport` 报的下沿。
 * - 悬浮型没有事件可听（视口不动、CSS 变量不是事件源）：聚焦未释放或键盘未收时
 *   逐帧盯宿主变量，高度没变的帧只读一个变量、不做布局测量。
 * - 只扩大「能滚多远」：余量锚是 `::after` 绝对定位，不进文档流；被盖住的输入框
 *   由这里滚到可见区下沿上方 8px 呼吸位，键盘收起把滚动退回自然区。
 * - 锚的 `top` 按内容真实高度写入（`--sidet-keyboard-anchor-top`），不能写死
 *   100%——长表单内容本就溢出，100% 会让锚埋进已有内容、滚动范围不增。
 *
 * 只在手机端生效；桌面端是空操作。返回卸载函数，弹框 `onClose` 必须调用
 * （文档级监听不随弹框关闭消失）。
 */
import { Platform } from "obsidian";
import { planKeyboardInset } from "./keyboard-inset-geometry";

/** 被盖住的框滚到位后，框底与键盘上沿之间保留的呼吸位（px）。 */
const BREATH_PX = 8;

function isMobileClient(): boolean {
  return Platform.isMobile || Platform.isMobileApp;
}

export function bindSidetKeyboardInset(
  scrollEl: HTMLElement,
  options: { fieldsSelector?: string } = {}
): () => void {
  if (!isMobileClient()) {
    return () => undefined;
  }
  scrollEl.addClass("sidet-keyboard-inset");
  const doc = scrollEl.ownerDocument ?? document;
  const win = doc.defaultView;
  if (!win) {
    return () => undefined;
  }
  const fieldSelector = options.fieldsSelector ?? "input, textarea";

  /** 宿主写入的键盘高度（px）；取不到按 0。悬浮型宿主只有它知道键盘上沿。 */
  const readKeyboardHeight = (): number => {
    const raw = win
      .getComputedStyle(doc.documentElement)
      .getPropertyValue("--keyboard-height")
      .trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  /** 键盘未开时的视口高；键盘收起的那帧重新锚定，转屏等全高变化随之生效。 */
  let noKeyboardInnerHeight = win.innerHeight;

  /** 可见区下沿（视口坐标）＝三种宿主行为里最保守的一条。 */
  const readVisibleBottom = (): number => {
    const innerHeight = win.innerHeight;
    const keyboardHeight = readKeyboardHeight();
    if (keyboardHeight <= 0) {
      noKeyboardInnerHeight = innerHeight;
    }
    if (innerHeight < noKeyboardInnerHeight - 0.5) {
      return innerHeight;
    }
    const viewport = win.visualViewport;
    const viewportBottom = viewport
      ? viewport.offsetTop + viewport.height
      : innerHeight;
    if (keyboardHeight > 0) {
      return Math.min(noKeyboardInnerHeight - keyboardHeight, viewportBottom);
    }
    return Math.min(viewportBottom, noKeyboardInnerHeight);
  };

  let applied = 0;
  let poll = 0;
  let previousVisibleBottom = Number.POSITIVE_INFINITY;
  let seenKeyboardHeight = -1;
  let pendingWrite = false;

  const writeInset = (): void => {
    const visibleBottom = readVisibleBottom();
    // 可见区下沿回升＝键盘正在收：把滚动退回自然区，锚随之归零。
    const closing = visibleBottom > previousVisibleBottom + 0.5;
    previousVisibleBottom = visibleBottom;

    const active = doc.activeElement;
    const field = active instanceof HTMLElement
      && scrollEl.contains(active)
      && active.matches(fieldSelector)
      ? active
      : null;

    // 内容真实底边与「自然可滚上限」都只在纯函数里算，调用点不碰这段算术。
    let target = scrollEl.scrollTop;
    if (!closing && field) {
      const overlap = field.getBoundingClientRect().bottom - visibleBottom;
      if (overlap > 0) {
        target = scrollEl.scrollTop + overlap + BREATH_PX;
      }
    }

    const plan = planKeyboardInset({
      scrollHeight: scrollEl.scrollHeight,
      appliedInset: applied,
      clientHeight: scrollEl.clientHeight,
      targetScrollTop: target,
      reclaim: closing
    });
    applied = plan.inset;
    // 只写自定义属性，锚的盒模型在 styles.css 的 `.sidet-keyboard-inset` 规则里。
    scrollEl.style.setProperty(
      "--sidet-keyboard-anchor-top",
      `${plan.anchorTop}px`
    );
    scrollEl.style.setProperty("--sidet-keyboard-inset", `${plan.inset}px`);
    // 锚已就位，目标位置必在可滚范围内；与锚写入同帧执行，无中间态。
    if (plan.scrollTop !== scrollEl.scrollTop) {
      scrollEl.scrollTop = plan.scrollTop;
    }
  };

  /** 键盘是否开着：三条信号线（宿主变量／视口压矮／可视区收缩）任一生效。 */
  const keyboardOpen = (): boolean => {
    const viewport = win.visualViewport;
    const viewportBottom = viewport
      ? viewport.offsetTop + viewport.height
      : win.innerHeight;
    return seenKeyboardHeight > 0
      || win.innerHeight < noKeyboardInnerHeight - 0.5
      || viewportBottom < win.innerHeight - 0.5;
  };

  /** 悬浮型宿主没有事件源：聚焦或键盘开着时逐帧盯表。 */
  const tick = (): void => {
    poll = 0;
    const keyboardHeight = readKeyboardHeight();
    if (pendingWrite || keyboardHeight !== seenKeyboardHeight) {
      pendingWrite = false;
      seenKeyboardHeight = keyboardHeight;
      writeInset();
    }
    const active = doc.activeElement;
    const fieldFocused = active instanceof HTMLElement
      && scrollEl.contains(active)
      && active.matches(fieldSelector);
    if (fieldFocused || keyboardOpen()) {
      poll = win.requestAnimationFrame(tick);
    }
  };

  /** 合并同一帧内的多次触发（键盘动画会连续发很多帧）。 */
  const schedule = (): void => {
    pendingWrite = true;
    if (poll === 0) {
      poll = win.requestAnimationFrame(tick);
    }
  };

  schedule();
  const viewport = win.visualViewport;
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  win.addEventListener("resize", schedule);
  // 输入法候选条出现 / 收起会改变键盘高度；切换字段也要重算。
  doc.addEventListener("focusin", schedule, true);
  doc.addEventListener("focusout", schedule, true);

  return () => {
    if (poll !== 0) {
      win.cancelAnimationFrame(poll);
    }
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    win.removeEventListener("resize", schedule);
    doc.removeEventListener("focusin", schedule, true);
    doc.removeEventListener("focusout", schedule, true);
    scrollEl.removeClass("sidet-keyboard-inset");
    scrollEl.style.removeProperty("--sidet-keyboard-inset");
    scrollEl.style.removeProperty("--sidet-keyboard-anchor-top");
  };
}
