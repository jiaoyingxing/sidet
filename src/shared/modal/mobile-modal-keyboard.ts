/**
 * 手机弹窗：点非交互区域释放焦点，让宿主键盘收起（2026-11-27 按 Resojot 同件移植）。
 *
 * 不自己算键盘高度、不挪弹框——宿主 1.14.5 的键盘处理只压 `.app-container`，
 * `.modal-container` 不随键盘上移；看到「输入框跟着键盘上移」是浏览器把聚焦元素
 * 滚进可视区的默认行为。这里只负责点空白能收键盘。
 */
import { Platform, type Modal } from "obsidian";

const INTERACTIVE_TAG_NAMES = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "LABEL",
  "OPTION",
  "SELECT",
  "SUMMARY",
  "TEXTAREA"
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox"
]);

function getElement(target: EventTarget | null): HTMLElement | null {
  if (!target || typeof (target as HTMLElement).tagName !== "string") {
    return null;
  }
  return target as HTMLElement;
}

function isEditableField(element: Element): element is HTMLElement {
  const tagName = element.tagName.toUpperCase();
  if (tagName === "INPUT" || tagName === "TEXTAREA") {
    return true;
  }
  const contentEditable = element.getAttribute("contenteditable");
  return contentEditable !== null && contentEditable !== "false";
}

function isInteractiveElement(element: HTMLElement): boolean {
  if (INTERACTIVE_TAG_NAMES.has(element.tagName.toUpperCase())) {
    return true;
  }
  const contentEditable = element.getAttribute("contenteditable");
  if (contentEditable !== null && contentEditable !== "false") {
    return true;
  }
  const role = (element.getAttribute("role") ?? "").toLowerCase();
  return INTERACTIVE_ROLES.has(role) || element.hasAttribute("tabindex");
}

function isInteractiveTarget(
  target: EventTarget | null,
  boundary: HTMLElement
): boolean {
  let element = getElement(target);
  while (element) {
    // 先判边界：弹窗本体为收焦点挂了 tabindex="-1"，如果把「有 tabindex」
    // 当交互元素，点在空白处会在 boundary 上提前返回 true，键盘永远收不起来。
    if (element === boundary) {
      return false;
    }
    if (isInteractiveElement(element)) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

function isPhoneClient(): boolean {
  const platform = Platform as { isPhone?: boolean; isTablet?: boolean };
  const isPhone = platform.isPhone ?? !platform.isTablet;
  return Platform.isMobile && isPhone;
}

export function bindMobileModalKeyboardDismissal(modal: Modal): () => void {
  if (!isPhoneClient()) {
    return () => undefined;
  }

  const root = modal.contentEl;
  const releaseFocusedField = (event: MouseEvent): void => {
    const activeElement = root.ownerDocument.activeElement;
    if (
      !activeElement
      || !root.contains(activeElement)
      || !isEditableField(activeElement)
      || isInteractiveTarget(event.target, root)
    ) {
      return;
    }
    activeElement.blur();
  };

  root.addEventListener("click", releaseFocusedField);
  return () => root.removeEventListener("click", releaseFocusedField);
}
