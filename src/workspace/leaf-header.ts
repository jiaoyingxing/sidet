import { setIcon, type WorkspaceLeaf } from "obsidian";

interface LeafWithHeader extends WorkspaceLeaf {
  updateHeader?: () => void;
  tabHeaderInnerTitleEl?: HTMLElement;
  tabHeaderInnerIconEl?: HTMLElement;
}

export function syncLeafHeaderTitle(
  leaf: WorkspaceLeaf,
  displayText: string,
  icon?: string
): void {
  const leafWithHeader = leaf as LeafWithHeader;
  leafWithHeader.updateHeader?.();

  leafWithHeader.tabHeaderInnerTitleEl?.setText(displayText);
  leafWithHeader.tabHeaderInnerTitleEl?.setAttr("title", displayText);

  const containerEl = leaf.view?.containerEl;
  if (!containerEl) {
    return;
  }

  const titleEl = containerEl.querySelector<HTMLElement>(".view-header-title");
  titleEl?.setText(displayText);
  titleEl?.setAttr("title", displayText);

  if (!icon) {
    return;
  }

  const iconEls = new Set<HTMLElement>();
  if (leafWithHeader.tabHeaderInnerIconEl) {
    iconEls.add(leafWithHeader.tabHeaderInnerIconEl);
  }
  containerEl.querySelectorAll<HTMLElement>(".view-header-icon, .workspace-tab-header-inner-icon")
    .forEach((iconEl) => iconEls.add(iconEl));

  for (const iconEl of iconEls) {
    iconEl.empty();
    setIcon(iconEl, icon);
    iconEl.removeClass("is-hidden");
    iconEl.setAttr("aria-hidden", "true");
  }
}
