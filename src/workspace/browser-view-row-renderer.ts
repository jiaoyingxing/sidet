import { setIcon } from "obsidian";
import { PLUGIN_NAME, UNTITLED_CONVERSATION_TITLE } from "../constants";
import type {
  ConversationMessageSearchHit,
  ConversationMessageSearchRange
} from "../conversations/conversation-search";
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

  renderConversationRow(
    summary: ConversationSummary,
    activeConversationId: string | null,
    folderName?: string | null
  ): void {
    const openConversation = () => {
      void this.options.controller.openConversationInLeaf(summary.id, {
        forceActiveOnMobile: true
      });
    };
    const isActive = summary.id === activeConversationId;
    const title = summary.title || UNTITLED_CONVERSATION_TITLE;
    const { item, navTarget } = this.touchRuntime.createNavigationRow({
      title,
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
    if (folderName) {
      this.renderRowDetail(navTarget, title, { metaText: `文件夹 · ${folderName}` });
    }
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

  renderMessageHitRow(hit: ConversationMessageSearchHit, activeConversationId: string | null): void {
    const title = hit.conversationTitle || UNTITLED_CONVERSATION_TITLE;
    const { item, navTarget } = this.touchRuntime.createNavigationRow({
      title,
      active: hit.conversationId === activeConversationId,
      onOpen: () => {
        void this.options.controller.openConversationInLeaf(hit.conversationId, {
          forceActiveOnMobile: true,
          messageId: hit.messageId
        });
      }
    });
    item.addClass("sidet-browser-message-hit-row");
    this.renderRowDetail(navTarget, title, {
      metaText: [
        hit.role === "user" ? "你" : PLUGIN_NAME,
        hit.folderName
      ].filter((part): part is string => Boolean(part)).join(" · "),
      snippet: hit.snippet,
      matchRanges: hit.matchRanges
    });
  }

  private renderRowDetail(
    navTarget: HTMLElement,
    title: string,
    detail: {
      metaText?: string;
      snippet?: string;
      matchRanges?: readonly ConversationMessageSearchRange[];
    }
  ): void {
    if (!detail.metaText && !detail.snippet) {
      return;
    }
    const titleEl = navTarget.querySelector(".sidet-browser-row-title");
    if (!(titleEl instanceof HTMLElement)) {
      return;
    }
    titleEl.empty();
    titleEl.addClass("has-detail");
    titleEl.createDiv({ cls: "sidet-browser-row-title-text", text: title });
    if (detail.metaText) {
      titleEl.createDiv({ cls: "sidet-browser-row-meta", text: detail.metaText });
    }
    if (detail.snippet) {
      const snippetEl = titleEl.createDiv({ cls: "sidet-browser-row-snippet" });
      appendHighlightedText(snippetEl, detail.snippet, detail.matchRanges ?? []);
    }
  }
}

function appendHighlightedText(
  parentEl: HTMLElement,
  text: string,
  ranges: readonly ConversationMessageSearchRange[]
): void {
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) {
      parentEl.appendText(text.slice(cursor, start));
    }
    if (end > start) {
      parentEl.createEl("mark", {
        cls: "sidet-search-hit-mark",
        text: text.slice(start, end)
      });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    parentEl.appendText(text.slice(cursor));
  }
}
