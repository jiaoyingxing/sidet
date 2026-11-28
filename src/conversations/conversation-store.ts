import { STORAGE_DEBOUNCE_MS, UNTITLED_CONVERSATION_TITLE } from "../constants";
import { SimpleListeners } from "../shared/events";
import { makeId } from "../shared/paths";
import { now } from "../shared/time";
import type {
  ConversationContextSummary,
  ConversationFolderRecord,
  ConversationRecord,
  MessageRecord,
  MessageSource
} from "../types";
import {
  searchConversationMessages,
  type ConversationMessageSearchHit,
  type ConversationMessageSearchOptions
} from "./conversation-search";
import { ConversationFiles } from "./conversation-files";
import {
  buildFolderSummaries,
  cloneConversation,
  getOrderedConversations,
  normalizeConversationTitle,
  normalizeFolderName,
  repairConversationRecord,
  repairFolderRecord,
  toConversationSummary
} from "./conversation-store-records";
import { ConversationStoreMessageRuntime } from "./conversation-store-message-runtime";

interface AssistantChunkEvent {
  conversationId: string;
  messageId: string;
  segment: "content" | "reasoning" | "meta";
  text: string;
}

export interface ConversationSnapshot {
  conversation: ConversationRecord;
  streamingConversationId: string | null;
}

export class ConversationStore {
  private readonly folders = new Map<string, ConversationFolderRecord>();
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly listeners = new SimpleListeners();
  private readonly assistantChunkListeners = new SimpleListeners<AssistantChunkEvent>();
  private readonly messageRuntime = new ConversationStoreMessageRuntime({
    requireConversation: (conversationId) => this.requireConversation(conversationId),
    requireMessage: (conversation, messageId) => this.requireMessage(conversation, messageId),
    saveImmediately: (conversationId) => this.saveImmediately(conversationId),
    scheduleSave: (conversationId) => this.scheduleSave(conversationId),
    getStreamingConversationId: () => this.streamingConversationId,
    setStreamingConversationId: (conversationId) => {
      this.streamingConversationId = conversationId;
    },
    emitStoreChange: () => {
      this.listeners.emit();
    },
    emitAssistantChunk: (event) => {
      this.assistantChunkListeners.emit(event);
    }
  });
  private readonly saveTimers = new Map<string, number>();
  private readonly persistChains = new Map<string, Promise<void>>();
  private folderPersistChain: Promise<void> | null = null;
  private streamingConversationId: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;

  constructor(private files: ConversationFiles) {}

  async load(): Promise<void> {
    await this.ensureLoaded();
  }

  startBackgroundLoad(): Promise<void> {
    return this.ensureLoaded();
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!this.loadPromise) {
      this.loadPromise = this.loadNow().finally(() => {
        if (!this.loaded) {
          this.loadPromise = null;
        }
      });
    }

    await this.loadPromise;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  private async loadNow(): Promise<void> {
    const loadedFolders = await this.files.loadFolders();
    const loaded = await this.files.loadAllConversations();
    const repairTimestamp = now();
    this.folders.clear();
    this.conversations.clear();
    let repairedFolders = false;

    for (const folder of loadedFolders) {
      const repairedFolder = repairFolderRecord(folder, repairTimestamp);
      if (!repairedFolder) {
        repairedFolders = true;
        continue;
      }
      if (this.folders.has(repairedFolder.id)) {
        repairedFolders = true;
        continue;
      }
      this.folders.set(repairedFolder.id, repairedFolder);
      repairedFolders = repairedFolders || repairedFolder !== folder;
    }

    for (const conversation of loaded) {
      const { conversation: repairedConversation, repaired } = repairConversationRecord(
        conversation,
        new Set(this.folders.keys())
      );
      this.conversations.set(repairedConversation.id, repairedConversation);
      if (repaired) {
        await this.enqueuePersist(repairedConversation.id);
      }
    }

    if (repairedFolders) {
      await this.saveFoldersImmediately();
    }

    this.loaded = true;
    this.streamingConversationId = null;
    this.listeners.emit();
  }

  subscribe(listener: () => void): () => void {
    return this.listeners.subscribe(listener);
  }

  subscribeAssistantChunk(listener: (event: AssistantChunkEvent) => void): () => void {
    return this.assistantChunkListeners.subscribe(listener);
  }

  getConversation(conversationId: string): ConversationRecord | null {
    return this.conversations.get(conversationId) ?? null;
  }

  hasConversation(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }

  getFolder(folderId: string): ConversationFolderRecord | null {
    return this.folders.get(folderId) ?? null;
  }

  getFolderSummaries() {
    return buildFolderSummaries(this.folders.values(), this.conversations.values());
  }

  getAllSummaries() {
    return this.getOrderedConversations().map((conversation) => toConversationSummary(conversation));
  }

  getArchivedSummaries() {
    return this.getOrderedConversations()
      .filter((conversation) => conversation.isArchived)
      .sort((left, right) => (right.archivedAt ?? right.updatedAt) - (left.archivedAt ?? left.updatedAt))
      .map((conversation) => toConversationSummary(conversation));
  }

  getSummariesInFolder(folderId: string | null) {
    return this.getOrderedConversations()
      .filter((conversation) => !conversation.isArchived)
      .filter((conversation) => (conversation.folderId ?? null) === folderId)
      .map((conversation) => toConversationSummary(conversation));
  }

  searchMessageContent(
    query: string,
    options: ConversationMessageSearchOptions = {}
  ): ConversationMessageSearchHit[] {
    const folderNames = new Map(
      Array.from(this.folders, ([folderId, folder]) => [folderId, folder.name] as const)
    );
    return searchConversationMessages(this.conversations.values(), query, {
      ...options,
      folderNames
    });
  }

  getStreamingConversationId(): string | null {
    return this.streamingConversationId;
  }

  isStreaming(): boolean {
    return this.streamingConversationId !== null;
  }

  isConversationStreaming(conversationId: string | null): boolean {
    return Boolean(conversationId) && this.streamingConversationId === conversationId;
  }

  isConversationArchived(conversationId: string | null | undefined): boolean {
    if (!conversationId) {
      return false;
    }
    return this.conversations.get(conversationId)?.isArchived === true;
  }

  getConversationDraft(conversationId: string | null): string {
    if (!conversationId) {
      return "";
    }
    return this.conversations.get(conversationId)?.draft ?? "";
  }

  captureConversationSnapshot(conversationId: string): ConversationSnapshot | null {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return null;
    }

    return {
      conversation: cloneConversation(conversation),
      streamingConversationId: this.streamingConversationId
    };
  }

  async restoreConversationSnapshot(snapshot: ConversationSnapshot): Promise<void> {
    await this.ensureLoaded();
    const conversation = cloneConversation(snapshot.conversation);
    this.conversations.set(conversation.id, conversation);
    this.streamingConversationId = snapshot.streamingConversationId;
    await this.saveImmediately(conversation.id);
    this.listeners.emit();
  }

  async createConversation(modelConfigId: string | null = null): Promise<ConversationRecord> {
    await this.ensureLoaded();
    const timestamp = now();
    const conversation: ConversationRecord = {
      id: makeId("conversation"),
      title: UNTITLED_CONVERSATION_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      isPinned: false,
      isArchived: false,
      archivedAt: null,
      folderId: null,
      modelConfigId,
      messages: []
    };

    this.conversations.set(conversation.id, conversation);
    await this.saveImmediately(conversation.id);
    this.listeners.emit();
    return conversation;
  }

  async createFolder(name: string): Promise<ConversationFolderRecord | null> {
    await this.ensureLoaded();
    const nextName = normalizeFolderName(name);
    if (!nextName) {
      return null;
    }

    const timestamp = now();
    const folder: ConversationFolderRecord = {
      id: makeId("folder"),
      name: nextName,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.folders.set(folder.id, folder);
    await this.saveFoldersImmediately();
    this.listeners.emit();
    return folder;
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    await this.ensureLoaded();
    const folder = this.folders.get(folderId);
    if (!folder) {
      return;
    }

    const nextName = normalizeFolderName(name);
    if (!nextName || nextName === folder.name) {
      return;
    }

    folder.name = nextName;
    folder.updatedAt = now();
    await this.saveFoldersImmediately();
    this.listeners.emit();
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.folders.has(folderId)) {
      return;
    }

    this.folders.delete(folderId);
    const affectedConversations = Array.from(this.conversations.values()).filter(
      (conversation) => conversation.folderId === folderId
    );

    for (const conversation of affectedConversations) {
      conversation.folderId = null;
      await this.saveImmediately(conversation.id);
    }

    await this.saveFoldersImmediately();
    this.listeners.emit();
  }

  async moveConversationToFolder(conversationId: string, folderId: string | null): Promise<void> {
    await this.ensureLoaded();
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }
    if (folderId !== null && !this.folders.has(folderId)) {
      return;
    }
    if ((conversation.folderId ?? null) === folderId) {
      return;
    }

    conversation.folderId = folderId;
    if (folderId) {
      const folder = this.folders.get(folderId);
      if (folder) {
        folder.updatedAt = now();
      }
    }

    await this.saveImmediately(conversationId);
    await this.saveFoldersImmediately();
    this.listeners.emit();
  }

  async archiveConversation(conversationId: string): Promise<void> {
    await this.ensureLoaded();
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.isArchived) {
      return;
    }

    const timestamp = now();
    conversation.isArchived = true;
    conversation.archivedAt = timestamp;
    conversation.updatedAt = timestamp;
    await this.saveImmediately(conversationId);
    this.listeners.emit();
  }

  async restoreConversation(conversationId: string): Promise<void> {
    await this.ensureLoaded();
    const conversation = this.conversations.get(conversationId);
    if (!conversation || !conversation.isArchived) {
      return;
    }

    conversation.isArchived = false;
    conversation.archivedAt = null;
    conversation.updatedAt = now();
    await this.saveImmediately(conversationId);
    this.listeners.emit();
  }

  setConversationDraft(conversationId: string | null, draft: string, options: { immediatePersistence: boolean }): void {
    if (!conversationId) {
      return;
    }

    const conversation = this.conversations.get(conversationId);
    if (!conversation || (conversation.draft ?? "") === draft) {
      return;
    }

    if (draft) {
      conversation.draft = draft;
    } else {
      delete conversation.draft;
    }

    if (options.immediatePersistence) {
      void this.saveImmediately(conversationId);
    } else {
      this.scheduleSave(conversationId);
    }
  }

  async setConversationModelConfigId(conversationId: string, modelConfigId: string | null): Promise<void> {
    await this.ensureLoaded();
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }
    const normalizedModelConfigId = typeof modelConfigId === "string" && modelConfigId.trim().length > 0
      ? modelConfigId.trim()
      : null;
    if (conversation.modelConfigId === normalizedModelConfigId) {
      return;
    }
    conversation.modelConfigId = normalizedModelConfigId;
    conversation.updatedAt = now();
    await this.saveImmediately(conversationId);
    this.listeners.emit();
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    await this.ensureLoaded();
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }
    const nextTitle = normalizeConversationTitle(title);
    if (!nextTitle) {
      return;
    }
    conversation.title = nextTitle;
    conversation.updatedAt = now();
    await this.saveImmediately(conversationId);
    this.listeners.emit();
  }

  async toggleConversationPinned(conversationId: string): Promise<void> {
    await this.ensureLoaded();
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }
    conversation.isPinned = !conversation.isPinned;
    await this.saveImmediately(conversationId);
    this.listeners.emit();
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.ensureLoaded();
    const existingTimer = this.saveTimers.get(conversationId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
      this.saveTimers.delete(conversationId);
    }
    await this.waitForPersist(conversationId);

    this.conversations.delete(conversationId);
    await this.files.deleteConversation(conversationId);
    this.persistChains.delete(conversationId);

    if (this.streamingConversationId === conversationId) {
      this.streamingConversationId = null;
    }

    this.listeners.emit();
  }

  async appendUserMessage(
    conversationId: string,
    text: string,
    attachments: MessageRecord["attachments"] = []
  ): Promise<MessageRecord> {
    await this.ensureLoaded();
    return this.messageRuntime.appendUserMessage(conversationId, text, attachments);
  }

  updateMessageAgentAction(
    conversationId: string,
    messageId: string,
    agentAction: MessageRecord["agentAction"]
  ): void {
    this.messageRuntime.updateMessageAgentAction(conversationId, messageId, agentAction);
  }

  async beginAssistantMessage(
    conversationId: string,
    options: { reasoningLabel?: string; variantOfMessageId?: string } = {}
  ): Promise<MessageRecord> {
    await this.ensureLoaded();
    return this.messageRuntime.beginAssistantMessage(conversationId, options);
  }

  async appendAssistantMessage(conversationId: string, text: string): Promise<MessageRecord> {
    await this.ensureLoaded();
    return this.messageRuntime.appendAssistantMessage(conversationId, text);
  }

  appendAssistantChunk(conversationId: string, messageId: string, chunk: string): void {
    this.messageRuntime.appendAssistantChunk(conversationId, messageId, chunk);
  }

  appendAssistantReasoningChunk(conversationId: string, messageId: string, chunk: string): void {
    this.messageRuntime.appendAssistantReasoningChunk(conversationId, messageId, chunk);
  }

  appendAssistantMetaPanelChunk(
    conversationId: string,
    messageId: string,
    panel: { kind: string; label: string; display?: "panel" | "status" | "step"; group?: string; groupLabel?: string },
    chunk: string
  ): void {
    this.messageRuntime.appendAssistantMetaPanelChunk(conversationId, messageId, panel, chunk);
  }

  replaceAssistantMetaPanelSources(
    conversationId: string,
    messageId: string,
    panel: { kind: string; label: string; display?: "panel" | "status" | "step"; group?: string; groupLabel?: string },
    sources: Array<{ title: string; url?: string; host?: string; note?: string }>
  ): void {
    this.messageRuntime.replaceAssistantMetaPanelSources(conversationId, messageId, panel, sources);
  }

  setAssistantSources(conversationId: string, messageId: string, sources: MessageSource[]): void {
    this.messageRuntime.setAssistantSources(conversationId, messageId, sources);
  }

  async setConversationContextSummary(
    conversationId: string,
    summary: ConversationContextSummary | null
  ): Promise<void> {
    await this.ensureLoaded();
    await this.messageRuntime.setContextSummary(conversationId, summary);
  }

  async finishAssistantMessage(conversationId: string, messageId: string): Promise<void> {
    await this.ensureLoaded();
    await this.messageRuntime.finishAssistantMessage(conversationId, messageId);
  }

  async failAssistantMessage(conversationId: string, messageId: string, errorText: string): Promise<void> {
    await this.ensureLoaded();
    await this.messageRuntime.failAssistantMessage(conversationId, messageId, errorText);
  }

  async selectAnswerVariant(conversationId: string, messageId: string, index: number): Promise<void> {
    await this.ensureLoaded();
    await this.messageRuntime.selectAnswerVariant(conversationId, messageId, index);
  }

  async removeMessage(conversationId: string, messageId: string): Promise<void> {
    await this.ensureLoaded();
    await this.messageRuntime.removeMessage(conversationId, messageId);
  }

  async deleteMessageAndFollowing(
    conversationId: string,
    messageId: string,
    options: { updateConversationOrder?: boolean } = {}
  ): Promise<void> {
    await this.messageRuntime.deleteMessageAndFollowing(conversationId, messageId, options);
  }

  async deleteMessagesBetween(
    conversationId: string,
    fromMessageId: string,
    beforeMessageId: string,
    options: { updateConversationOrder?: boolean } = {}
  ): Promise<void> {
    await this.ensureLoaded();
    await this.messageRuntime.deleteMessagesBetween(conversationId, fromMessageId, beforeMessageId, options);
  }

  async pruneConversationAfterMessage(
    conversationId: string,
    messageId: string,
    options: { includeTarget?: boolean; touchUpdatedAt?: boolean } = {}
  ): Promise<void> {
    await this.ensureLoaded();
    await this.messageRuntime.pruneConversationAfterMessage(conversationId, messageId, options);
  }

  buildProviderMessages(conversationId: string): MessageRecord[] {
    return this.messageRuntime.buildProviderMessages(conversationId);
  }

  buildReplacementProviderMessages(
    conversationId: string,
    replaceFromMessageId: string,
    replacementMessageId: string
  ): MessageRecord[] {
    return this.messageRuntime.buildReplacementProviderMessages(
      conversationId,
      replaceFromMessageId,
      replacementMessageId
    );
  }

  async flush(): Promise<void> {
    await this.ensureLoaded();
    const pendingIds = new Set<string>([
      ...this.saveTimers.keys(),
      ...this.persistChains.keys()
    ]);

    for (const conversationId of pendingIds) {
      const timer = this.saveTimers.get(conversationId);
      if (timer) {
        window.clearTimeout(timer);
        this.saveTimers.delete(conversationId);
        await this.enqueuePersist(conversationId);
      } else {
        await this.waitForPersist(conversationId);
      }
    }

    if (this.folderPersistChain) {
      await this.folderPersistChain;
    }
  }

  private scheduleSave(conversationId: string): void {
    const existingTimer = this.saveTimers.get(conversationId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      this.saveTimers.delete(conversationId);
      void this.enqueuePersist(conversationId);
    }, STORAGE_DEBOUNCE_MS);

    this.saveTimers.set(conversationId, timer);
  }

  private async saveImmediately(conversationId: string): Promise<void> {
    const timer = this.saveTimers.get(conversationId);
    if (timer) {
      window.clearTimeout(timer);
      this.saveTimers.delete(conversationId);
    }
    await this.enqueuePersist(conversationId);
  }

  private async enqueuePersist(conversationId: string): Promise<void> {
    const previous = this.persistChains.get(conversationId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
          return;
        }
        await this.files.saveConversation(conversation);
      });

    this.persistChains.set(
      conversationId,
      next.catch((error: unknown) => {
        console.error("Sidet：保存会话失败", { conversationId, error });
      })
    );

    await next;
  }

  private async saveFoldersImmediately(): Promise<void> {
    await this.enqueueFolderPersist();
  }

  private async enqueueFolderPersist(): Promise<void> {
    const previous = this.folderPersistChain ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const folders = Array.from(this.folders.values()).sort((left, right) => left.createdAt - right.createdAt);
        await this.files.saveFolders(folders);
      });

    this.folderPersistChain = next.catch((error) => {
      console.error("Sidet：保存文件夹索引失败", error);
    });

    await next;
  }

  private async waitForPersist(conversationId: string): Promise<void> {
    const chain = this.persistChains.get(conversationId);
    if (!chain) {
      return;
    }
    await chain;
  }

  private getOrderedConversations(): ConversationRecord[] {
    return getOrderedConversations(this.conversations.values());
  }

  private requireConversation(conversationId: string): ConversationRecord {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Missing conversation: ${conversationId}`);
    }
    return conversation;
  }

  private requireMessage(conversation: ConversationRecord, messageId: string): MessageRecord {
    const message = conversation.messages.find((item) => item.id === messageId);
    if (!message) {
      throw new Error(`Missing message: ${messageId}`);
    }
    return message;
  }
}
