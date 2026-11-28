import { Menu, Platform } from "obsidian";
import { UNTITLED_CONVERSATION_TITLE } from "../constants";
import type { ConversationFolderSummary, ConversationSummary } from "../types";
import { WorkspaceController } from "./workspace-controller";
import { openInlineActionMenu, type InlineActionMenuHandle, type InlineActionMenuItem } from "./inline-action-menu";
import { showDesktopMenuAtAnchor } from "./desktop-menu";
import {
  openMoveConversationModal,
  openRenameConversationModal,
  openRenameFolderModal
} from "./workspace-menu-modals";

function confirmDeleteConversation(summary: ConversationSummary): boolean {
  const title = summary.title || UNTITLED_CONVERSATION_TITLE;
  return window.confirm(`确认删除对话“${title}”吗？`);
}

function confirmDeleteFolder(folder: ConversationFolderSummary): boolean {
  return window.confirm(`删除文件夹“${folder.name}”吗？其中的对话会移回主列表。`);
}

export function openConversationRowMenu(
  controller: WorkspaceController,
  summary: ConversationSummary,
  event?: MouseEvent,
  anchorEl?: HTMLElement,
  onClose?: () => void
): InlineActionMenuHandle {
  if (Platform.isMobile || Platform.isPhone) {
    const resolvedAnchorEl =
      anchorEl
      ?? (event?.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : (event?.target as HTMLElement | null))
      ?? null;
    if (!resolvedAnchorEl) {
      throw new Error("Sidet conversation row menu requires an anchor element on mobile.");
    }
    return openInlineActionMenu({
      anchorEl: resolvedAnchorEl,
      items: buildConversationRowItems(controller, summary),
      verticalDirection: "down",
      onClose
    });
  }
  if (!event && !anchorEl) {
    throw new Error("Sidet conversation row menu requires a mouse event or anchor element on desktop.");
  }
  const resolvedAnchorEl =
    anchorEl
    ?? (event?.currentTarget instanceof HTMLElement ? event.currentTarget : (event?.target as HTMLElement | null))
    ?? null;
  if (!resolvedAnchorEl) {
    throw new Error("Sidet conversation row menu requires an anchor element on desktop.");
  }

  const menu = new Menu();
  for (const menuItem of buildConversationRowItems(controller, summary)) {
    menu.addItem((item) => {
      item
        .setTitle(menuItem.title)
        .setDisabled(Boolean(menuItem.disabled))
        .onClick(menuItem.onSelect);
      if (menuItem.icon) {
        item.setIcon(menuItem.icon);
      }
      if (menuItem.danger) {
        item.setWarning(true);
      }
    });
  }

  return showDesktopMenu(menu, resolvedAnchorEl, onClose);
}

export function openFolderRowMenu(
  controller: WorkspaceController,
  folder: ConversationFolderSummary,
  event?: MouseEvent,
  anchorEl?: HTMLElement,
  onClose?: () => void
): InlineActionMenuHandle {
  const items = buildFolderRowItems(controller, folder);
  if (Platform.isMobile || Platform.isPhone) {
    const resolvedAnchorEl =
      anchorEl
      ?? (event?.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : (event?.target as HTMLElement | null))
      ?? null;
    if (!resolvedAnchorEl) {
      throw new Error("Sidet folder row menu requires an anchor element on mobile.");
    }
    return openInlineActionMenu({
      anchorEl: resolvedAnchorEl,
      items,
      verticalDirection: "down",
      onClose
    });
  }
  if (!event && !anchorEl) {
    throw new Error("Sidet folder row menu requires a mouse event or anchor element on desktop.");
  }
  const resolvedAnchorEl =
    anchorEl
    ?? (event?.currentTarget instanceof HTMLElement ? event.currentTarget : (event?.target as HTMLElement | null))
    ?? null;
  if (!resolvedAnchorEl) {
    throw new Error("Sidet folder row menu requires an anchor element on desktop.");
  }

  const menu = new Menu();
  for (const menuItem of items) {
    menu.addItem((item) => {
      item
        .setTitle(menuItem.title)
        .setDisabled(Boolean(menuItem.disabled))
        .onClick(menuItem.onSelect);
      if (menuItem.icon) {
        item.setIcon(menuItem.icon);
      }
      if (menuItem.danger) {
        item.setWarning(true);
      }
    });
  }

  return showDesktopMenu(menu, resolvedAnchorEl, onClose);
}

function showDesktopMenu(menu: Menu, anchorEl: HTMLElement, onClose?: () => void): InlineActionMenuHandle {
  return showDesktopMenuAtAnchor({
    menu,
    anchorEl,
    onClose
  });
}

function buildConversationRowItems(
  controller: WorkspaceController,
  summary: ConversationSummary
): InlineActionMenuItem[] {
  const folderTargets = controller.store.getFolderSummaries().filter((folder) => folder.id !== summary.folderId);
  const items: InlineActionMenuItem[] = [
    {
      title: summary.isPinned ? "取消置顶" : "置顶",
      icon: summary.isPinned ? "pin-off" : "pin",
      onSelect: () => {
        void controller.toggleConversationPinned(summary.id);
      }
    },
    {
      title: "重命名",
      icon: "pencil",
      onSelect: () => {
        openRenameConversationModal(controller, summary);
      }
    }
  ];

  if (summary.folderId) {
    items.push({
      title: "移回主列表",
      icon: "folder-output",
      onSelect: () => {
        void controller.moveConversationToFolder(summary.id, null);
      }
    });
  }

  if (folderTargets.length > 0) {
    items.push({
      title: "移动到文件夹",
      icon: "folder",
      onSelect: () => {
        openMoveConversationModal(controller, summary);
      }
    });
  }

  items.push(
    {
      title: "归档",
      icon: "archive",
      onSelect: () => {
        void controller.archiveConversation(summary.id);
      }
    },
    {
      title: "导出当前对话",
      icon: "download",
      onSelect: () => {
        void controller.exportConversationById(summary.id);
      }
    },
    {
      title: "删除",
      icon: "trash-2",
      danger: true,
      onSelect: () => {
        if (!confirmDeleteConversation(summary)) {
          return;
        }
        void controller.deleteConversation(summary.id);
      }
    }
  );

  return items;
}

function buildFolderRowItems(
  controller: WorkspaceController,
  folder: ConversationFolderSummary
): InlineActionMenuItem[] {
  return [
    {
      title: "重命名",
      icon: "pencil",
      onSelect: () => {
        openRenameFolderModal(controller, folder);
      }
    },
    {
      title: "删除文件夹",
      icon: "trash-2",
      danger: true,
      onSelect: () => {
        if (!confirmDeleteFolder(folder)) {
          return;
        }
        void controller.deleteFolder(folder.id);
      }
    }
  ];
}
