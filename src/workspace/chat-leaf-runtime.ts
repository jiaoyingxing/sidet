import { App, WorkspaceLeaf } from "obsidian";
import { ConversationStore } from "../conversations/conversation-store";
import { SimpleListeners } from "../shared/events";
import type {
  ChatLeafExternalImportRequest,
  ChatLeafMessageRevealRequest,
  ChatLeafState,
  ChatLeafViewState
} from "../types";
import {
  areChatLeafStatesEqual,
  createDefaultChatLeafState,
  type ChatLeafModeState,
  resolveChatLeafModeState,
  resolveChatLeafStateSnapshot,
  writeEphemeralChatLeafState
} from "./chat-leaf-state";

interface ChatLeafEntry {
  state: ChatLeafState;
  focusComposerNonce: number;
  draftOrigin: string | null;
  suppressEchoToOrigin: boolean;
  externalImportRequest: ChatLeafExternalImportRequest | null;
  externalImportRequestNonce: number;
  messageRevealRequest: ChatLeafMessageRevealRequest | null;
  messageRevealRequestNonce: number;
  listeners: SimpleListeners;
}

export interface SetComposerDraftOptions {
  origin?: string;
  suppressEchoToOrigin?: boolean;
  immediatePersistence?: boolean;
}

export interface SetWebSearchEnabledOptions {
  immediatePersistence?: boolean;
}

interface UpdateChatLeafStateOptions {
  immediatePersistence: boolean;
}

interface ChatLeafRuntimeOptions {
  app: App;
  store: ConversationStore;
  getChatLeaves: () => WorkspaceLeaf[];
  refreshLeafHeader: (leaf: WorkspaceLeaf) => void;
  emitWorkspaceState: () => void;
}

const CHAT_LEAF_STATE_SAVE_DEBOUNCE_MS = 900;

export class ChatLeafRuntime {
  private readonly chatLeafEntries = new Map<WorkspaceLeaf, ChatLeafEntry>();
  private pendingLayoutSaveTimer: number | null = null;
  private lastFocusedChatLeaf: WorkspaceLeaf | null = null;
  private lastModeState: ChatLeafModeState = resolveChatLeafModeState(createDefaultChatLeafState());
  private homeDraft = "";

  constructor(private readonly options: ChatLeafRuntimeOptions) {}

  ensureChatLeafState(leaf: WorkspaceLeaf, rawState?: unknown): ChatLeafState {
    return this.ensureChatLeafEntry(leaf, rawState).state;
  }

  hydrateChatLeafState(leaf: WorkspaceLeaf, rawState: unknown): ChatLeafState {
    const nextState = this.withStoredConversationDraft(resolveChatLeafStateSnapshot(leaf, rawState));
    const entry = this.ensureChatLeafEntry(leaf, rawState);
    this.rememberModeState(nextState);
    if (!areChatLeafStatesEqual(entry.state, nextState)) {
      entry.state = nextState;
      entry.draftOrigin = null;
      entry.suppressEchoToOrigin = false;
      writeEphemeralChatLeafState(leaf, nextState);
      entry.listeners.emit();
      this.options.refreshLeafHeader(leaf);
      this.options.emitWorkspaceState();
    }
    return entry.state;
  }

  getChatLeafState(leaf: WorkspaceLeaf): ChatLeafState {
    return this.ensureChatLeafEntry(leaf).state;
  }

  releaseChatLeaf(leaf: WorkspaceLeaf): void {
    this.chatLeafEntries.delete(leaf);
    if (this.lastFocusedChatLeaf === leaf) {
      this.lastFocusedChatLeaf = null;
    }
    this.options.emitWorkspaceState();
  }

  subscribeLeafViewState(leaf: WorkspaceLeaf, listener: () => void): () => void {
    return this.ensureChatLeafEntry(leaf).listeners.subscribe(listener);
  }

  getLeafViewState(leaf: WorkspaceLeaf): ChatLeafViewState {
    const entry = this.ensureChatLeafEntry(leaf);
    return {
      composerDraft: entry.state.draft,
      focusComposerNonce: entry.focusComposerNonce,
      draftOrigin: entry.draftOrigin,
      suppressEchoToOrigin: entry.suppressEchoToOrigin,
      externalImportRequest: entry.externalImportRequest,
      externalImportRequestNonce: entry.externalImportRequestNonce,
      messageRevealRequest: entry.messageRevealRequest,
      messageRevealRequestNonce: entry.messageRevealRequestNonce,
      modelConfigId: entry.state.modelConfigId ?? null,
      webSearchEnabled: entry.state.webSearchEnabled === true
    };
  }

  setComposerDraft(leaf: WorkspaceLeaf, draft: string, options: SetComposerDraftOptions = {}): void {
    const entry = this.ensureChatLeafEntry(leaf);
    const {
      origin,
      suppressEchoToOrigin = false,
      immediatePersistence = false
    } = options;

    if (draft === entry.state.draft) {
      entry.draftOrigin = origin ?? null;
      entry.suppressEchoToOrigin = suppressEchoToOrigin;
      this.options.store.setConversationDraft(entry.state.conversationId, draft, {
        immediatePersistence
      });
      if (!entry.state.conversationId) {
        this.homeDraft = draft;
      }
      if (immediatePersistence) {
        void this.commitChatLeafLayoutSave();
      }
      return;
    }

    entry.state = {
      ...entry.state,
      draft
    };
    entry.draftOrigin = origin ?? null;
    entry.suppressEchoToOrigin = suppressEchoToOrigin;
    this.options.store.setConversationDraft(entry.state.conversationId, draft, {
      immediatePersistence
    });
    if (!entry.state.conversationId) {
      this.homeDraft = draft;
    }
    writeEphemeralChatLeafState(leaf, entry.state);
    this.persistChatLeafState({ immediate: immediatePersistence });
    entry.listeners.emit();
  }

  focusComposer(leaf: WorkspaceLeaf): void {
    const entry = this.ensureChatLeafEntry(leaf);
    entry.focusComposerNonce += 1;
    entry.listeners.emit();
  }

  queueExternalImportRequest(
    leaf: WorkspaceLeaf,
    request: ChatLeafExternalImportRequest | null
  ): void {
    const entry = this.ensureChatLeafEntry(leaf);
    entry.externalImportRequest = request;
    entry.externalImportRequestNonce += 1;
    entry.listeners.emit();
  }

  clearExternalImportRequest(leaf: WorkspaceLeaf): void {
    const entry = this.ensureChatLeafEntry(leaf);
    if (!entry.externalImportRequest) {
      return;
    }
    entry.externalImportRequest = null;
    entry.externalImportRequestNonce += 1;
    entry.listeners.emit();
  }

  queueMessageReveal(leaf: WorkspaceLeaf, request: ChatLeafMessageRevealRequest | null): void {
    const entry = this.ensureChatLeafEntry(leaf);
    entry.messageRevealRequest = request;
    entry.messageRevealRequestNonce += 1;
    entry.listeners.emit();
  }

  clearMessageReveal(leaf: WorkspaceLeaf): void {
    const entry = this.ensureChatLeafEntry(leaf);
    if (!entry.messageRevealRequest) {
      return;
    }
    entry.messageRevealRequest = null;
    entry.messageRevealRequestNonce += 1;
    entry.listeners.emit();
  }

  getConversationForLeaf(leaf: WorkspaceLeaf) {
    const conversationId = this.getChatLeafState(leaf).conversationId;
    if (!conversationId) {
      return null;
    }
    return this.options.store.getConversation(conversationId);
  }

  handleConversationStoreReady(): void {
    let didHydrateState = false;

    for (const [leaf, entry] of this.chatLeafEntries.entries()) {
      const conversationId = entry.state.conversationId;
      if (!conversationId) {
        continue;
      }

      const conversation = this.options.store.getConversation(conversationId);
      if (!entry.state.modelConfigId && conversation?.modelConfigId) {
        entry.state = {
          ...entry.state,
          modelConfigId: conversation.modelConfigId
        };
        writeEphemeralChatLeafState(leaf, entry.state);
        entry.listeners.emit();
        didHydrateState = true;
      }

      if (entry.state.draft.trim()) {
        continue;
      }

      const storedDraft = this.options.store.getConversationDraft(conversationId);
      if (!storedDraft) {
        continue;
      }

      entry.state = {
        ...entry.state,
        draft: storedDraft
      };
      writeEphemeralChatLeafState(leaf, entry.state);
      entry.listeners.emit();
      didHydrateState = true;
    }

    if (didHydrateState) {
      void this.commitChatLeafLayoutSave();
    }

    for (const leaf of this.options.getChatLeaves()) {
      this.options.refreshLeafHeader(leaf);
    }
    this.options.emitWorkspaceState();
  }

  updateChatLeafState(
    leaf: WorkspaceLeaf,
    nextState: ChatLeafState,
    options: UpdateChatLeafStateOptions
  ): void {
    const entry = this.ensureChatLeafEntry(leaf);
    this.rememberModeState(nextState);
    if (areChatLeafStatesEqual(entry.state, nextState)) {
      if (options.immediatePersistence) {
        void this.commitChatLeafLayoutSave();
      }
      return;
    }

    entry.state = nextState;
    entry.draftOrigin = null;
    entry.suppressEchoToOrigin = false;
    writeEphemeralChatLeafState(leaf, nextState);
    this.persistChatLeafState({ immediate: options.immediatePersistence });
    entry.listeners.emit();
    this.options.refreshLeafHeader(leaf);
    this.options.emitWorkspaceState();
  }

  mergeContextIntoComposerDraft(
    leaf: WorkspaceLeaf,
    result: { block: string; draft: string }
  ): boolean {
    const entry = this.ensureChatLeafEntry(leaf);
    const existingDraft = entry.state.draft.trim();
    const nextDraft = !existingDraft
      ? result.draft
      : `${result.block}\n\n${existingDraft}`;

    entry.state = {
      ...entry.state,
      draft: nextDraft
    };
    entry.draftOrigin = null;
    entry.suppressEchoToOrigin = false;
    entry.focusComposerNonce += 1;
    writeEphemeralChatLeafState(leaf, entry.state);
    this.persistChatLeafState({ immediate: false });
    entry.listeners.emit();
    return existingDraft.length > 0;
  }

  setWebSearchEnabled(
    leaf: WorkspaceLeaf,
    webSearchEnabled: boolean,
    options: SetWebSearchEnabledOptions = {}
  ): void {
    const entry = this.ensureChatLeafEntry(leaf);
    const normalized = webSearchEnabled === true;
    if (entry.state.webSearchEnabled === normalized) {
      if (options.immediatePersistence) {
        void this.commitChatLeafLayoutSave();
      }
      return;
    }

    entry.state = {
      ...entry.state,
      webSearchEnabled: normalized
    };
    this.rememberModeState(entry.state);
    writeEphemeralChatLeafState(leaf, entry.state);
    this.persistChatLeafState({ immediate: options.immediatePersistence ?? false });
    entry.listeners.emit();
    this.options.refreshLeafHeader(leaf);
    this.options.emitWorkspaceState();
  }

  setHomeDraft(draft: string): void {
    this.homeDraft = draft;
  }

  getLastFocusedChatLeaf(): WorkspaceLeaf | null {
    return this.lastFocusedChatLeaf;
  }

  getLastModeState(): ChatLeafModeState {
    return this.lastModeState;
  }

  rememberFocusedChatLeaf(leaf: WorkspaceLeaf | null): void {
    this.lastFocusedChatLeaf = leaf;
    if (leaf) {
      this.rememberModeState(this.ensureChatLeafEntry(leaf).state);
    }
  }

  cleanupDetachedChatLeaves(): void {
    const aliveLeaves = new Set(this.options.getChatLeaves());
    for (const leaf of this.chatLeafEntries.keys()) {
      if (aliveLeaves.has(leaf)) {
        continue;
      }
      this.chatLeafEntries.delete(leaf);
    }
    if (this.lastFocusedChatLeaf && !aliveLeaves.has(this.lastFocusedChatLeaf)) {
      this.lastFocusedChatLeaf = null;
    }
  }

  async flush(): Promise<void> {
    await this.commitChatLeafLayoutSave();
  }

  destroy(): void {
    if (this.pendingLayoutSaveTimer !== null) {
      window.clearTimeout(this.pendingLayoutSaveTimer);
      this.pendingLayoutSaveTimer = null;
    }
  }

  private ensureChatLeafEntry(leaf: WorkspaceLeaf, rawState?: unknown): ChatLeafEntry {
    const existing = this.chatLeafEntries.get(leaf);
    if (existing) {
      return existing;
    }

    const entry: ChatLeafEntry = {
      state: createDefaultChatLeafState(),
      focusComposerNonce: 0,
      draftOrigin: null,
      suppressEchoToOrigin: false,
      externalImportRequest: null,
      externalImportRequestNonce: 0,
      messageRevealRequest: null,
      messageRevealRequestNonce: 0,
      listeners: new SimpleListeners()
    };
    this.chatLeafEntries.set(leaf, entry);
    entry.state = this.withStoredConversationDraft(resolveChatLeafStateSnapshot(leaf, rawState));
    this.rememberModeState(entry.state);
    return entry;
  }

  private rememberModeState(state: Partial<ChatLeafState> | null | undefined): void {
    this.lastModeState = resolveChatLeafModeState(state);
  }

  private persistChatLeafState(options: { immediate: boolean }): void {
    if (options.immediate) {
      void this.commitChatLeafLayoutSave();
      return;
    }

    if (this.pendingLayoutSaveTimer !== null) {
      window.clearTimeout(this.pendingLayoutSaveTimer);
    }
    this.pendingLayoutSaveTimer = window.setTimeout(() => {
      this.pendingLayoutSaveTimer = null;
      void this.commitChatLeafLayoutSave();
    }, CHAT_LEAF_STATE_SAVE_DEBOUNCE_MS);
  }

  private async commitChatLeafLayoutSave(): Promise<void> {
    if (this.pendingLayoutSaveTimer !== null) {
      window.clearTimeout(this.pendingLayoutSaveTimer);
      this.pendingLayoutSaveTimer = null;
    }

    this.options.app.workspace.requestSaveLayout();
  }

  private withStoredConversationDraft(state: ChatLeafState): ChatLeafState {
    if (!state.conversationId && !state.draft && this.homeDraft) {
      return { ...state, draft: this.homeDraft };
    }
    if (!state.conversationId || state.draft) {
      return state;
    }

    const storedDraft = this.options.store.getConversationDraft(state.conversationId);
    return storedDraft ? { ...state, draft: storedDraft } : state;
  }
}
