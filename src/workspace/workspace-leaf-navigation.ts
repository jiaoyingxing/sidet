import { App, Platform, WorkspaceLeaf, WorkspaceSidedock } from "obsidian";
import { BROWSER_VIEW_TYPE, CHAT_VIEW_TYPE } from "../constants";
import { ConversationStore } from "../conversations/conversation-store";
import type { ChatLeafState } from "../types";
import { ChatLeafRuntime } from "./chat-leaf-runtime";
import {
  createConversationChatLeafState,
  createFreshChatLeafState,
  writeEphemeralChatLeafState
} from "./chat-leaf-state";

export function isLeafInSideDock(leaf: WorkspaceLeaf | null): boolean {
  let current = leaf?.parent ?? null;
  while (current) {
    if (current instanceof WorkspaceSidedock) {
      return true;
    }
    current = current.parent ?? null;
  }
  return false;
}

export class WorkspaceLeafNavigation {
  constructor(
    private readonly app: App,
    private readonly store: ConversationStore,
    private readonly runtime: ChatLeafRuntime,
    private readonly getDefaultModelConfigId: () => string | null
  ) {}

  getActiveConversationId(): string | null {
    const chatLeaf = this.getNavigationChatLeaf();
    if (!chatLeaf) {
      return null;
    }
    return this.runtime.getChatLeafState(chatLeaf).conversationId;
  }

  async openWorkspace(): Promise<void> {
    await this.ensureBrowserViewOpen();
    const chatLeaf = this.getNavigationChatLeaf() ?? await this.openNewChatTab({
      focusComposer: false
    });
    await this.syncExistingChatLeaf(chatLeaf);
    await this.presentChatLeaf(chatLeaf, {
      activate: Platform.isMobile,
      focusComposer: false
    });
  }

  async ensureBrowserViewOpen(): Promise<WorkspaceLeaf> {
    const browserLeaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = browserLeaves.find(isLeafInSideDock) ?? browserLeaves[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
    }
    if (!leaf) {
      throw new Error("无法创建右侧浏览区。");
    }
    if (leaf.getViewState().type !== BROWSER_VIEW_TYPE) {
      await leaf.setViewState({
        ...leaf.getViewState(),
        type: BROWSER_VIEW_TYPE,
        active: false
      });
    }
    await leaf.loadIfDeferred();
    await this.refreshLeafView(leaf, BROWSER_VIEW_TYPE);
    this.dedupeBrowserLeaves(leaf);
    return leaf;
  }

  async openBrowserView(options: { focus?: boolean } = {}): Promise<WorkspaceLeaf> {
    const leaf = await this.ensureBrowserViewOpen();
    await this.app.workspace.revealLeaf(leaf);
    if (options.focus ?? Platform.isMobile) {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }
    return leaf;
  }

  async openNewChatTab(options: { focusComposer?: boolean; reuseHomepage?: boolean } = {}): Promise<WorkspaceLeaf> {
    const homepageLeaf = options.reuseHomepage === false ? null : this.getHomepageLeaf();
    if (homepageLeaf) {
      await this.syncExistingChatLeaf(homepageLeaf);
      await this.presentChatLeaf(homepageLeaf, {
        activate: true,
        focusComposer: options.focusComposer ?? true
      });
      return homepageLeaf;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    if (!leaf) {
      throw new Error("无法创建聊天标签页。");
    }

    await this.mountChatLeaf(leaf, createFreshChatLeafState(this.getModeStateSeed(), this.getDefaultModelConfigId()), {
      activate: true,
      focusComposer: options.focusComposer ?? true
    });
    return leaf;
  }

  async openConversationInLeaf(
    conversationId: string,
    options: {
      focusComposer?: boolean;
      forceActiveOnMobile?: boolean;
      messageId?: string;
    } = {}
  ): Promise<WorkspaceLeaf | null> {
    if (!this.store.hasConversation(conversationId)) {
      return null;
    }

    const conversation = this.store.getConversation(conversationId);
    const conversationModelConfigId = conversation?.modelConfigId ?? this.getDefaultModelConfigId();

    const targetLeaf = this.getNavigationChatLeaf();
    if (!targetLeaf) {
      const createdLeaf = this.app.workspace.getLeaf("tab");
      if (!createdLeaf) {
        throw new Error("无法打开目标对话。");
      }

      await this.mountChatLeaf(createdLeaf, createConversationChatLeafState(
        conversationId,
        this.store.getConversationDraft(conversationId),
        this.getModeStateSeed(),
        conversationModelConfigId
      ), {
        activate: true,
        focusComposer: options.focusComposer ?? false,
        forceFocus: options.forceActiveOnMobile && Platform.isMobile
      });
      if (options.messageId) {
        this.runtime.queueMessageReveal(createdLeaf, {
          conversationId,
          messageId: options.messageId
        });
      }
      return createdLeaf;
    }

    const currentState = this.runtime.getChatLeafState(targetLeaf);
    this.store.setConversationDraft(currentState.conversationId, currentState.draft, {
      immediatePersistence: true
    });
    if (!currentState.conversationId) {
      this.runtime.setHomeDraft(currentState.draft);
    }
    this.runtime.updateChatLeafState(targetLeaf, {
      conversationId,
      draft: currentState.conversationId === conversationId
        ? currentState.draft
        : this.store.getConversationDraft(conversationId),
      modelConfigId: conversationModelConfigId,
      knowledgeBaseIndexPath: currentState.knowledgeBaseIndexPath ?? null,
      webSearchEnabled: currentState.webSearchEnabled === true
    }, {
      immediatePersistence: true
    });
    await this.ensureExistingChatLeafLoaded(targetLeaf);
    await this.presentChatLeaf(targetLeaf, {
      activate: true,
      focusComposer: options.focusComposer ?? false,
      forceFocus: options.forceActiveOnMobile && Platform.isMobile
    });
    if (options.messageId) {
      this.runtime.queueMessageReveal(targetLeaf, {
        conversationId,
        messageId: options.messageId
      });
    }
    return targetLeaf;
  }

  async resolveDraftTargetLeaf(targetLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf> {
    if (targetLeaf && targetLeaf.getViewState().type === CHAT_VIEW_TYPE) {
      return targetLeaf;
    }

    const navigationLeaf = this.getNavigationChatLeaf();
    if (navigationLeaf) {
      return navigationLeaf;
    }

    return this.openNewChatTab({ focusComposer: true });
  }

  async resolveFreshKnowledgeConversationLeaf(targetLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf> {
    if (targetLeaf && targetLeaf.getViewState().type === CHAT_VIEW_TYPE) {
      await this.resetChatLeafToFreshConversation(targetLeaf);
      return targetLeaf;
    }

    const navigationLeaf = this.getNavigationChatLeaf();
    if (navigationLeaf) {
      await this.resetChatLeafToFreshConversation(navigationLeaf);
      return navigationLeaf;
    }

    return this.openNewChatTab({
      focusComposer: true,
      reuseHomepage: false
    });
  }

  getActiveChatLeaf(): WorkspaceLeaf | null {
    const leaf = this.app.workspace.activeLeaf;
    if (leaf?.getViewState().type === CHAT_VIEW_TYPE && !isLeafInSideDock(leaf)) {
      return leaf;
    }
    return null;
  }

  getMostRecentRootLeaf(): WorkspaceLeaf | null {
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
    if (!leaf || isLeafInSideDock(leaf)) {
      return null;
    }
    return leaf;
  }

  getNavigationChatLeaf(): WorkspaceLeaf | null {
    return this.getFocusedChatLeaf() ?? this.getVisibleChatLeaf() ?? this.getChatLeaves()[0] ?? null;
  }

  getHomepageLeaf(): WorkspaceLeaf | null {
    const activeLeaf = this.getActiveChatLeaf();
    if (this.isHomepageLeaf(activeLeaf)) {
      return activeLeaf;
    }

    const mostRecentRootLeaf = this.getMostRecentRootLeaf();
    if (this.isHomepageLeaf(mostRecentRootLeaf)) {
      return mostRecentRootLeaf;
    }

    const lastFocusedChatLeaf = this.runtime.getLastFocusedChatLeaf();
    if (this.isHomepageLeaf(lastFocusedChatLeaf)) {
      return lastFocusedChatLeaf;
    }

    return this.getRootChatLeaves().find((leaf) => this.isHomepageLeaf(leaf)) ?? null;
  }

  getChatLeaves(): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
      .filter((leaf) => !isLeafInSideDock(leaf));
  }

  async refreshLeafView(leaf: WorkspaceLeaf, expectedType: string): Promise<void> {
    const view = leaf.view;
    if (!view || view.getViewType() !== expectedType) {
      return;
    }

    await view.setState(view.getState(), { history: false });
  }

  dedupeBrowserLeaves(preferredLeaf?: WorkspaceLeaf): void {
    const browserLeaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
    const leaf = preferredLeaf ?? browserLeaves.find(isLeafInSideDock) ?? browserLeaves[0] ?? null;
    if (!leaf) {
      return;
    }

    for (const duplicateLeaf of browserLeaves) {
      if (duplicateLeaf === leaf) {
        continue;
      }
      duplicateLeaf.detach();
    }
  }

  async mountChatLeaf(
    leaf: WorkspaceLeaf,
    state: ChatLeafState,
    options: { activate: boolean; focusComposer: boolean; forceFocus?: boolean }
  ): Promise<void> {
    writeEphemeralChatLeafState(leaf, state);
    await leaf.setViewState({
      ...leaf.getViewState(),
      type: CHAT_VIEW_TYPE,
      state,
      active: true
    });
    await leaf.loadIfDeferred();
    this.runtime.hydrateChatLeafState(leaf, state);
    await this.presentChatLeaf(leaf, options);
    await this.runtime.flush();
  }

  async mountFreshChatLeaf(
    leaf: WorkspaceLeaf,
    options: { activate: boolean; focusComposer: boolean; forceFocus?: boolean }
  ): Promise<void> {
    await this.mountChatLeaf(leaf, createFreshChatLeafState(this.getModeStateSeed(), this.getDefaultModelConfigId()), options);
  }

  async syncExistingChatLeaf(leaf: WorkspaceLeaf): Promise<void> {
    if (leaf.getViewState().type !== CHAT_VIEW_TYPE) {
      return;
    }

    await leaf.loadIfDeferred();
    await this.refreshLeafView(leaf, CHAT_VIEW_TYPE);
  }

  async ensureExistingChatLeafLoaded(leaf: WorkspaceLeaf): Promise<void> {
    if (leaf.getViewState().type !== CHAT_VIEW_TYPE) {
      return;
    }

    await leaf.loadIfDeferred();
  }

  async presentChatLeaf(
    leaf: WorkspaceLeaf,
    options: { activate: boolean; focusComposer: boolean; forceFocus?: boolean }
  ): Promise<void> {
    await this.app.workspace.revealLeaf(leaf);
    this.runtime.rememberFocusedChatLeaf(leaf);
    if (options.activate) {
      this.app.workspace.setActiveLeaf(leaf, {
        focus: options.forceFocus ?? Platform.isMobile
      });
    }
    if (options.focusComposer) {
      this.runtime.focusComposer(leaf);
    }
  }

  async resetChatLeafToFreshConversation(leaf: WorkspaceLeaf): Promise<void> {
    const currentState = this.runtime.getChatLeafState(leaf);
    if (currentState.conversationId) {
      this.store.setConversationDraft(currentState.conversationId, currentState.draft, {
        immediatePersistence: true
      });
    } else if (currentState.draft.trim()) {
      this.runtime.setHomeDraft(currentState.draft);
    }

    if (!currentState.conversationId && !currentState.draft.trim()) {
      await this.ensureExistingChatLeafLoaded(leaf);
      await this.presentChatLeaf(leaf, {
        activate: true,
        focusComposer: false
      });
      return;
    }

    this.runtime.updateChatLeafState(leaf, createFreshChatLeafState(currentState, this.getDefaultModelConfigId()), {
      immediatePersistence: true
    });
    await this.ensureExistingChatLeafLoaded(leaf);
    await this.presentChatLeaf(leaf, {
      activate: true,
      focusComposer: false
    });
  }

  private getMostRecentChatLeaf(): WorkspaceLeaf | null {
    const leaf = this.getMostRecentRootLeaf();
    if (leaf?.getViewState().type === CHAT_VIEW_TYPE) {
      return leaf;
    }
    return null;
  }

  private getFocusedChatLeaf(): WorkspaceLeaf | null {
    const activeChatLeaf = this.getActiveChatLeaf();
    if (activeChatLeaf) {
      return activeChatLeaf;
    }
    const mostRecentChatLeaf = this.getMostRecentChatLeaf();
    if (mostRecentChatLeaf) {
      return mostRecentChatLeaf;
    }
    const lastFocusedChatLeaf = this.runtime.getLastFocusedChatLeaf();
    if (lastFocusedChatLeaf && this.getChatLeaves().includes(lastFocusedChatLeaf)) {
      return lastFocusedChatLeaf;
    }
    return null;
  }

  private getVisibleChatLeaf(): WorkspaceLeaf | null {
    for (const leaf of this.getChatLeaves()) {
      if (leaf.getViewState().active) {
        return leaf;
      }
    }
    return null;
  }

  private getRootChatLeaves(): WorkspaceLeaf[] {
    return this.getChatLeaves()
      .filter((leaf) => leaf.getContainer() === this.app.workspace.rootSplit);
  }

  private isHomepageLeaf(leaf: WorkspaceLeaf | null): leaf is WorkspaceLeaf {
    return Boolean(
      leaf &&
      leaf.getViewState().type === CHAT_VIEW_TYPE &&
      leaf.getContainer() === this.app.workspace.rootSplit &&
      this.runtime.getChatLeafState(leaf).conversationId === null
    );
  }

  private getModeStateSeed(): Pick<ChatLeafState, "knowledgeBaseIndexPath" | "webSearchEnabled"> {
    const navigationLeaf = this.getNavigationChatLeaf();
    if (navigationLeaf) {
      const state = this.runtime.getChatLeafState(navigationLeaf);
      return {
        knowledgeBaseIndexPath: state.knowledgeBaseIndexPath ?? null,
        webSearchEnabled: state.webSearchEnabled === true
      };
    }
    return this.runtime.getLastModeState();
  }
}
