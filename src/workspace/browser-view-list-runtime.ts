import { PLUGIN_NAME, UNTITLED_CONVERSATION_TITLE } from "../constants";
import type { ConversationFolderSummary, ConversationSummary } from "../types";
import type { WorkspaceController } from "./workspace-controller";

export interface BrowserViewVisibleEntries {
  folders: ConversationFolderSummary[];
  summaries: ConversationSummary[];
}

interface BrowserViewToolbarElements {
  toolbarEl: HTMLDivElement | null;
  titleEl: HTMLDivElement | null;
  backButtonEl: HTMLButtonElement | null;
  createFolderButtonEl: HTMLButtonElement | null;
  newConversationButtonEl: HTMLButtonElement | null;
  searchInputEl: HTMLInputElement | null;
}

interface BrowserViewState extends Record<string, unknown> {
  folderId?: string | null;
}

export class BrowserViewListRuntime {
  private currentFolderId: string | null = null;
  private searchQuery = "";
  private pendingSearchBlurTimer: number | null = null;
  private lastRenderedListSignature = "";
  private lastRenderedActiveConversationId: string | null = null;

  constructor(private readonly controller: WorkspaceController) {}

  release(): void {
    if (this.pendingSearchBlurTimer !== null) {
      window.clearTimeout(this.pendingSearchBlurTimer);
      this.pendingSearchBlurTimer = null;
    }
    this.lastRenderedListSignature = "";
    this.lastRenderedActiveConversationId = null;
  }

  getState(): BrowserViewState {
    return {
      folderId: this.currentFolderId
    };
  }

  restoreState(state: unknown): void {
    this.currentFolderId = this.normalizeFolderState(state);
  }

  syncSearchInput(inputEl: HTMLInputElement | null): void {
    if (!inputEl) {
      return;
    }
    inputEl.value = this.searchQuery;
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
  }

  getCurrentFolderId(): string | null {
    return this.currentFolderId;
  }

  isSearchOpen(searchWrapEl: HTMLDivElement | null): boolean {
    return !searchWrapEl?.classList.contains("is-hidden");
  }

  getTrimmedSearchQuery(): string {
    return this.searchQuery.trim();
  }

  toggleSearch(
    searchWrapEl: HTMLDivElement | null,
    searchInputEl: HTMLInputElement | null,
    onVisibilityChange: () => void
  ): void {
    if (!searchWrapEl || !searchInputEl) {
      return;
    }
    if (this.pendingSearchBlurTimer !== null) {
      window.clearTimeout(this.pendingSearchBlurTimer);
      this.pendingSearchBlurTimer = null;
    }
    const willOpen = searchWrapEl.classList.contains("is-hidden");
    if (willOpen) {
      searchWrapEl.classList.remove("is-hidden");
      onVisibilityChange();
      window.setTimeout(() => {
        searchInputEl.focus();
        const length = searchInputEl.value.length;
        searchInputEl.setSelectionRange(length, length);
      }, 0);
      return;
    }
    this.resetSearch(searchWrapEl, searchInputEl);
    onVisibilityChange();
  }

  hideSearch(
    searchWrapEl: HTMLDivElement | null,
    searchInputEl: HTMLInputElement | null,
    onVisibilityChange: () => void
  ): void {
    if (!searchWrapEl || !searchInputEl || searchWrapEl.classList.contains("is-hidden")) {
      return;
    }
    this.resetSearch(searchWrapEl, searchInputEl);
    onVisibilityChange();
  }

  scheduleHideSearch(
    searchWrapEl: HTMLDivElement | null,
    searchInputEl: HTMLInputElement | null,
    onVisibilityChange: () => void
  ): void {
    if (this.pendingSearchBlurTimer !== null) {
      window.clearTimeout(this.pendingSearchBlurTimer);
    }
    this.pendingSearchBlurTimer = window.setTimeout(() => {
      this.pendingSearchBlurTimer = null;
      this.hideSearch(searchWrapEl, searchInputEl, onVisibilityChange);
    }, 0);
  }

  openFolder(folderId: string, searchWrapEl: HTMLDivElement | null, searchInputEl: HTMLInputElement | null): void {
    this.currentFolderId = folderId;
    this.resetSearch(searchWrapEl, searchInputEl);
  }

  openRoot(searchWrapEl: HTMLDivElement | null, searchInputEl: HTMLInputElement | null): boolean {
    if (this.currentFolderId === null) {
      return false;
    }
    this.currentFolderId = null;
    this.resetSearch(searchWrapEl, searchInputEl);
    return true;
  }

  syncFolderState(searchWrapEl: HTMLDivElement | null, searchInputEl: HTMLInputElement | null): void {
    if (!this.controller.isConversationStoreReady()) {
      return;
    }
    if (this.currentFolderId && !this.controller.store.getFolder(this.currentFolderId)) {
      this.currentFolderId = null;
      this.resetSearch(searchWrapEl, searchInputEl);
    }
  }

  syncToolbarState(elements: BrowserViewToolbarElements): void {
    const folder = this.currentFolderId ? this.controller.store.getFolder(this.currentFolderId) : null;
    const isFolderOpen = Boolean(folder);
    elements.toolbarEl?.toggleClass("is-folder-open", isFolderOpen);
    elements.titleEl?.setText(folder?.name ?? PLUGIN_NAME);
    elements.backButtonEl?.toggleClass("is-hidden", !isFolderOpen);
    elements.createFolderButtonEl?.toggleClass("is-hidden", isFolderOpen);
    elements.newConversationButtonEl?.toggleClass("is-hidden", isFolderOpen);
    if (elements.searchInputEl) {
      elements.searchInputEl.placeholder = isFolderOpen ? "搜索文件夹内对话" : "搜索对话标题";
    }
  }

  getVisibleEntries(): BrowserViewVisibleEntries {
    const folders = this.currentFolderId
      ? []
      : this.controller.store
        .getFolderSummaries()
        .filter((folder) => this.matchesSearch(folder.name));
    const summaries = this.controller.store
      .getSummariesInFolder(this.currentFolderId)
      .filter((summary) => summary.messageCount > 0)
      .filter((summary) => this.matchesSearch(summary.title || UNTITLED_CONVERSATION_TITLE));

    return { folders, summaries };
  }

  buildEmptyText(isSearching: boolean): string {
    if (isSearching) {
      return this.currentFolderId ? "没有匹配的对话标题。" : "没有匹配的对话或文件夹。";
    }
    return this.currentFolderId ? "这个文件夹里还没有对话。" : `${PLUGIN_NAME} 还没有任何已发送的对话。`;
  }

  markSearchOpenEmptyRendered(): void {
    this.lastRenderedListSignature = this.getSearchOpenEmptySignature();
    this.lastRenderedActiveConversationId = null;
  }

  isSearchOpenEmptyRendered(): boolean {
    return this.lastRenderedListSignature === this.getSearchOpenEmptySignature();
  }

  markLoadingRendered(): void {
    this.lastRenderedListSignature = `__loading__:${this.currentFolderId ?? "root"}`;
    this.lastRenderedActiveConversationId = null;
  }

  markRendered(entries: BrowserViewVisibleEntries, activeConversationId: string | null): void {
    this.lastRenderedListSignature = this.buildListSignature(entries);
    this.lastRenderedActiveConversationId = activeConversationId;
  }

  tryPatchRenderedActiveConversation(
    entries: BrowserViewVisibleEntries,
    activeConversationId: string | null,
    rowElements: Map<string, { item: HTMLDivElement; navTarget: HTMLDivElement }>
  ): boolean {
    const nextSignature = this.buildListSignature(entries);
    if (nextSignature !== this.lastRenderedListSignature) {
      return false;
    }
    if (activeConversationId === this.lastRenderedActiveConversationId) {
      return true;
    }
    this.applyRowActiveState(rowElements, this.lastRenderedActiveConversationId, false);
    this.applyRowActiveState(rowElements, activeConversationId, true);
    this.lastRenderedActiveConversationId = activeConversationId;
    return true;
  }

  private normalizeFolderState(state: unknown): string | null {
    if (!state || typeof state !== "object") {
      return null;
    }
    const folderId = (state as BrowserViewState).folderId;
    return typeof folderId === "string" && folderId.trim().length > 0 ? folderId : null;
  }

  private resetSearch(searchWrapEl: HTMLDivElement | null, searchInputEl: HTMLInputElement | null): void {
    if (!searchWrapEl || !searchInputEl) {
      return;
    }
    searchWrapEl.classList.add("is-hidden");
    this.searchQuery = "";
    searchInputEl.value = "";
  }

  private matchesSearch(title: string): boolean {
    const query = this.searchQuery.trim().toLocaleLowerCase();
    if (!query) {
      return true;
    }
    return title.toLocaleLowerCase().includes(query);
  }

  private buildListSignature(entries: BrowserViewVisibleEntries): string {
    const folderParts = entries.folders.map((folder) => [
      "folder",
      folder.id,
      folder.name,
      folder.conversationCount
    ].join(":"));
    const summaryParts = entries.summaries.map((summary) => [
      "conversation",
      summary.id,
      summary.title,
      summary.folderId ?? "",
      summary.isPinned ? "1" : "0"
    ].join(":"));
    return [
      this.currentFolderId ?? "root",
      ...folderParts,
      ...summaryParts
    ].join("|");
  }

  private getSearchOpenEmptySignature(): string {
    return `__search-open-empty__:${this.currentFolderId ?? "root"}`;
  }

  private applyRowActiveState(
    rowElements: Map<string, { item: HTMLDivElement; navTarget: HTMLDivElement }>,
    conversationId: string | null,
    active: boolean
  ): void {
    if (!conversationId) {
      return;
    }
    const row = rowElements.get(conversationId);
    if (!row) {
      return;
    }
    row.item.toggleClass("is-active", active);
    row.navTarget.toggleClass("is-active", active);
    row.navTarget.setAttr("aria-selected", active ? "true" : "false");
    if (active) {
      row.navTarget.setAttr("aria-current", "page");
      return;
    }
    row.navTarget.removeAttribute("aria-current");
  }
}
