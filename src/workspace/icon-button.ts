import { setIcon, setTooltip } from "obsidian";
import { shouldPreserveFocusedTextEntry } from "./press-focus";

interface IconButtonOptions {
  icon: string;
  label: string;
  className?: string;
  preserveFocus?: boolean;
  onClick: (event: MouseEvent) => void;
}

export function createIconButton(parent: HTMLElement, options: IconButtonOptions): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: ["clickable-icon", "sidet-icon-button", options.className].filter(Boolean).join(" ")
  });
  button.type = "button";
  button.setAttr("aria-label", options.label);
  setIcon(button, options.icon);
  setTooltip(button, options.label);
  if (options.preserveFocus) {
    const preserveFocus = (event: Event) => {
      if (!shouldPreserveFocusForPress(event)) {
        return;
      }
      event.preventDefault();
    };
    button.addEventListener("pointerdown", preserveFocus);
    button.addEventListener("mousedown", preserveFocus);
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    options.onClick(event);
  });
  return button;
}

function shouldPreserveFocusForPress(event: Event): boolean {
  return shouldPreserveFocusedTextEntry(event);
}
