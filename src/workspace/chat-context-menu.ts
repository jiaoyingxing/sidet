import { Menu, Platform, TFile, WorkspaceLeaf } from "obsidian";
import { openInlineActionMenu, type InlineActionMenuHandle, type InlineActionMenuItem } from "./inline-action-menu";
import { showDesktopMenuAtAnchor } from "./desktop-menu";
import { MarkdownContextPickerModal } from "./markdown-context-picker-modal";
import { WebpageUrlModal } from "./webpage-url-modal";
import type { WorkspaceController } from "./workspace-controller";

interface OpenChatContextMenuOptions {
  anchorEl: HTMLElement;
  controller: WorkspaceController;
  leaf: WorkspaceLeaf;
  onAddMarkdownAttachment: (file: TFile) => void;
  onAddWebpageAttachment: (url: string) => void;
  onPickImageAttachment: () => void;
  onHoldAttachmentPicker: () => void;
  onCancelAttachmentPicker: () => void;
  onClose: () => void;
}

interface OpenWebpageAttachmentModalOptions {
  controller: WorkspaceController;
  onAddWebpageAttachment: (url: string) => void;
  onHoldAttachmentPicker: () => void;
  onCancelAttachmentPicker: () => void;
}

export function openWebpageAttachmentModal(options: OpenWebpageAttachmentModalOptions): void {
  options.onHoldAttachmentPicker();
  new WebpageUrlModal(
    options.controller.getApp(),
    async (url) => {
      options.onAddWebpageAttachment(url);
    },
    options.onCancelAttachmentPicker
  ).open();
}

export function openChatContextMenu(options: OpenChatContextMenuOptions): InlineActionMenuHandle {
  const {
    anchorEl,
    controller,
    leaf,
    onAddMarkdownAttachment,
    onAddWebpageAttachment,
    onPickImageAttachment,
    onHoldAttachmentPicker,
    onCancelAttachmentPicker,
    onClose
  } = options;
  const supportsImageInput = controller.currentModelSupportsImageInput(leaf);
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

  const openMenu = (items: InlineActionMenuItem[]): void => {
    activeMenu = openInlineActionMenu({
      anchorEl,
      items,
      onClose: handleMenuClose
    });
  };

  const openDesktopItems = (items: InlineActionMenuItem[]): void => {
    activeMenu = showDesktopMenu(items, anchorEl, handleMenuClose);
  };

  const primaryItems: InlineActionMenuItem[] = [
    {
      title: "引用 Markdown 笔记",
      icon: "file-text",
      onSelect: () => {
        onHoldAttachmentPicker();
        const modal = new MarkdownContextPickerModal(
          controller.getApp(),
          (file) => {
            onAddMarkdownAttachment(file);
          },
          onCancelAttachmentPicker
        );
        modal.open();
      }
    },
    {
      title: "引用网页",
      icon: "link",
      onSelect: () => {
        openWebpageAttachmentModal({
          controller,
          onAddWebpageAttachment,
          onHoldAttachmentPicker,
          onCancelAttachmentPicker
        });
      }
    },
    {
      title: supportsImageInput ? "选择图片" : "选择图片（当前模型不可用）",
      icon: "image",
      disabled: !supportsImageInput,
      closeBeforeSelect: false,
      onSelect: onPickImageAttachment
    },
  ];

  if (Platform.isMobile || Platform.isPhone) {
    openMenu(primaryItems);
  } else {
    openDesktopItems(primaryItems);
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

function showDesktopMenu(
  items: InlineActionMenuItem[],
  anchorEl: HTMLElement,
  onClose: () => void
): InlineActionMenuHandle {
  const menu = new Menu();
  let hasAddedItem = false;
  for (const item of items) {
    if (item.sectionStart && hasAddedItem) {
      menu.addSeparator();
    }
    menu.addItem((menuItem) => {
      menuItem
        .setTitle(item.title)
        .setDisabled(Boolean(item.disabled))
        .onClick(item.onSelect);
      if (item.icon) {
        menuItem.setIcon(item.icon);
      }
    });
    hasAddedItem = true;
  }

  return showDesktopMenuAtAnchor({
    menu,
    anchorEl,
    onClose,
    placement: "above-anchor"
  });
}
