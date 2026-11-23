import { App, WorkspaceLeaf, WorkspaceSidedock, WorkspaceTabs } from "obsidian";

export function resolveDesktopPaneItemElement(targetLeaf: WorkspaceLeaf): HTMLElement | null {
  if (isLeafInSideDock(targetLeaf)) {
    return null;
  }

  const tabs = targetLeaf.parent;
  if (!(tabs instanceof WorkspaceTabs)) {
    return null;
  }

  const tabsContainerEl = (tabs as WorkspaceTabs & { containerEl?: HTMLElement }).containerEl;
  if (!tabsContainerEl || !tabsContainerEl.isConnected || typeof tabsContainerEl.matches !== "function") {
    return null;
  }

  let candidate: HTMLElement | null = tabsContainerEl;
  while (candidate) {
    if (isDesktopPaneItemCandidate(candidate)) {
      return candidate;
    }

    const parent: HTMLElement | null = candidate.parentElement;
    if (!parent) {
      break;
    }
    candidate = parent.closest<HTMLElement>(".workspace-tabs, .workspace-split");
  }

  return tabsContainerEl.matches(".workspace-tabs") ? tabsContainerEl : null;
}

export function releaseDesktopPaneMinWidthIfUnused(
  paneItemEl: HTMLElement,
  currentLeaf: WorkspaceLeaf,
  app: App,
  viewType: string
): void {
  const hasOtherChatLeafInPane = app.workspace
    .getLeavesOfType(viewType)
    .some((leaf) => leaf !== currentLeaf && resolveDesktopPaneItemElement(leaf) === paneItemEl);

  if (!hasOtherChatLeafInPane) {
    paneItemEl.style.removeProperty("min-width");
  }
}

function isDesktopPaneItemCandidate(candidate: HTMLElement): boolean {
  if (!candidate.matches(".workspace-tabs, .workspace-split")) {
    return false;
  }

  const parent = candidate.parentElement;
  return Boolean(parent?.matches(".workspace-split.mod-vertical"));
}

function isLeafInSideDock(targetLeaf: WorkspaceLeaf): boolean {
  let current: { parent?: unknown } | null = targetLeaf.parent;
  while (current) {
    if (current instanceof WorkspaceSidedock) {
      return true;
    }
    current =
      current.parent && typeof current.parent === "object"
        ? (current.parent)
        : null;
  }
  return false;
}
