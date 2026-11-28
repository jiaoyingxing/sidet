import { setIcon, setTooltip } from "obsidian";
import { renderComposerChip } from "./chat-attachment-rendering";
import type { WorkspaceController } from "./workspace-controller";

export type ChatHomeCapabilityId =
  | "web-clipping"
  | "web-search";

export interface ChatHomeCapability {
  id: ChatHomeCapabilityId;
  label: string;
  icon: string;
  selected: boolean;
  onSelect: (anchorEl: HTMLElement) => void;
}

export interface ChatHomeRenderOptions {
  capabilities: ChatHomeCapability[];
}

export interface ChatHomeRenderResult {
  composerSlotEl: HTMLDivElement;
  capabilityRowEl: HTMLDivElement;
  capabilityEls: Map<ChatHomeCapabilityId, HTMLDivElement>;
}

export const CHAT_HOME_CAPABILITY_LABELS: Record<ChatHomeCapabilityId, string> = {
  "web-clipping": "网页剪藏",
  "web-search": "联网搜索"
};

export function setChatHomeCapabilitySelected(
  chipEl: HTMLDivElement,
  selected: boolean,
  label?: string
): void {
  chipEl.classList.toggle("is-home-capability-selected", selected);
  chipEl.setAttribute("aria-pressed", selected ? "true" : "false");
  if (label) {
    // 能力 chip 是开关：选中态下再点是取消，读屏名称要跟着动作走。
    chipEl.setAttribute("aria-label", selected ? `取消${label}` : `选择${label}`);
  }
}

export function renderChatHome(
  parentEl: HTMLElement,
  controller: WorkspaceController,
  options: ChatHomeRenderOptions
): ChatHomeRenderResult {
  const home = parentEl.createDiv({ cls: "sidet-home" });
  home.createEl("h1", {
    cls: "sidet-home-title",
    text: "sidet"
  });

  const capabilityEls = new Map<ChatHomeCapabilityId, HTMLDivElement>();
  const capabilityRowEl = home.createDiv({ cls: "sidet-home-capability-row" });
  for (const capability of options.capabilities) {
    const chipEl = renderComposerChip(capabilityRowEl, {
      label: capability.label,
      icon: capability.icon,
      className: "sidet-home-capability-chip",
      clickable: true,
      preserveFocus: true,
      ariaLabel: `选择${capability.label}`,
      onClick: capability.onSelect
    });
    chipEl.setAttr("data-sidet-home-capability", capability.id);
    setChatHomeCapabilitySelected(chipEl, capability.selected, capability.label);
    capabilityEls.set(capability.id, chipEl);
  }

  const composerSlotEl = home.createDiv({ cls: "sidet-home-composer-slot" });
  const actionInfos = controller.getHomePinnedCommandInfos();
  const actionGrid = home.createDiv({ cls: "sidet-home-command-grid" });
  if (actionInfos.length === 0) {
    actionGrid.createDiv({
      cls: "sidet-home-command-empty",
      text: "在 Sidet 设置里添加主页命令。"
    });
    return {
      composerSlotEl,
      capabilityRowEl,
      capabilityEls
    };
  }

  for (const actionInfo of actionInfos) {
    const actionItem = actionGrid.createDiv({ cls: "sidet-home-command-item" });
    const actionButton = actionItem.createEl("button", {
      cls: `sidet-home-command${actionInfo.available ? "" : " is-disabled"}`
    });
    actionButton.type = "button";
    actionButton.disabled = !actionInfo.available;
    actionButton.setAttr("aria-label", actionInfo.label);
    setTooltip(
      actionButton,
      actionInfo.available
        ? `${actionInfo.commandName}${actionInfo.sourceLabel ? ` · ${actionInfo.sourceLabel}` : ""}`
        : `命令不可用：${actionInfo.commandId}`
    );

    const iconWrap = actionButton.createSpan({ cls: "sidet-home-command-icon" });
    iconWrap.setAttr("aria-hidden", "true");
    setIcon(iconWrap, actionInfo.icon);

    actionButton.addEventListener("click", () => {
      void controller.executeHomePinnedCommand(actionInfo.commandId);
    });
    actionItem.createDiv({
      cls: "sidet-home-command-label",
      text: actionInfo.label
    });
  }

  return {
    composerSlotEl,
    capabilityRowEl,
    capabilityEls
  };
}
