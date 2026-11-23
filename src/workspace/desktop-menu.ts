import { Menu, type MenuPositionDef } from "obsidian";
import type { InlineActionMenuHandle } from "./inline-action-menu";

export type DesktopMenuPlacement = "align" | "side-left" | "above-anchor";

interface ShowDesktopMenuAtAnchorOptions {
  menu: Menu;
  anchorEl: HTMLElement;
  onClose?: () => void;
  onAfterShow?: () => void;
  placement?: DesktopMenuPlacement;
}

export function showDesktopMenuAtAnchor(options: ShowDesktopMenuAtAnchorOptions): InlineActionMenuHandle {
  const { menu, anchorEl, onClose, onAfterShow, placement } = options;
  const doc = anchorEl.ownerDocument;
  const existingMenus = placement === "above-anchor"
    ? Array.from(doc.querySelectorAll<HTMLElement>(".menu"))
    : [];
  let isClosed = false;
  const close = () => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    menu.close();
  };

  menu.onHide(() => {
    isClosed = true;
    onClose?.();
  });
  menu.showAtPosition(getDesktopMenuAnchorPosition(anchorEl, placement), doc);
  if (onAfterShow || placement === "above-anchor") {
    window.requestAnimationFrame(() => {
      if (placement === "above-anchor") {
        const menuEl = resolveLatestDesktopMenuElement(doc, existingMenus);
        if (menuEl) {
          positionDesktopMenuAboveAnchor(menuEl, anchorEl);
        }
      }
      onAfterShow?.();
    });
  }

  return {
    close,
    reposition: () => undefined
  };
}

export function getDesktopMenuAnchorPosition(
  anchorEl: HTMLElement,
  placement: DesktopMenuPlacement = "align"
): MenuPositionDef {
  const rect = anchorEl.getBoundingClientRect();
  if (placement === "side-left") {
    return {
      x: rect.left,
      y: rect.bottom,
      overlap: false,
      left: true
    };
  }

  return {
    x: rect.left,
    y: rect.bottom,
    width: rect.width,
    overlap: false
  };
}

function resolveLatestDesktopMenuElement(
  doc: Document,
  existingMenus: HTMLElement[]
): HTMLElement | null {
  const currentMenus = Array.from(doc.querySelectorAll<HTMLElement>(".menu"));
  return currentMenus.find((menuEl) => !existingMenus.includes(menuEl))
    ?? currentMenus[currentMenus.length - 1]
    ?? null;
}

function positionDesktopMenuAboveAnchor(menuEl: HTMLElement, anchorEl: HTMLElement): void {
  const anchorRect = anchorEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const viewportWidth = window.innerWidth || anchorEl.ownerDocument.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || anchorEl.ownerDocument.documentElement.clientHeight;
  const gap = 8;
  const clampedLeft = clamp(anchorRect.left, gap, Math.max(gap, viewportWidth - menuRect.width - gap));
  const preferredTop = anchorRect.top - menuRect.height - gap;
  const clampedTop = clamp(preferredTop, gap, Math.max(gap, viewportHeight - menuRect.height - gap));

  menuEl.style.left = `${Math.round(clampedLeft)}px`;
  menuEl.style.top = `${Math.round(clampedTop)}px`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
