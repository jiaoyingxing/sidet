import { ToggleComponent, setIcon } from "obsidian";
import { shouldPreserveFocusedTextEntry } from "./press-focus";

export interface InlineActionMenuItem {
  title: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
  selected?: boolean;
  sectionStart?: boolean;
  toggleValue?: boolean;
  closeBeforeSelect?: boolean;
  activateOnPointerDown?: boolean;
  onSelect: () => void;
}

export interface InlineActionMenuHandle {
  close: () => void;
  reposition: () => void;
}

interface OpenInlineActionMenuOptions {
  anchorEl: HTMLElement;
  items: InlineActionMenuItem[];
  className?: string;
  verticalDirection?: "auto" | "down" | "up";
  onClose?: () => void;
}

export function openInlineActionMenu(options: OpenInlineActionMenuOptions): InlineActionMenuHandle {
  const { anchorEl, items, className, verticalDirection = "auto", onClose } = options;
  const doc = anchorEl.ownerDocument;
  const panelEl = doc.createElement("div");
  panelEl.className = className ? `sidet-inline-menu ${className}` : "sidet-inline-menu";
  panelEl.setAttribute("role", "menu");
  panelEl.setCssProps({ visibility: "hidden" });

  for (const item of items) {
    if (item.sectionStart && panelEl.childElementCount > 0) {
      const dividerEl = panelEl.createDiv({ cls: "sidet-inline-menu-divider" });
      dividerEl.setAttr("aria-hidden", "true");
    }
    const itemEl = panelEl.createDiv({
      cls: [
        "sidet-inline-menu-item",
        item.danger ? "is-danger" : "",
        item.selected ? "is-selected" : "",
        item.disabled ? "is-disabled" : "",
        typeof item.toggleValue === "boolean" ? "has-toggle" : ""
      ].filter(Boolean).join(" ")
    });
    itemEl.tabIndex = item.disabled ? -1 : 0;
    itemEl.setAttribute("role", "menuitem");
    if (item.disabled) {
      itemEl.setAttribute("aria-disabled", "true");
    }
    if (item.selected) {
      itemEl.setAttribute("aria-current", "true");
    }

    if (item.icon) {
      const iconEl = itemEl.createSpan({ cls: "sidet-inline-menu-item-icon" });
      iconEl.setAttribute("aria-hidden", "true");
      setIcon(iconEl, item.icon);
    }
    itemEl.createSpan({ cls: "sidet-inline-menu-item-label", text: item.title });
    let toggle: ToggleComponent | null = null;
    if (typeof item.toggleValue === "boolean") {
      const toggleWrapEl = itemEl.createSpan({ cls: "sidet-inline-menu-item-toggle" });
      toggle = new ToggleComponent(toggleWrapEl)
        .setValue(item.toggleValue)
        .setDisabled(Boolean(item.disabled));
      toggle.onChange(() => {
        if (item.disabled) {
          return;
        }
        item.onSelect();
      });
      toggle.toggleEl.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    }

    const activateItem = () => {
      if (item.disabled) {
        return;
      }
      if (toggle) {
        toggle.setValue(!toggle.getValue());
        item.onSelect();
        return;
      }
      if (item.closeBeforeSelect === false) {
        item.onSelect();
        close();
        return;
      }
      close();
      item.onSelect();
    };

    let didActivateOnPointerDown = false;
    itemEl.addEventListener("pointerdown", (event) => {
      if (shouldPreserveFocusedTextEntry(event)) {
        event.preventDefault();
      }
      if (!item.activateOnPointerDown) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      didActivateOnPointerDown = true;
      activateItem();
    });

    itemEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (didActivateOnPointerDown) {
        didActivateOnPointerDown = false;
        return;
      }
      activateItem();
    });

    itemEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      activateItem();
    });
  }

  doc.body.appendChild(panelEl);

  const reposition = () => {
    const anchorRect = anchorEl.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    const gap = 8;
    const viewportPadding = 10;
    const maxLeft = window.innerWidth - panelRect.width - viewportPadding;
    const minTop = viewportPadding;
    const maxTop = Math.max(viewportPadding, window.innerHeight - panelRect.height - viewportPadding);
    const left = clamp(anchorRect.right - panelRect.width, viewportPadding, Math.max(viewportPadding, maxLeft));
    const topAbove = anchorRect.top - panelRect.height - gap;
    const topBelow = anchorRect.bottom + gap;
    let top = topAbove;
    if (verticalDirection === "down") {
      top = topBelow > maxTop ? topAbove : topBelow;
    } else if (verticalDirection === "up") {
      top = topAbove < minTop ? topBelow : topAbove;
    } else if (top < minTop) {
      top = topBelow;
    }

    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${clamp(top, viewportPadding, maxTop)}px`;
    panelEl.setCssProps({ visibility: "visible" });
  };

  let isClosed = false;
  const close = () => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    doc.removeEventListener("pointerdown", onDocumentPointerDown, true);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("orientationchange", onViewportChange);
    doc.removeEventListener("scroll", onViewportChange, true);
    viewport?.removeEventListener("resize", onViewportChange);
    viewport?.removeEventListener("scroll", onViewportChange);
    panelEl.remove();
    onClose?.();
  };

  const onDocumentPointerDown = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      close();
      return;
    }
    if (panelEl.contains(target) || anchorEl.contains(target)) {
      return;
    }
    close();
  };

  const onViewportChange = () => {
    if (!anchorEl.isConnected) {
      close();
      return;
    }
    reposition();
  };

  doc.addEventListener("pointerdown", onDocumentPointerDown, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("orientationchange", onViewportChange);
  doc.addEventListener("scroll", onViewportChange, true);
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", onViewportChange);
  viewport?.addEventListener("scroll", onViewportChange);

  reposition();

  return {
    close,
    reposition
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
