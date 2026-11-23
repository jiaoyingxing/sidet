import { setIcon } from "obsidian";
import { UNTITLED_CONVERSATION_TITLE } from "../constants";
import type { ConversationFolderSummary, ConversationSummary } from "../types";
import { createIconButton } from "./icon-button";
import type { InlineActionMenuHandle } from "./inline-action-menu";
import type { WorkspaceController } from "./workspace-controller";
import { openConversationRowMenu, openFolderRowMenu } from "./workspace-menus";
import { BrowserViewTouchRuntime } from "./browser-view-touch-runtime";

interface BrowserViewRowRendererOptions {
  controller: WorkspaceController;
  getListEl: () => HTMLDivElement | null;
  isMobileRuntime: () => boolean;
  openInlineMenu: (handle?: InlineActionMenuHandle) => void;
  registerConversationRow: (
    conversationId: string,
    row: { item: HTMLDivElement; navTarget: HTMLDivElement }
  ) => void;
}

export class BrowserViewRowRenderer {
  private readonly touchRuntime: BrowserViewTouchRuntime;

  constructor(private readonly options: BrowserViewRowRendererOptions) {
    this.touchRuntime = new BrowserViewTouchRuntime({
      getListEl: this.options.getListEl,
      isMobileRuntime: this.options.isMobileRuntime
    });
  }

  release(): void {
    this.touchRuntime.reset();
  }

  renderFolderRow(folder: ConversationFolderSummary, onOpenFolder: (folderId: string) => void): void {
    const { item } = this.touchRuntime.createNavigationRow({
      title: folder.name,
      active: false,
      icon: "folder",
      onOpen: () => {
        onOpenFolder(folder.id);
      },
      onOpenMenu: (anchorEl) => {
        this.options.openInlineMenu(
          openFolderRowMenu(this.options.controller, folder, undefined, anchorEl, () => {
            this.options.openInlineMenu();
          })
        );
      }
    });
    item.addClass("sidet-browser-folder-row");

    const actions = item.createDiv({ cls: "sidet-browser-row-actions" });
    this.touchRuntime.attachActionsEngagement(item, actions);
    createIconButton(actions, {
      icon: "more-horizontal",
      label: `${folder.name} 更多操作`,
      className: "sidet-browser-row-more-button",
      preserveFocus: false,
      onClick: (event) => {
        event.stopPropagation();
        const buttonEl = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
        if (!buttonEl) {
          return;
        }
        this.options.openInlineMenu(
          openFolderRowMenu(this.options.controller, folder, undefined, buttonEl, () => {
            this.options.openInlineMenu();
          })
        );
      }
    });
  }

  renderConversationRow(summary: ConversationSummary, activeConversationId: string | null): void {
    const openConversation = () => {
      void this.options.controller.openConversationInLeaf(summary.id, {
        forceActiveOnMobile: true
      });
    };
    const isActive = summary.id === activeConversationId;
    const { item, navTarget } = this.touchRuntime.createNavigationRow({
      title: summary.title || UNTITLED_CONVERSATION_TITLE,
      active: isActive,
      onOpen: openConversation,
      onOpenMenu: (anchorEl) => {
        this.options.openInlineMenu(
          openConversationRowMenu(this.options.controller, summary, undefined, anchorEl, () => {
            this.options.openInlineMenu();
          })
        );
      }
    });
    this.options.registerConversationRow(summary.id, { item, navTarget });

    const actions = item.createDiv({ cls: "sidet-browser-row-actions" });
    this.touchRuntime.attachActionsEngagement(item, actions);
    if (summary.isPinned) {
      const pin = actions.createSpan({ cls: "sidet-browser-row-pin" });
      pin.setAttr("aria-hidden", "true");
      setIcon(pin, "pin");
    }
    createIconButton(actions, {
      icon: "more-horizontal",
      label: `${summary.title || UNTITLED_CONVERSATION_TITLE} 更多操作`,
      className: "sidet-browser-row-more-button",
      preserveFocus: false,
      onClick: (event) => {
        event.stopPropagation();
        const buttonEl = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
        if (!buttonEl) {
          return;
        }
        this.options.openInlineMenu(
          openConversationRowMenu(this.options.controller, summary, undefined, buttonEl, () => {
            this.options.openInlineMenu();
          })
        );
      }
    });
  }
}
