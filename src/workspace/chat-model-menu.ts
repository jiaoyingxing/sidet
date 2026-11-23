import { Menu, Platform } from "obsidian";
import {
  ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
  ALL_KNOWLEDGE_BASES_SELECTION
} from "../constants";
import { openInlineActionMenu, type InlineActionMenuHandle, type InlineActionMenuItem } from "./inline-action-menu";
import { showDesktopMenuAtAnchor } from "./desktop-menu";
import type { WorkspaceController } from "./workspace-controller";
import type { WorkspaceLeaf } from "obsidian";

interface ModelMenuItem extends InlineActionMenuItem {
  desktopTitle: string;
}

type AdaptiveMenuItem = InlineActionMenuItem & {
  desktopTitle?: string;
};

function openAdaptiveActionMenu(
  anchorEl: HTMLElement,
  items: AdaptiveMenuItem[],
  onClose: () => void
): InlineActionMenuHandle {
  let activeMenu: InlineActionMenuHandle | null = null;
  let didNotifyClose = false;

  const notifyClose = () => {
    if (didNotifyClose) {
      return;
    }
    didNotifyClose = true;
    onClose();
  };

  const handleMenuClose = () => {
    activeMenu = null;
    notifyClose();
  };

  if (Platform.isMobile || Platform.isPhone) {
    activeMenu = openInlineActionMenu({
      anchorEl,
      items,
      className: "sidet-model-menu",
      onClose: handleMenuClose
    });
  } else {
    const menu = new Menu();
    let hasAddedItem = false;
    for (const item of items) {
      if (item.sectionStart && hasAddedItem) {
        menu.addSeparator();
      }
      menu.addItem((menuItem) => {
        menuItem
          .setTitle(item.desktopTitle ?? item.title)
          .setChecked(item.selected ? true : null)
          .setDisabled(Boolean(item.disabled))
          .onClick(item.onSelect);
        if (item.icon) {
          menuItem.setIcon(item.icon);
        }
      });
      hasAddedItem = true;
    }

    activeMenu = showDesktopMenuAtAnchor({
      menu,
      anchorEl,
      onClose: handleMenuClose,
      placement: "above-anchor",
      onAfterShow: () => {
        decorateDesktopModelMenu(anchorEl.ownerDocument, items);
      }
    });
  }

  return {
    close: () => {
      activeMenu?.close();
      notifyClose();
    },
    reposition: () => {
      activeMenu?.reposition();
    }
  };
}

async function buildKnowledgeBaseMenuItems(
  controller: WorkspaceController,
  leaf: WorkspaceLeaf
): Promise<AdaptiveMenuItem[]> {
  await controller.refreshKnowledgeBases().catch((error) => {
    console.warn("Sidet：打开知识库菜单前刷新识别失败。", error);
  });

  const currentKnowledgeBases = controller.getAvailableKnowledgeBases();
  const selectedKnowledgeBaseState = controller.getSelectedKnowledgeBaseState(leaf);

  return [
    {
      title: ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
      desktopTitle: ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
      icon: "layers",
      selected: selectedKnowledgeBaseState.mode === "all",
      onSelect: () => {
        controller.setSelectedKnowledgeBase(leaf, ALL_KNOWLEDGE_BASES_SELECTION);
      }
    },
    ...(currentKnowledgeBases.length > 0
      ? currentKnowledgeBases.map((knowledgeBase, index) => ({
          title: knowledgeBase.displayName,
          desktopTitle: knowledgeBase.displayName,
          icon: "library",
          selected: selectedKnowledgeBaseState.mode === "single"
            && selectedKnowledgeBaseState.indexPath === knowledgeBase.indexPath,
          sectionStart: index === 0,
          onSelect: () => {
            controller.setSelectedKnowledgeBase(leaf, knowledgeBase.indexPath);
          }
        }))
      : [
          {
            title: "暂无可用知识库",
            desktopTitle: "暂无可用知识库",
            icon: "library",
            disabled: true,
            sectionStart: true,
            onSelect: () => undefined
          }
        ])
  ];
}

export async function openKnowledgeBaseSelectionMenu(
  anchorEl: HTMLElement,
  controller: WorkspaceController,
  onClose: () => void,
  leaf: WorkspaceLeaf
): Promise<InlineActionMenuHandle> {
  const items = await buildKnowledgeBaseMenuItems(controller, leaf);
  return openAdaptiveActionMenu(anchorEl, items, onClose);
}

export function openChatModelMenu(
  anchorEl: HTMLElement,
  controller: WorkspaceController,
  onClose: () => void,
  leaf: WorkspaceLeaf
): InlineActionMenuHandle {
  const configuredModelConfigs = controller.getAvailableModelConfigs();
  const selectedModelConfigId = controller.getLeafModelConfigId(leaf);
  const selectedKnowledgeBaseState = controller.getSelectedKnowledgeBaseState(leaf);
  const webSearchEnabled = controller.isWebSearchEnabled(leaf);
  let activeMenu: InlineActionMenuHandle | null = null;
  let didNotifyClose = false;
  let suppressNextCloseNotification = false;

  const notifyClose = () => {
    if (didNotifyClose) {
      return;
    }
    didNotifyClose = true;
    onClose();
  };

  const handleMenuClose = () => {
    activeMenu = null;
    if (suppressNextCloseNotification) {
      suppressNextCloseNotification = false;
      return;
    }
    notifyClose();
  };

  const items: ModelMenuItem[] = [
    ...configuredModelConfigs.map((config) => ({
      desktopTitle: config.model,
      title: config.model,
      icon: config.reasoningEnabled ? "brain" : undefined,
      selected: config.id === selectedModelConfigId,
      onSelect: () => {
        if (config.id !== controller.getLeafModelConfigId(leaf)) {
          void controller.setLeafModelConfig(leaf, config.id);
        }
      }
    })),
    {
      desktopTitle: "联网搜索",
      title: `联网搜索${webSearchEnabled ? "✓" : ""}`,
      icon: "globe",
      selected: webSearchEnabled,
      sectionStart: configuredModelConfigs.length > 0,
      onSelect: () => {
        controller.setWebSearchEnabled(leaf, !controller.isWebSearchEnabled(leaf));
      }
    },
    {
      desktopTitle: "知识库模式",
      title: selectedKnowledgeBaseState.displayName
        ? `知识库：${selectedKnowledgeBaseState.displayName}`
        : "知识库：关闭",
      icon: "library",
      sectionStart: true,
      closeBeforeSelect: false,
      onSelect: () => {
        suppressNextCloseNotification = true;
        window.setTimeout(() => {
          void openKnowledgeBaseSelectionMenu(anchorEl, controller, () => {
            activeMenu = null;
            notifyClose();
          }, leaf).then((handle) => {
            if (didNotifyClose) {
              handle.close();
              return;
            }
            activeMenu = handle;
          });
        }, 0);
      }
    }
  ];

  activeMenu = openAdaptiveActionMenu(anchorEl, items, handleMenuClose);
  return {
    close: () => {
      activeMenu?.close();
      notifyClose();
    },
    reposition: () => {
      activeMenu?.reposition();
    }
  };
}

function decorateDesktopModelMenu(doc: Document, items: Array<Pick<InlineActionMenuItem, "selected">>): void {
  const menus = Array.from(doc.querySelectorAll<HTMLElement>(".menu"));
  let menuEl: HTMLElement | null = null;
  for (let index = menus.length - 1; index >= 0; index -= 1) {
    const candidate = menus[index];
    if (candidate.dataset.sidetModelMenuDecorated) {
      continue;
    }
    menuEl = candidate;
    break;
  }
  if (!menuEl) {
    return;
  }

  menuEl.dataset.sidetModelMenuDecorated = "true";
  menuEl.classList.add("sidet-desktop-model-menu");
  const menuItems = Array.from(menuEl.querySelectorAll<HTMLElement>(".menu-item"));
  for (let index = 0; index < menuItems.length; index += 1) {
    if (!items[index]?.selected) {
      continue;
    }
    menuItems[index].classList.add("is-sidet-selected");
  }
}
