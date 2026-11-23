import { setIcon, setTooltip } from "obsidian";
import { shouldPreserveFocusedTextEntry } from "./press-focus";

export interface SendButtonControl {
  buttonEl: HTMLButtonElement;
  setState: (state: SendButtonState) => void;
}

export interface SendButtonState {
  disabled: boolean;
  streaming: boolean;
  idleLabel?: string;
  stopLabel?: string;
}

interface CreateSendButtonOptions {
  className?: string;
  preserveFocus?: boolean;
  onClick: (event: MouseEvent) => void;
}

export function createSendButtonControl(
  parent: HTMLElement,
  options: CreateSendButtonOptions
): SendButtonControl {
  const buttonEl = parent.createEl("button", {
    cls: ["sidet-send-button", options.className].filter(Boolean).join(" ")
  });
  buttonEl.type = "button";
  buttonEl.setAttribute("data-tooltip-position", "top");
  buttonEl.setAttribute("aria-pressed", "false");

  const iconEl = buttonEl.createSpan({ cls: "sidet-send-button-icon" });
  iconEl.setAttribute("aria-hidden", "true");

  if (options.preserveFocus) {
    const preserveFocus = (event: Event) => {
      if (!shouldPreserveFocusForPress(event)) {
        return;
      }
      event.preventDefault();
    };
    buttonEl.addEventListener("pointerdown", preserveFocus);
    buttonEl.addEventListener("mousedown", preserveFocus);
  }

  buttonEl.addEventListener("click", (event) => {
    event.preventDefault();
    options.onClick(event);
  });

  const setState = (state: SendButtonState) => {
    const label = state.streaming ? state.stopLabel ?? "停止生成" : state.idleLabel ?? "发送";
    buttonEl.disabled = state.disabled;
    buttonEl.setAttribute("aria-label", label);
    buttonEl.setAttribute("aria-pressed", state.streaming ? "true" : "false");
    buttonEl.dataset.state = state.streaming ? "streaming" : state.disabled ? "disabled" : "ready";
    setTooltip(buttonEl, label);
    setIcon(iconEl, state.streaming ? "x" : "check");
  };

  setState({
    disabled: true,
    streaming: false
  });

  return {
    buttonEl,
    setState
  };
}

function shouldPreserveFocusForPress(event: Event): boolean {
  return shouldPreserveFocusedTextEntry(event);
}
