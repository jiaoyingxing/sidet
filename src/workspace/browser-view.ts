import { ItemView, Platform, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import { BROWSER_VIEW_TYPE, PLUGIN_NAME } from "../constants";
import { createIconButton } from "./icon-button";
import type { InlineActionMenuHandle } from "./inline-action-menu";
import { WorkspaceController } from "./workspace-controller";
import { BrowserViewListRuntime, type BrowserViewVisibleEntries } from "./browser-view-list-runtime";
import { openCreateFolderModal } from "./workspace-menu-modals";
import { BrowserViewRowRenderer } from "./browser-view-row-renderer";

interface BrowserViewState extends Record<string, unknown> {
  folderId?: string | null;
}

export class BrowserView extends ItemView {
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeWorkspace: (() => void) | null = null;
  private rootEl: HTMLDivElement | null = null;
  private toolbarEl: HTMLDivElement | null = null;
  private titleEl: HTMLDivElement | null = null;
  private backButtonEl: HTMLButtonElement | null = null;
  private createFolderButtonEl: HTMLButtonElement | null = null;
  private newConversationButtonEl: HTMLButtonElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private rowElements = new Map<string, { item: HTMLDivElement; navTarget: HTMLDivElement }>();
  private searchWrapEl: HTMLDivElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private activeInlineMenu: InlineActionMenuHandle | null = null;
  private readonly listRuntime = new BrowserViewListRuntime(this.controller);
  private readonly rowRenderer = new BrowserViewRowRenderer({
    controller: this.controller,
    getListEl: () => this.listEl,
    isMobileRuntime: () => this.isMobileRuntime(),
    openInlineMenu: (handle) => this.openInlineMenu(handle),
    registerConversationRow: (conversationId, row) => {
      this.rowElements.set(conversationId, row);
    }
  });

  constructor(leaf: WorkspaceLeaf, private readonly controller: WorkspaceController) {
    super(leaf);
  }

  override getViewType(): string {
    return BROWSER_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return `${PLUGIN_NAME} 浏览`;
  }

  override getIcon(): string {
    return "menu";
  }

  override async onOpen(): Promise<void> {
    this.ensureViewReady();
    this.renderList();
  }

  override getState(): BrowserViewState {
    return this.listRuntime.getState();
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    result.history = false;
    this.listRuntime.restoreState(state);
    this.ensureViewReady();
    this.renderList();
  }

  override async onClose(): Promise<void> {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribeWorkspace?.();
    this.unsubscribeWorkspace = null;
    this.activeInlineMenu?.close();
    this.activeInlineMenu = null;
    this.rowElements.clear();
    this.rowRenderer.release();
    this.listRuntime.release();
    this.rootEl = null;
    this.toolbarEl = null;
    this.titleEl = null;
    this.backButtonEl = null;
    this.createFolderButtonEl = null;
    this.newConversationButtonEl = null;
    this.listEl = null;
    this.searchWrapEl = null;
    this.searchInputEl = null;
  }

  private ensureViewReady(): void {
    if (this.rootEl && this.listEl) {
      return;
    }

    this.contentEl.empty();
    this.contentEl.addClass("sidet-browser-view");
    this.contentEl.toggleClass("is-mobile-runtime", this.isMobileRuntime());

    this.rootEl = this.contentEl.createDiv({ cls: "sidet-browser-root" });
    this.toolbarEl = this.rootEl.createDiv({ cls: "sidet-browser-toolbar" });
    this.backButtonEl = createIconButton(this.toolbarEl, {
      icon: "arrow-left",
      label: "返回对话列表",
      className: "sidet-browser-back-button is-hidden",
      preserveFocus: false,
      onClick: () => {
        this.openRoot();
      }
    });
    this.titleEl = this.toolbarEl.createDiv({ cls: "sidet-browser-title", text: PLUGIN_NAME });

    const toolbarActions = this.toolbarEl.createDiv({ cls: "sidet-browser-toolbar-actions" });
    createIconButton(toolbarActions, {
      icon: "search",
      label: "搜索对话标题",
      preserveFocus: false,
      onClick: () => {
        this.toggleSearch();
      }
    });
    this.createFolderButtonEl = createIconButton(toolbarActions, {
      icon: "folder-plus",
      label: "新建文件夹",
      className: "sidet-browser-create-folder-button",
      preserveFocus: false,
      onClick: () => {
        openCreateFolderModal(this.controller);
      }
    });
    this.newConversationButtonEl = createIconButton(toolbarActions, {
      icon: "plus",
      label: "新建对话",
      className: "sidet-browser-new-chat-button",
      preserveFocus: false,
      onClick: () => {
        void this.controller.openNewChatTab();
      }
    });

    this.searchWrapEl = this.rootEl.createDiv({ cls: "sidet-browser-search-wrap is-hidden" });
    this.searchInputEl = this.searchWrapEl.createEl("input", {
      cls: "sidet-browser-search-input",
      type: "search"
    });
    this.listRuntime.syncSearchInput(this.searchInputEl);
    this.searchInputEl.addEventListener("input", () => {
      this.listRuntime.setSearchQuery(this.searchInputEl?.value ?? "");
      this.renderList();
    });
    this.searchInputEl.addEventListener("blur", () => {
      this.listRuntime.scheduleHideSearch(this.searchWrapEl, this.searchInputEl, () => this.renderList());
    });
    this.searchInputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      this.listRuntime.hideSearch(this.searchWrapEl, this.searchInputEl, () => this.renderList());
    });

    this.listEl = this.rootEl.createDiv({ cls: "sidet-browser-list nav-files-container" });
    this.listEl.setAttr("role", "tree");
    this.listEl.setAttr("aria-label", `${PLUGIN_NAME} 对话列表`);
    this.unsubscribeStore?.();
    this.unsubscribeStore = this.controller.store.subscribe(() => this.handleListStateChange());
    this.unsubscribeWorkspace?.();
    this.unsubscribeWorkspace = this.controller.subscribeWorkspaceState(() => this.handleListStateChange());
    this.syncToolbarState();
  }

  private renderList(): void {
    if (!this.listEl) {
      return;
    }

    this.syncToolbarState();
    if (!this.controller.isConversationStoreReady()) {
      this.renderLoadingState();
      return;
    }

    this.listRuntime.syncFolderState(this.searchWrapEl, this.searchInputEl);
    this.listEl.empty();
    this.rowElements.clear();
    const isSearchOpen = this.listRuntime.isSearchOpen(this.searchWrapEl);
    const trimmedQuery = this.listRuntime.getTrimmedSearchQuery();
    const isSearching = isSearchOpen && trimmedQuery.length > 0;

    if (isSearchOpen && trimmedQuery.length === 0) {
      this.listRuntime.markSearchOpenEmptyRendered();
      return;
    }

    const entries = this.getVisibleEntries();
    const activeConversationId = this.controller.getActiveConversationId();
    this.listRuntime.markRendered(entries, activeConversationId);

    if (entries.folders.length === 0 && entries.summaries.length === 0) {
      const emptyText = this.buildEmptyText(isSearching);
      this.listEl.createDiv({
        cls: "sidet-empty",
        text: emptyText
      });
      return;
    }

    for (const folder of entries.folders) {
      this.rowRenderer.renderFolderRow(folder, (folderId) => this.openFolder(folderId));
    }
    for (const summary of entries.summaries) {
      this.rowRenderer.renderConversationRow(summary, activeConversationId);
    }
  }

  private renderLoadingState(): void {
    if (!this.listEl) {
      return;
    }

    this.listEl.empty();
    this.rowElements.clear();
    this.listRuntime.markLoadingRendered();
    this.listEl.createDiv({
      cls: "sidet-empty",
      text: this.listRuntime.getCurrentFolderId() ? "正在恢复文件夹内容…" : "正在恢复对话列表…"
    });
  }

  private isMobileRuntime(): boolean {
    return Platform.isMobile || Platform.isPhone;
  }

  private handleListStateChange(): void {
    if (!this.controller.isConversationStoreReady()) {
      this.syncToolbarState();
      this.renderLoadingState();
      return;
    }

    this.listRuntime.syncFolderState(this.searchWrapEl, this.searchInputEl);
    this.syncToolbarState();
    const isSearchOpen = this.listRuntime.isSearchOpen(this.searchWrapEl);
    if (isSearchOpen && this.listRuntime.getTrimmedSearchQuery().length === 0) {
      if (this.listRuntime.isSearchOpenEmptyRendered()) {
        return;
      }
      this.renderList();
      return;
    }

    const entries = this.getVisibleEntries();
    const activeConversationId = this.controller.getActiveConversationId();
    if (this.listRuntime.tryPatchRenderedActiveConversation(entries, activeConversationId, this.rowElements)) {
      return;
    }
    this.renderList();
  }

  private openFolder(folderId: string): void {
    this.listRuntime.openFolder(folderId, this.searchWrapEl, this.searchInputEl);
    this.activeInlineMenu?.close();
    this.activeInlineMenu = null;
    this.renderList();
  }

  private openRoot(): void {
    if (!this.listRuntime.openRoot(this.searchWrapEl, this.searchInputEl)) {
      return;
    }
    this.activeInlineMenu?.close();
    this.activeInlineMenu = null;
    this.renderList();
  }

  private toggleSearch(): void {
    this.listRuntime.toggleSearch(this.searchWrapEl, this.searchInputEl, () => this.renderList());
  }

  private syncToolbarState(): void {
    this.listRuntime.syncToolbarState({
      toolbarEl: this.toolbarEl,
      titleEl: this.titleEl,
      backButtonEl: this.backButtonEl,
      createFolderButtonEl: this.createFolderButtonEl,
      newConversationButtonEl: this.newConversationButtonEl,
      searchInputEl: this.searchInputEl
    });
  }

  private getVisibleEntries(): BrowserViewVisibleEntries {
    return this.listRuntime.getVisibleEntries();
  }

  private buildEmptyText(isSearching: boolean): string {
    return this.listRuntime.buildEmptyText(isSearching);
  }

  private openInlineMenu(handle: InlineActionMenuHandle | void): void {
    this.activeInlineMenu?.close();
    if (!handle) {
      this.activeInlineMenu = null;
      return;
    }
    this.activeInlineMenu = handle;
  }
}
