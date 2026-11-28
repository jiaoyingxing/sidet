/**
 * 通用弹窗外壳与底栏（2026-11-27 按 Resojot《弹框标准与核心约束》移植）。
 *
 * 只承担三件事：挂根类 / 设标题 / 清空内容区并切出「表单 + 底栏」两段。
 * 宽度、圆角、标题带、关闭按钮、按钮排布与高度全部交还宿主，插件不另写。
 * 两段只负责分区与行距，滚动由具体弹框的表单区自己声明（长表单例外）。
 */
import type { Modal } from "obsidian";
import { bindSidetKeyboardInset } from "./keyboard-inset";

interface SidetModalShellOptions {
  rootClassName: string;
  title: string;
  layoutClassName: string;
  sectionClassName: string;
  /**
   * 表单区本身是滚动容器时打开：接 `bindSidetKeyboardInset`。返回值里的
   * `keyboardInsetDispose` 必须在弹框 `onClose` 调用——文档级监听不随弹框关闭消失。
   * 桌面端绑定是空操作，仍应照常卸载。
   */
  keyboardInset?: boolean;
}

export interface SidetModalShellResult {
  formSectionEl: HTMLElement;
  actionSectionEl: HTMLElement;
  keyboardInsetDispose: () => void;
}

export function createSidetModalShell(
  modal: Modal,
  options: SidetModalShellOptions
): SidetModalShellResult {
  modal.modalEl.addClass(options.rootClassName);
  modal.titleEl.setText(options.title);
  modal.contentEl.empty();
  modal.contentEl.addClass(options.layoutClassName);

  const formSectionEl = modal.contentEl.createDiv({
    cls: `${options.sectionClassName} ${options.sectionClassName}--form`
  });
  const keyboardInsetDispose = options.keyboardInset
    ? bindSidetKeyboardInset(formSectionEl)
    : () => undefined;
  const actionSectionEl = modal.contentEl.createDiv({
    cls: `${options.sectionClassName} ${options.sectionClassName}--actions`
  });

  return { formSectionEl, actionSectionEl, keyboardInsetDispose };
}

/**
 * 弹框底栏：容器用宿主 `.modal-button-container`，按钮继续用 `ButtonComponent`。
 * 对齐、换行、手机竖排 / 通栏、安全区归宿主 CSS；插件只补 16px 顶距和可选分割线。
 * 不要再拿 `Setting` 行当底栏壳，也不要手写右对齐 / 88px / 手机通栏。
 */
export function createSidetModalFooter(
  parentEl: HTMLElement,
  options: { divided?: boolean } = {}
): HTMLElement {
  return parentEl.createDiv({
    cls: `modal-button-container sidet-modal-footer${options.divided ? " is-divided" : ""}`
  });
}

export interface SidetModalErrorHandle {
  el: HTMLElement;
  show(message: string): void;
  clear(): void;
}

/**
 * 弹框级错误条（底栏上方一条）：统一 `role="alert"` 与显隐类，调用方只写文案。
 * 字段级错误仍用 `.sidet-field-error`，不要拿这条代替字段定位。
 */
export function createSidetModalError(parentEl: HTMLElement): SidetModalErrorHandle {
  const el = parentEl.createDiv({
    cls: "sidet-modal-error",
    attr: {
      role: "alert",
      "aria-live": "polite"
    }
  });
  return {
    el,
    show(message: string): void {
      el.setText(message);
      el.addClass("is-visible");
    },
    clear(): void {
      el.setText("");
      el.removeClass("is-visible");
    }
  };
}

/**
 * 打开弹窗后把焦点收回弹窗本体（2026-11-27 按 Resojot 共享件移植）。
 * 宿主会把焦点落到第一个可聚焦控件，1.13+ 的 `select:focus-visible` 会套一圈
 * 3px 灰环；本体挂 `tabindex="-1"` 后既无焦点样式，也不会被宿主挑中，Tab 仍从
 * 第一个控件开始。microtask 排在宿主那一拍之后、首次绘制之前，不闪环。
 */
export function keepModalFocusOnBody(modal: Modal): void {
  modal.contentEl.setAttribute("tabindex", "-1");
  queueMicrotask(() => {
    modal.contentEl.focus({ preventScroll: true });
  });
}
