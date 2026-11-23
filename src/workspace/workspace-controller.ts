import { App, Notice, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import {
  ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
  ALL_KNOWLEDGE_BASES_SELECTION,
  CHAT_VIEW_ICON,
  CHAT_VIEW_TYPE
} from "../constants";
import { ActiveContextService } from "../context/active-context";
import {
  WebSearchService,
  type WebSearchResult
} from "../context/web-search-service";
import { WebpageContextService } from "../context/webpage-context";
import { AgentActionPreviewService } from "../agent/actions/agent-action-preview";
import {
  buildSidetFileToolContext,
  buildSidetFileToolSummaryContext
} from "../agent/actions/agent-tool-protocol";
import {
  buildSidetCurrentDateContext,
  joinSidetRequestContexts,
  resolveSidetFileToolPromptMode
} from "../agent/prompts/base-request-context";
import {
  buildFallbackSearchQueries,
  isMalformedWebSearchProtocolReply,
  normalizeSearchQueries,
  pickVisibleProcessNote
} from "../agent/web-search/web-search-runtime-policy";
import { createDisplayableAnswerStreamer } from "../agent/web-search/displayable-answer-stream";
import {
  buildSidetWebSearchContinuationRepairContext,
  buildSidetWebSearchFinalAnswerContext,
  buildSidetWebSearchFinalAnswerRepairContext,
  buildSidetWebSearchRoutingContext,
  buildSidetWebSearchRoutingRepairContext,
  buildSidetSearchResultBlock,
  buildSidetWebContextBlock,
  buildSidetWebSearchInstructionContext,
  parseSidetFetchBlock,
  parseSidetSearchBlock,
  stripSidetProtocolBlocks
} from "../agent/web-search/sidet-protocol";
import { VaultAgentService } from "../agent/vault-agent";
import type { WikiKnowledgeBaseInfo } from "../agent/wiki/wiki-memory-index";
import { MarkdownExportService } from "../export/markdown-export";
import {
  ConversationSession,
  type LocalAssistantTaskRuntime
} from "../conversations/conversation-session";
import { ConversationStore } from "../conversations/conversation-store";
import {
  getCommandRegistry,
  getRegistryCommand,
  resolveRegisteredCommand,
  type CommandRegistryLike
} from "../commands/command-registry";
import { SimpleListeners } from "../shared/events";
import {
  buildResolvedModelConfigMap
} from "../settings/model-configs";
import { ChatDraftIntake } from "./chat-draft-intake";
import { createFreshChatLeafState } from "./chat-leaf-state";
import { normalizeHomeCommandSourceLabel } from "./home-pinned-command";
import {
  ChatLeafRuntime,
  type SetComposerDraftOptions
} from "./chat-leaf-runtime";
import { syncLeafHeaderTitle } from "./leaf-header";
import { WorkspaceLeafNavigation } from "./workspace-leaf-navigation";
import { WorkspaceConversationActions } from "./workspace-conversation-actions";
import { WorkspaceNativeNewTabTakeover } from "./workspace-native-new-tab-takeover";
import {
  applyKnowledgeBaseSelection,
  applyWebSearchEnabled,
  resolveSelectedKnowledgeBaseState as resolveKnowledgeBaseSelection,
  type SelectedKnowledgeBaseState
} from "./chat-leaf-mode-rules";
import {
  resolveConversationModelDisplayName as resolveModelDisplayName,
  resolveDefaultModelConfigId as resolveDefaultModelId,
  resolveLeafModelConfigId as resolveLeafModelId,
  resolveReconciledConversationModelConfigId,
  resolveReconciledLeafModelConfigId
} from "./model-selection-rules";
import type { WikiMemoryPromptOptions } from "./wiki-memory-prompt-modal";
import type {
  ChatLeafState,
  ChatLeafViewState,
  ChatLeafExternalImportRequest,
  DialogPluginSettings,
  HomePinnedCommandSetting,
  MarkdownMessageAttachment,
  MessageAttachment,
  MessageRecord,
  ModelConfigRecord,
  ResolvedModelConfig,
  WebpageMessageAttachment
} from "../types";

interface OpenConversationOptions {
  focusComposer?: boolean;
  forceActiveOnMobile?: boolean;
}

interface OpenBrowserViewOptions {
  focus?: boolean;
}

interface OpenNewChatTabOptions {
  focusComposer?: boolean;
  reuseHomepage?: boolean;
}

interface UriOpenChatOptions {
  focusComposer?: boolean;
  text?: string;
  append?: boolean;
  clipboard?: boolean;
}

interface SendMessageFromLeafOptions {
  requestContextPrefix?: string | null;
  replaceFromMessageId?: string | null;
  selectedKnowledgeBaseIndexPathOverride?: string | null;
  webSearchEnabledOverride?: boolean;
  onReplacementCommit?: (() => void) | null;
}

export type { SelectedKnowledgeBaseState } from "./chat-leaf-mode-rules";

export interface HomePinnedCommandInfo {
  commandId: string;
  label: string;
  commandName: string;
  sourceLabel: string;
  icon: string;
  available: boolean;
}

interface ModelDrivenWebSearchState {
  round: number;
  selectedQuery: string;
  providerLabel: string;
  results: WebSearchResult[];
}

const WEB_SEARCH_GROUP = "web-search";
const WEB_SEARCH_GROUP_LABEL = "联网搜索";

function createWebStepPanel(kind: string, label: string) {
  return {
    kind,
    label,
    display: "step" as const,
    group: WEB_SEARCH_GROUP,
    groupLabel: WEB_SEARCH_GROUP_LABEL
  };
}

export class WorkspaceController {
  private readonly workspaceListeners = new SimpleListeners();
  private readonly chatLeafRuntime: ChatLeafRuntime;
  private readonly leafNavigation: WorkspaceLeafNavigation;
  private readonly conversationActions: WorkspaceConversationActions;
  private readonly nativeNewTabTakeover: WorkspaceNativeNewTabTakeover;
  private readonly draftIntake: ChatDraftIntake;

  constructor(
    private readonly app: App,
    readonly store: ConversationStore,
    private readonly session: ConversationSession,
    exporter: MarkdownExportService,
    private readonly activeContext: ActiveContextService,
    private readonly webSearch: WebSearchService,
    private readonly vaultAgent: VaultAgentService,
    private readonly getSettings: () => DialogPluginSettings,
    private readonly saveSettings: () => Promise<void>
  ) {
    this.chatLeafRuntime = new ChatLeafRuntime({
      app,
      store,
      getChatLeaves: () => this.leafNavigation.getChatLeaves(),
      refreshLeafHeader: (leaf) => this.refreshLeafHeader(leaf),
      emitWorkspaceState: () => this.workspaceListeners.emit()
    });
    this.leafNavigation = new WorkspaceLeafNavigation(
      app,
      store,
      this.chatLeafRuntime,
      () => this.getDefaultModelConfigId()
    );
    this.draftIntake = new ChatDraftIntake({
      activeContext,
      vaultAgent,
      leafNavigation: this.leafNavigation,
      runtime: this.chatLeafRuntime
    });
    this.nativeNewTabTakeover = new WorkspaceNativeNewTabTakeover(app, this.leafNavigation);
    this.conversationActions = new WorkspaceConversationActions({
      controller: this,
      leafNavigation: this.leafNavigation,
      activeContext,
      vaultAgent,
      exporter,
      conversationStore: store,
      agentActionPreview: new AgentActionPreviewService(app),
      webpageContext: new WebpageContextService(),
      ensureConversationStoreReady: () => this.ensureConversationStoreReady(),
      sendMessageFromLeaf: (leaf, text, attachments = [], options) => this.sendMessageFromLeaf(leaf, text, attachments, options),
      getSettings: () => this.getSettings(),
      resolveFreshKnowledgeConversationLeaf: (targetLeaf) => this.resolveFreshKnowledgeConversationLeaf(targetLeaf)
    });
  }

  getApp(): App {
    return this.app;
  }

  isConversationStoreReady(): boolean {
    return this.store.isLoaded();
  }

  subscribeWorkspaceState(listener: () => void): () => void {
    return this.workspaceListeners.subscribe(listener);
  }

  ensureChatLeafState(leaf: WorkspaceLeaf, rawState?: unknown): ChatLeafState {
    return this.chatLeafRuntime.ensureChatLeafState(leaf, rawState);
  }

  hydrateChatLeafState(leaf: WorkspaceLeaf, rawState: unknown): ChatLeafState {
    return this.chatLeafRuntime.hydrateChatLeafState(leaf, rawState);
  }

  getChatLeafState(leaf: WorkspaceLeaf): ChatLeafState {
    return this.chatLeafRuntime.getChatLeafState(leaf);
  }

  releaseChatLeaf(leaf: WorkspaceLeaf): void {
    this.chatLeafRuntime.releaseChatLeaf(leaf);
  }

  subscribeLeafViewState(leaf: WorkspaceLeaf, listener: () => void): () => void {
    return this.chatLeafRuntime.subscribeLeafViewState(leaf, listener);
  }

  getLeafViewState(leaf: WorkspaceLeaf): ChatLeafViewState {
    return this.chatLeafRuntime.getLeafViewState(leaf);
  }

  getAvailableKnowledgeBases(): WikiKnowledgeBaseInfo[] {
    return this.vaultAgent.findKnowledgeBases();
  }

  primeKnowledgeBasesFromMetadataCache(): WikiKnowledgeBaseInfo[] {
    const changed = this.vaultAgent.primeKnowledgeBasesFromMetadataCache();
    const selectionChanged = this.reconcileKnowledgeBaseSelections();
    if (changed || selectionChanged) {
      this.workspaceListeners.emit();
    }
    return this.getAvailableKnowledgeBases();
  }

  async refreshKnowledgeBases(): Promise<WikiKnowledgeBaseInfo[]> {
    const changed = await this.vaultAgent.refreshKnowledgeBases();
    const selectionChanged = changed ? this.reconcileKnowledgeBaseSelections() : false;
    if (changed || selectionChanged) {
      this.workspaceListeners.emit();
    }
    return this.getAvailableKnowledgeBases();
  }

  getSelectedKnowledgeBaseState(leaf: WorkspaceLeaf): SelectedKnowledgeBaseState {
    return this.resolveSelectedKnowledgeBaseState(this.getChatLeafState(leaf).knowledgeBaseIndexPath);
  }

  isWebSearchEnabled(leaf: WorkspaceLeaf): boolean {
    return this.getChatLeafState(leaf).webSearchEnabled === true;
  }

  private resolveSelectedKnowledgeBaseState(knowledgeBaseIndexPath: string | null | undefined): SelectedKnowledgeBaseState {
    return resolveKnowledgeBaseSelection(
      knowledgeBaseIndexPath,
      (indexPath) => this.vaultAgent.findKnowledgeBaseByIndexPath(indexPath)
    );
  }

  setSelectedKnowledgeBase(leaf: WorkspaceLeaf, indexPath: string | null): void {
    const nextState = applyKnowledgeBaseSelection(this.getChatLeafState(leaf), indexPath);
    this.chatLeafRuntime.updateChatLeafState(leaf, nextState, {
      immediatePersistence: true
    });
  }

  setWebSearchEnabled(leaf: WorkspaceLeaf, enabled: boolean): void {
    const nextState = applyWebSearchEnabled(this.getChatLeafState(leaf), enabled);
    this.chatLeafRuntime.updateChatLeafState(leaf, nextState, {
      immediatePersistence: true
    });
  }

  setComposerDraft(leaf: WorkspaceLeaf, draft: string, options: SetComposerDraftOptions = {}): void {
    this.chatLeafRuntime.setComposerDraft(leaf, draft, options);
  }

  focusComposer(leaf: WorkspaceLeaf): void {
    this.chatLeafRuntime.focusComposer(leaf);
  }

  queueExternalImportRequest(
    leaf: WorkspaceLeaf,
    request: ChatLeafExternalImportRequest | null
  ): void {
    this.chatLeafRuntime.queueExternalImportRequest(leaf, request);
  }

  clearExternalImportRequest(leaf: WorkspaceLeaf): void {
    this.chatLeafRuntime.clearExternalImportRequest(leaf);
  }

  getConversationForLeaf(leaf: WorkspaceLeaf) {
    return this.chatLeafRuntime.getConversationForLeaf(leaf);
  }

  isConversationArchived(conversationId: string | null | undefined): boolean {
    return this.store.isConversationArchived(conversationId);
  }

  isLeafConversationArchived(leaf: WorkspaceLeaf): boolean {
    return this.isConversationArchived(this.getChatLeafState(leaf).conversationId);
  }

  getActiveConversationId(): string | null {
    return this.leafNavigation.getActiveConversationId();
  }

  getChatLeafDisplayText(leaf: WorkspaceLeaf): string {
    const conversation = this.getConversationForLeaf(leaf);
    return conversation?.title?.trim() || "Sidet";
  }

  handleConversationStoreReady(): void {
    this.chatLeafRuntime.handleConversationStoreReady();
    void this.reconcileModelConfigBindings();
  }

  getAvailableModelConfigs(): ResolvedModelConfig[] {
    return Array.from(this.buildResolvedModelConfigMap().values());
  }

  getDefaultModelConfigId(): string | null {
    return resolveDefaultModelId(this.getSettings(), this.buildResolvedModelConfigMap());
  }

  getDefaultModelConfig(): ResolvedModelConfig | null {
    return this.resolveModelConfigById(this.getDefaultModelConfigId());
  }

  getLeafModelConfigId(leaf: WorkspaceLeaf): string | null {
    const state = this.getChatLeafState(leaf);
    const conversationModelConfigId = state.conversationId
      ? this.readConversationModelConfigId(state.conversationId)
      : null;
    return resolveLeafModelId(
      state.modelConfigId,
      conversationModelConfigId,
      this.buildResolvedModelConfigMap(),
      this.getDefaultModelConfigId()
    );
  }

  getLeafModelConfig(leaf: WorkspaceLeaf): ResolvedModelConfig | null {
    return this.resolveModelConfigById(this.getLeafModelConfigId(leaf));
  }

  getConversationModelDisplayName(conversationId: string | null | undefined): string {
    const conversationModelConfigId = conversationId
      ? this.readConversationModelConfigId(conversationId)
      : null;
    return resolveModelDisplayName(
      conversationModelConfigId,
      this.getDefaultModelConfigId(),
      this.buildResolvedModelConfigMap()
    );
  }

  async setLeafModelConfig(leaf: WorkspaceLeaf, modelConfigId: string): Promise<void> {
    const resolved = this.resolveModelConfigById(modelConfigId);
    if (!resolved) {
      return;
    }

    const state = this.getChatLeafState(leaf);
    if (state.conversationId) {
      await this.persistConversationModelConfigId(state.conversationId, resolved.id);
    }
    this.chatLeafRuntime.updateChatLeafState(leaf, {
      ...state,
      modelConfigId: resolved.id
    }, {
      immediatePersistence: true
    });
    this.workspaceListeners.emit();
  }

  currentModelSupportsImageInput(leaf?: WorkspaceLeaf): boolean {
    const targetLeaf = leaf ?? this.leafNavigation.getNavigationChatLeaf();
    const modelConfig = targetLeaf ? this.getLeafModelConfig(targetLeaf) : this.getDefaultModelConfig();
    return modelConfig?.supportsImageInput === true;
  }

  async upsertModelConfig(config: ModelConfigRecord, options: {
    setAsDefault?: boolean;
  } = {}): Promise<void> {
    const settings = this.getSettings();
    const nextConfigs = [...settings.modelConfigs];
    const index = nextConfigs.findIndex((item) => item.id === config.id);
    if (index >= 0) {
      nextConfigs[index] = { ...config };
    } else {
      nextConfigs.push({ ...config });
    }
    settings.modelConfigs = nextConfigs;
    if (options.setAsDefault || !settings.defaultModelConfigId) {
      settings.defaultModelConfigId = config.id;
    }
    await this.saveSettings();
    await this.reconcileModelConfigBindings();
    this.workspaceListeners.emit();
  }

  async setDefaultModelConfig(modelConfigId: string): Promise<void> {
    if (!this.resolveModelConfigById(modelConfigId)) {
      return;
    }
    const settings = this.getSettings();
    settings.defaultModelConfigId = modelConfigId;
    await this.saveSettings();
    for (const leaf of this.leafNavigation.getChatLeaves()) {
      const state = this.getChatLeafState(leaf);
      if (state.conversationId) {
        continue;
      }
      this.chatLeafRuntime.updateChatLeafState(leaf, {
        ...state,
        modelConfigId
      }, {
        immediatePersistence: true
      });
    }
    this.workspaceListeners.emit();
  }

  async deleteModelConfig(modelConfigId: string): Promise<void> {
    const settings = this.getSettings();
    if (settings.modelConfigs.length <= 1) {
      throw new Error("至少保留一条模型项。");
    }
    const nextConfigs = settings.modelConfigs.filter((config) => config.id !== modelConfigId);
    if (nextConfigs.length === settings.modelConfigs.length) {
      return;
    }
    settings.modelConfigs = nextConfigs;
    if (settings.defaultModelConfigId === modelConfigId) {
      settings.defaultModelConfigId = nextConfigs[0]?.id ?? null;
    }
    await this.saveSettings();
    await this.reconcileModelConfigBindings();
    this.workspaceListeners.emit();
  }

  private buildResolvedModelConfigMap(): Map<string, ResolvedModelConfig> {
    return buildResolvedModelConfigMap(this.getSettings().modelConfigs);
  }

  private resolveModelConfigById(modelConfigId: string | null | undefined): ResolvedModelConfig | null {
    if (!modelConfigId) {
      return null;
    }
    return this.buildResolvedModelConfigMap().get(modelConfigId) ?? null;
  }

  private async reconcileModelConfigBindings(): Promise<void> {
    const defaultModelConfigId = this.getDefaultModelConfigId();
    const modelConfigs = this.buildResolvedModelConfigMap();
    if (!defaultModelConfigId || modelConfigs.size === 0) {
      return;
    }

    for (const summary of this.store.getAllSummaries()) {
      const conversation = this.store.getConversation(summary.id);
      if (!conversation) {
        continue;
      }
      const nextConversationModelConfigId = resolveReconciledConversationModelConfigId(
        conversation.modelConfigId ?? null,
        modelConfigs,
        defaultModelConfigId
      );
      if (conversation.modelConfigId === nextConversationModelConfigId) {
        continue;
      }
      await this.persistConversationModelConfigId(conversation.id, nextConversationModelConfigId);
    }

    for (const leaf of this.leafNavigation.getChatLeaves()) {
      const state = this.getChatLeafState(leaf);
      const conversationModelConfigId = state.conversationId
        ? this.readConversationModelConfigId(state.conversationId)
        : null;
      const nextModelConfigId = resolveReconciledLeafModelConfigId(
        state,
        conversationModelConfigId,
        modelConfigs,
        defaultModelConfigId
      );
      if (state.modelConfigId === nextModelConfigId) {
        continue;
      }
      this.chatLeafRuntime.updateChatLeafState(leaf, {
        ...state,
        modelConfigId: nextModelConfigId
      }, {
        immediatePersistence: true
      });
    }
  }

  private readConversationModelConfigId(conversationId: string): string | null {
    if (typeof (this.store as { getConversation?: unknown }).getConversation !== "function") {
      return null;
    }
    const conversation = this.store.getConversation(conversationId);
    return conversation?.modelConfigId ?? null;
  }

  private async persistConversationModelConfigId(conversationId: string, modelConfigId: string | null): Promise<void> {
    if (typeof (this.store as { setConversationModelConfigId?: unknown }).setConversationModelConfigId !== "function") {
      return;
    }
    await this.store.setConversationModelConfigId(conversationId, modelConfigId);
  }

  isLeafStreaming(leaf: WorkspaceLeaf): boolean {
    const conversationId = this.getChatLeafState(leaf).conversationId;
    return this.store.isConversationStreaming(conversationId);
  }

  stopStreamingForLeaf(leaf: WorkspaceLeaf): void {
    if (!this.isLeafStreaming(leaf)) {
      return;
    }
    this.session.stop();
  }

  async stopStreamingAndWait(): Promise<void> {
    await this.session.stopAndWait();
  }
  async openWorkspace(): Promise<void> {
    await this.leafNavigation.openWorkspace();
  }

  async ensureBrowserViewOpen(): Promise<WorkspaceLeaf> {
    return this.leafNavigation.ensureBrowserViewOpen();
  }

  async openBrowserView(options: OpenBrowserViewOptions = {}): Promise<WorkspaceLeaf> {
    return this.leafNavigation.openBrowserView(options);
  }

  async openNewChatTab(options: OpenNewChatTabOptions = {}): Promise<WorkspaceLeaf> {
    return this.leafNavigation.openNewChatTab(options);
  }

  async openChatFromUri(options: UriOpenChatOptions = {}): Promise<WorkspaceLeaf> {
    return this.draftIntake.openChatFromUri(options);
  }

  async openConversationInLeaf(
    conversationId: string,
    options: OpenConversationOptions = {}
  ): Promise<WorkspaceLeaf | null> {
    await this.ensureConversationStoreReady();
    return this.leafNavigation.openConversationInLeaf(conversationId, options);
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    await this.ensureConversationStoreReady();
    await this.store.renameConversation(conversationId, title);
    this.refreshAllChatLeafHeaders();
  }

  async toggleConversationPinned(conversationId: string): Promise<void> {
    await this.ensureConversationStoreReady();
    await this.store.toggleConversationPinned(conversationId);
  }

  async archiveConversation(conversationId: string): Promise<void> {
    await this.ensureConversationStoreReady();
    if (this.store.isConversationStreaming(conversationId) && this.session.isStreaming()) {
      await this.session.stopAndWait();
    }
    await this.store.archiveConversation(conversationId);
  }

  async restoreConversation(conversationId: string): Promise<void> {
    await this.ensureConversationStoreReady();
    await this.store.restoreConversation(conversationId);
  }

  getArchivedConversationSummaries() {
    return this.store.getArchivedSummaries();
  }

  async createFolder(name: string): Promise<void> {
    await this.ensureConversationStoreReady();
    await this.store.createFolder(name);
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    await this.ensureConversationStoreReady();
    await this.store.renameFolder(folderId, name);
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.ensureConversationStoreReady();
    await this.store.deleteFolder(folderId);
  }

  async moveConversationToFolder(conversationId: string, folderId: string | null): Promise<void> {
    await this.ensureConversationStoreReady();
    await this.store.moveConversationToFolder(conversationId, folderId);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.ensureConversationStoreReady();
    if (this.store.isConversationStreaming(conversationId) && this.session.isStreaming()) {
      this.session.stop();
    }

    await this.store.deleteConversation(conversationId);

    for (const leaf of this.leafNavigation.getChatLeaves()) {
      const state = this.getChatLeafState(leaf);
      if (state.conversationId !== conversationId) {
        continue;
      }
      this.chatLeafRuntime.updateChatLeafState(leaf, createFreshChatLeafState(state, this.getDefaultModelConfigId()), {
        immediatePersistence: true
      });
    }
  }

  async deleteLastUserMessage(
    conversationId: string,
    messageId: string,
    options: { updateConversationOrder?: boolean } = {}
  ): Promise<void> {
    await this.ensureConversationStoreReady();
    if (this.store.isConversationArchived(conversationId)) {
      throw new Error("已归档对话需先恢复后才能继续修改消息。");
    }
    await this.stopStreamingAndWait();
    await this.store.deleteMessageAndFollowing(conversationId, messageId, {
      updateConversationOrder: options.updateConversationOrder ?? true
    });
  }

  async sendMessageFromLeaf(
    leaf: WorkspaceLeaf,
    text: string,
    attachments: MessageAttachment[] = [],
    options: SendMessageFromLeafOptions = {}
  ): Promise<void> {
    await this.ensureConversationStoreReady();
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      return;
    }

    let state = this.getChatLeafState(leaf);
    let conversationId = state.conversationId;
    if (conversationId && this.store.isConversationArchived(conversationId)) {
      throw new Error("已归档对话需先恢复后才能继续发送。");
    }
    const modelConfig = this.getLeafModelConfig(leaf);
    if (!modelConfig) {
      throw new Error("请先在设置中新增并保存至少一条模型项。");
    }
    if (!conversationId) {
      const conversation = await this.store.createConversation(modelConfig.id);
      conversationId = conversation.id;
      state = {
        ...state,
        conversationId,
        modelConfigId: modelConfig.id
      };
      this.chatLeafRuntime.updateChatLeafState(leaf, state, {
        immediatePersistence: true
      });
    } else if (state.modelConfigId !== modelConfig.id) {
      state = {
        ...state,
        modelConfigId: modelConfig.id
      };
      await this.persistConversationModelConfigId(conversationId, modelConfig.id);
      this.chatLeafRuntime.updateChatLeafState(leaf, state, {
        immediatePersistence: true
      });
    }

    await this.leafNavigation.presentChatLeaf(leaf, {
      activate: true,
      focusComposer: false
    });
    const selectedKnowledgeBaseState = options.selectedKnowledgeBaseIndexPathOverride === undefined
      ? this.getSelectedKnowledgeBaseState(leaf)
      : this.resolveSelectedKnowledgeBaseState(options.selectedKnowledgeBaseIndexPathOverride);
    if (selectedKnowledgeBaseState.mode !== "none") {
      const pendingKnowledgeBaseRouting: MessageRecord["knowledgeBaseRouting"] = {
        mode: selectedKnowledgeBaseState.mode,
        displayName: selectedKnowledgeBaseState.displayName ?? ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
        status: "searching",
        resultCount: 0,
        hits: []
      };
      if (options.replaceFromMessageId) {
        await this.stopStreamingAndWait();
      }
      await this.session.sendLocalAssistantReply(
        conversationId,
        trimmed,
        async () => {
          const localSearchReply = await this.vaultAgent.buildKnowledgeBaseSearchReply(
            trimmed,
            attachments,
            selectedKnowledgeBaseState
          );
          return {
            assistantText: localSearchReply?.responseMarkdown ?? "当前无法生成知识库检索结果。",
            knowledgeBaseRouting: localSearchReply?.knowledgeBaseRouting
          };
        },
        attachments,
        {
          replaceFromMessageId: options.replaceFromMessageId,
          knowledgeBaseRouting: pendingKnowledgeBaseRouting,
          onReplacementCommit: options.onReplacementCommit
        }
      );
      return;
    }
    const preSendContext = await this.buildPreSendAgentContext(
      trimmed,
      attachments,
      selectedKnowledgeBaseState,
      options.requestContextPrefix ?? null
    );
    const extraRequestContext = options.requestContextPrefix?.trim();
    const requestContext = joinSidetRequestContexts(extraRequestContext, preSendContext.requestContext);
    const effectiveWebSearchEnabled = options.webSearchEnabledOverride ?? this.isWebSearchEnabled(leaf);
    if (effectiveWebSearchEnabled && trimmed.length > 0 && attachments.length === 0) {
      if (options.replaceFromMessageId) {
        await this.stopStreamingAndWait();
      }
      await this.session.sendLocalAssistantTask(
        conversationId,
        modelConfig,
        trimmed,
        attachments,
        async (runtime) => {
          try {
            await this.runModelDrivenWebSearch(trimmed, requestContext, runtime);
          } catch (error) {
            runtime.appendContent(this.buildWebSearchFailureMarkdown(trimmed, error));
            throw error;
          }
        },
        {
          replaceFromMessageId: options.replaceFromMessageId,
          onReplacementCommit: options.onReplacementCommit
        }
      );
      return;
    }
    if (options.replaceFromMessageId) {
      await this.stopStreamingAndWait();
    }
    await this.session.send(conversationId, modelConfig, trimmed, attachments, {
      requestContext,
      replaceFromMessageId: options.replaceFromMessageId,
      knowledgeBaseRouting: preSendContext.knowledgeBaseRouting,
      onReplacementCommit: options.onReplacementCommit
    });
  }

  async insertCurrentNoteIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.draftIntake.insertCurrentNoteIntoDraft(targetLeaf);
  }

  async insertCurrentSelectionIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.draftIntake.insertCurrentSelectionIntoDraft(targetLeaf);
  }

  async insertMarkdownFileIntoDraft(file: TFile, targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.draftIntake.insertMarkdownFileIntoDraft(file, targetLeaf);
  }

  async createKnowledgeBaseIndexForFolder(folder: TFolder): Promise<void> {
    try {
      const { path, created } = await this.vaultAgent.createKnowledgeBaseIndexForFolder(folder);
      await this.refreshKnowledgeBases().catch((error) => {
        console.warn("Sidet：创建知识库根页后刷新识别失败。", error);
      });
      new Notice(created ? `已创建知识库根页：${path}` : `知识库根页已存在：${path}`, 4000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建知识库根页失败。";
      new Notice(message, 4000);
    }
  }

  async insertMemoryCandidatePromptIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.draftIntake.insertMemoryCandidatePromptIntoDraft(targetLeaf);
  }

  openWikiMemoryPrompt(targetLeaf?: WorkspaceLeaf, options: WikiMemoryPromptOptions = {}): void {
    this.conversationActions.openWikiMemoryPrompt(targetLeaf, options);
  }

  openWikiMemoryPromptForMarkdownFile(
    file: TFile,
    targetLeaf?: WorkspaceLeaf,
    options: WikiMemoryPromptOptions = {}
  ): void {
    this.conversationActions.openWikiMemoryPromptForMarkdownFile(file, targetLeaf, options);
  }

  tryHandleConversationKnowledgeCommandFromChat(
    leaf: WorkspaceLeaf,
    text: string,
    attachments: MessageAttachment[],
    options: WikiMemoryPromptOptions = {}
  ): boolean {
    return this.conversationActions.tryHandleConversationKnowledgeCommandFromChat(leaf, text, attachments, options);
  }

  async generateWikiMaintenancePlanFromConversation(
    leaf: WorkspaceLeaf,
    userBoundary?: string
  ): Promise<void> {
    await this.conversationActions.generateWikiMaintenancePlanFromConversation(leaf, userBoundary);
  }

  async generateWikiMaintenancePlanFromCurrentNote(
    targetLeaf?: WorkspaceLeaf,
    userBoundary?: string
  ): Promise<void> {
    await this.conversationActions.generateWikiMaintenancePlanFromCurrentNote(targetLeaf, userBoundary);
  }

  async generateWikiMaintenancePlanFromMarkdownFile(
    file: TFile,
    targetLeaf?: WorkspaceLeaf,
    userBoundary?: string
  ): Promise<void> {
    await this.conversationActions.generateWikiMaintenancePlanFromMarkdownFile(file, targetLeaf, userBoundary);
  }

  async continueLatestWikiMaintenancePlan(targetLeaf?: WorkspaceLeaf): Promise<boolean> {
    return this.conversationActions.continueLatestWikiMaintenancePlan(targetLeaf);
  }

  async repairMalformedWikiNotes(): Promise<void> {
    await this.conversationActions.repairMalformedWikiNotes();
  }

  async generateSkillFromConversation(leaf: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.generateSkillFromConversation(leaf);
  }

  async generateSkillFromCurrentConversation(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.generateSkillFromCurrentConversation(targetLeaf);
  }

  async insertDraftNotePreviewPromptIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.draftIntake.insertDraftNotePreviewPromptIntoDraft(targetLeaf);
  }

  async openCreateDraftNotePreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.openCreateDraftNotePreview(targetLeaf);
  }

  async openCreateMemoryCandidatePreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.openCreateMemoryCandidatePreview(targetLeaf);
  }

  async openCreateWikiMemoryPreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.openCreateWikiMemoryPreview(targetLeaf);
  }

  async openCreateSkillPreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.openCreateSkillPreview(targetLeaf);
  }

  async openCreateWebpageClipPreview(attachment: WebpageMessageAttachment): Promise<void> {
    await this.conversationActions.openCreateWebpageClipPreview(attachment);
  }

  async openAppendLatestReplyPreview(file: TFile, targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.openAppendLatestReplyPreview(file, targetLeaf);
  }

  async openReplaceCurrentSelectionPreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.openReplaceCurrentSelectionPreview(targetLeaf);
  }

  async openReplaceCurrentSectionPreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.openReplaceCurrentSectionPreview(targetLeaf);
  }

  async buildMarkdownFileAttachment(file: TFile): Promise<MarkdownMessageAttachment> {
    return this.conversationActions.buildMarkdownFileAttachment(file);
  }

  async buildWebpageAttachment(url: string): Promise<WebpageMessageAttachment> {
    return this.conversationActions.buildWebpageAttachment(url);
  }

  async exportConversationForLeaf(leaf: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.exportConversationForLeaf(leaf);
  }

  async exportConversationById(conversationId: string): Promise<void> {
    await this.conversationActions.exportConversationById(conversationId);
  }

  getHomePinnedCommandInfos(): HomePinnedCommandInfo[] {
    return this.getSettings().homePinnedCommands.map((item) => this.resolveHomePinnedCommandInfo(item));
  }

  async executeHomePinnedCommand(commandId: string): Promise<void> {
    const registry = this.getCommandRegistry();
    const command = getRegistryCommand(registry, commandId);
    if (!command) {
      new Notice(`主页命令不可用：${commandId}`, 3200);
      return;
    }

    if (!registry?.executeCommandById) {
      new Notice("当前环境无法执行命令。", 3200);
      return;
    }

    try {
      await Promise.resolve(registry.executeCommandById(commandId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "主页命令执行失败。";
      new Notice(message, 4000);
    }
  }

  refreshHomeViews(): void {
    for (const leaf of this.leafNavigation.getChatLeaves()) {
      if (this.getChatLeafState(leaf).conversationId !== null) {
        continue;
      }
      void this.refreshLeafView(leaf, CHAT_VIEW_TYPE);
    }
  }

  async handleSettingsChanged(): Promise<void> {
    await this.reconcileModelConfigBindings();
    this.refreshAllChatLeafHeaders();
    this.workspaceListeners.emit();
  }

  showSendError(error: unknown): void {
    const message = error instanceof Error ? error.message : "发送消息失败。";
    new Notice(message, 4000);
  }

  handleLayoutReady(): void {
    this.activeContext.rememberActiveMarkdownSource();
    this.cleanupDetachedChatLeaves();
    this.nativeNewTabTakeover.scheduleRecovery();
  }

  handleLayoutChange(): void {
    this.activeContext.rememberActiveMarkdownSource();
    this.cleanupDetachedChatLeaves();
    this.leafNavigation.dedupeBrowserLeaves();
    this.nativeNewTabTakeover.scheduleRecovery();
    this.workspaceListeners.emit();
  }

  handleActiveLeafChange(): void {
    this.activeContext.rememberActiveMarkdownSource();
    const activeLeaf = this.leafNavigation.getActiveChatLeaf();
    if (activeLeaf) {
      this.chatLeafRuntime.rememberFocusedChatLeaf(activeLeaf);
    }
    this.nativeNewTabTakeover.scheduleRecovery();
    this.workspaceListeners.emit();
  }

  installNativeNewTabTakeover(): () => void {
    return this.nativeNewTabTakeover.install();
  }

  async flush(): Promise<void> {
    await this.chatLeafRuntime.flush();
  }

  destroy(): void {
    this.chatLeafRuntime.destroy();
    this.nativeNewTabTakeover.destroy();
  }

  private async ensureConversationStoreReady(): Promise<void> {
    await this.store.ensureLoaded();
  }

  private async resolveFreshKnowledgeConversationLeaf(targetLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf> {
    return this.leafNavigation.resolveFreshKnowledgeConversationLeaf(targetLeaf);
  }

  private async buildPreSendAgentContext(
    text: string,
    attachments: MessageAttachment[],
    selectedKnowledgeBase: SelectedKnowledgeBaseState | WikiKnowledgeBaseInfo | null = null,
    requestContextPrefix: string | null = null
  ): Promise<{
    requestContext: string | null;
    knowledgeBaseRouting: MessageRecord["knowledgeBaseRouting"];
  }> {
    const timeContext = buildSidetCurrentDateContext();
    const toolPromptMode = resolveSidetFileToolPromptMode({
      text,
      attachments,
      requestContextPrefix
    });
    const toolContext = toolPromptMode === "full"
      ? buildSidetFileToolContext()
      : toolPromptMode === "compact"
        ? buildSidetFileToolSummaryContext()
        : null;
    try {
      const routerContext = await this.vaultAgent.buildPreSendAgentContext(text, attachments, selectedKnowledgeBase);
      return {
        requestContext: joinSidetRequestContexts(timeContext, routerContext.requestContext, toolContext),
        knowledgeBaseRouting: routerContext.knowledgeBaseRouting ?? undefined
      };
    } catch (error) {
      console.warn("Sidet：发送前上下文路由失败，已跳过自动上下文。", error);
      return {
        requestContext: joinSidetRequestContexts(timeContext, toolContext),
        knowledgeBaseRouting: undefined
      };
    }
  }

  private async runModelDrivenWebSearch(
    originalQuery: string,
    requestContext: string | null,
    runtime: LocalAssistantTaskRuntime
  ): Promise<void> {
    const baseMessages = runtime.buildRequestMessages(requestContext);
    const answerStepPanel = createWebStepPanel("web-step-answer", "过程说明");

    let kickoffReply = await this.streamProtocolReply(
      runtime,
      [
        this.createEphemeralMessage("system", buildSidetWebSearchRoutingContext()),
        ...baseMessages
      ],
      {
        parseSearch: true
      }
    );
    let routeSearchInstruction = parseSidetSearchBlock(kickoffReply.contentText);

    if (!routeSearchInstruction) {
      const repairedKickoffReply = await this.streamProtocolReply(
        runtime,
        [
          this.createEphemeralMessage("system", buildSidetWebSearchRoutingRepairContext()),
          ...baseMessages,
          this.createEphemeralMessage("assistant", kickoffReply.contentText || "（上一条没有按内部协议返回）")
        ],
        {
          parseSearch: true
        }
      );
      kickoffReply = repairedKickoffReply;
      routeSearchInstruction = parseSidetSearchBlock(kickoffReply.contentText);
    }
    let latestSearchState: ModelDrivenWebSearchState | null = null;

    if (!routeSearchInstruction) {
      routeSearchInstruction = {
        intent: "web_search",
        round: 1,
        queries: buildFallbackSearchQueries(originalQuery),
        reason: null
      };
    }

    const kickoffAssistantText = parseSidetSearchBlock(kickoffReply.contentText)
      ? kickoffReply.contentText
      : null;
    let transcript: MessageRecord[] = [
      this.createEphemeralMessage("system", buildSidetWebSearchInstructionContext()),
      ...baseMessages,
      ...(kickoffAssistantText ? [this.createEphemeralMessage("assistant", kickoffAssistantText)] : [])
    ];

    latestSearchState = await this.runSearchInstruction(
      routeSearchInstruction.round ?? 1,
      routeSearchInstruction.queries,
      runtime,
      routeSearchInstruction.reason
    );
    transcript = [
      ...transcript,
      this.createEphemeralMessage(
        "user",
        buildSidetSearchResultBlock(
          latestSearchState.round,
          latestSearchState.selectedQuery,
          latestSearchState.providerLabel,
          latestSearchState.results
        )
      )
    ];

    for (let step = 1; step <= 5; step += 1) {
      const reply = await this.streamProtocolReply(
        runtime,
        transcript,
        {
          parseSearch: true,
          parseFetch: true
        }
      );
      const rawText = reply.contentText.trim();
      const visibleReplyText = stripSidetProtocolBlocks(rawText).trim();
      const searchInstruction = parseSidetSearchBlock(rawText);
      const fetchInstruction = parseSidetFetchBlock(rawText);
      const malformedProtocolAttempt = isMalformedWebSearchProtocolReply(rawText);

      if (!searchInstruction && !fetchInstruction) {
        if (visibleReplyText && !malformedProtocolAttempt) {
          runtime.appendContent(visibleReplyText);
          return;
        }

        transcript = [
          ...transcript,
          this.createEphemeralMessage("assistant", reply.contentText)
        ];
        const continuationReply = await this.repairWebSearchContinuation(
          runtime,
          transcript,
          reply
        );

        const continuedSearchInstruction = parseSidetSearchBlock(continuationReply.contentText.trim());
        const continuedFetchInstruction = parseSidetFetchBlock(continuationReply.contentText.trim());
        const continuedVisibleReplyText = stripSidetProtocolBlocks(continuationReply.contentText).trim();
        const continuedMalformedProtocolAttempt = isMalformedWebSearchProtocolReply(continuationReply.contentText);

        if (!continuedSearchInstruction && !continuedFetchInstruction) {
          if (continuedVisibleReplyText && !continuedMalformedProtocolAttempt) {
            runtime.appendContent(continuedVisibleReplyText);
            return;
          }

          await this.streamWebSearchFinalAnswer(
            runtime,
            transcript,
            latestSearchState,
            originalQuery,
            continuationReply.contentText.trim() || reply.contentText.trim()
          );
          return;
        }

        transcript = [
          ...transcript,
          this.createEphemeralMessage("assistant", continuationReply.contentText)
        ];

        if (continuedSearchInstruction) {
          latestSearchState = await this.runSearchInstruction(
            continuedSearchInstruction.round ?? (latestSearchState?.round ?? step) + 1,
            continuedSearchInstruction.queries,
            runtime,
            continuedSearchInstruction.reason
          );
          transcript = [
            ...transcript,
            this.createEphemeralMessage(
              "user",
              buildSidetSearchResultBlock(
                latestSearchState.round,
                latestSearchState.selectedQuery,
                latestSearchState.providerLabel,
                latestSearchState.results
              )
            )
          ];
          continue;
        }

        if (!continuedFetchInstruction) {
          continue;
        }

        if (!latestSearchState) {
          this.appendProcessStepDetail(
            runtime,
            answerStepPanel,
            "模型尝试抓取网页，但当前没有可用的搜索结果可供继续处理。"
          );
          runtime.appendContent(this.buildWebSearchFailureMarkdown(originalQuery, new Error("当前没有可供抓取的搜索结果。")));
          return;
        }

        const continuedFetchedSources = await this.runFetchInstruction(
          continuedFetchInstruction.round ?? latestSearchState.round,
          latestSearchState,
          continuedFetchInstruction.picks,
          runtime,
          continuedFetchInstruction.reason
        );
        transcript = [
          ...transcript,
          this.createEphemeralMessage(
            "user",
            buildSidetWebContextBlock(
              continuedFetchInstruction.round ?? latestSearchState.round,
              continuedFetchedSources
            )
          )
        ];
        continue;
      }

      transcript = [
        ...transcript,
        this.createEphemeralMessage("assistant", reply.contentText)
      ];

      if (searchInstruction) {
        latestSearchState = await this.runSearchInstruction(
          searchInstruction.round ?? (latestSearchState?.round ?? step) + 1,
          searchInstruction.queries,
          runtime,
          searchInstruction.reason
        );
        transcript = [
          ...transcript,
          this.createEphemeralMessage(
            "user",
            buildSidetSearchResultBlock(
              latestSearchState.round,
              latestSearchState.selectedQuery,
              latestSearchState.providerLabel,
              latestSearchState.results
            )
          )
        ];
        continue;
      }

      if (!fetchInstruction) {
        continue;
      }

      if (!latestSearchState) {
        this.appendProcessStepDetail(
          runtime,
          answerStepPanel,
          "模型尝试抓取网页，但当前没有可用的搜索结果可供继续处理。"
        );
        runtime.appendContent(this.buildWebSearchFailureMarkdown(originalQuery, new Error("当前没有可供抓取的搜索结果。")));
        return;
      }

      const fetchedSources = await this.runFetchInstruction(
        fetchInstruction.round ?? latestSearchState.round,
        latestSearchState,
        fetchInstruction.picks,
        runtime,
        fetchInstruction.reason
      );
      transcript = [
        ...transcript,
        this.createEphemeralMessage(
          "user",
          buildSidetWebContextBlock(fetchInstruction.round ?? latestSearchState.round, fetchedSources)
        )
      ];
    }

    this.appendProcessStepDetail(
      runtime,
      answerStepPanel,
      "这轮联网过程超过当前轮次预算，已停止继续扩展。"
    );
    runtime.appendContent(this.buildWebSearchFailureMarkdown(originalQuery, new Error("联网思考未能在当前轮次内完成。")));
  }

  private async runSearchInstruction(
    round: number,
    queries: string[],
    runtime: LocalAssistantTaskRuntime,
    reason?: string | null
  ): Promise<ModelDrivenWebSearchState> {
    const candidates = normalizeSearchQueries(queries, {
      limit: 3
    });
    if (candidates.length === 0) {
      throw new Error("模型没有提供可执行的搜索词。");
    }

    const stepPanel = createWebStepPanel(`web-step-search-${round}`, round > 1 ? `网页搜索 ${round}` : "网页搜索");

    let lastState: ModelDrivenWebSearchState | null = null;
    let lastError: unknown = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const query = candidates[index];
      try {
        const payload = await this.webSearch.search(query, {
          onProgress: (event) => {
            this.appendProcessStepDetail(runtime, stepPanel, event.message);
          }
        });
        lastState = {
          round,
          selectedQuery: query,
          providerLabel: payload.providerLabel,
          results: payload.results
        };
        if (payload.results.length > 0) {
          this.appendProcessStepDetail(
            runtime,
            stepPanel,
            [
              this.resolveProcessDetail(reason),
              `搜索词：${query}`,
              `搜索源：${payload.providerLabel}`,
              `命中结果：${payload.results.length} 条`
            ].filter(Boolean).join("\n")
          );
          runtime.setMetaPanelSources(stepPanel, payload.results.map((result, index) => ({
            title: `${index + 1}. ${result.title}`,
            url: result.url
          })));
          return lastState;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastState) {
      return lastState;
    }

    throw lastError instanceof Error ? lastError : new Error("联网搜索失败。");
  }

  private async runFetchInstruction(
    round: number,
    searchState: ModelDrivenWebSearchState,
    picks: number[],
    runtime: LocalAssistantTaskRuntime,
    reason?: string | null
  ): Promise<Array<Pick<WebpageMessageAttachment, "name" | "url" | "content"> & { snippet?: string }>> {
    const selectedEntries = picks
      .slice(0, 3)
      .map((pick) => ({ pick, result: searchState.results[pick - 1] ?? null }))
      .filter((item) => item.result !== null);
    if (selectedEntries.length === 0) {
      throw new Error("模型没有选中可抓取的搜索结果。");
    }

    const stepPanel = createWebStepPanel(`web-step-fetch-${round}`, "网页抓取");

    const sources: Array<Pick<WebpageMessageAttachment, "name" | "url" | "content"> & { snippet?: string }> = [];
    for (const entry of selectedEntries) {
      const result = entry.result;
      try {
        const attachment = await this.buildWebpageAttachment(result.url);
        sources.push({
          name: attachment.name,
          url: attachment.url,
          content: attachment.content,
          snippet: result.snippet
        });
      } catch (error) {
        console.warn("Sidet：网页抓取失败。", error);
      }
    }

    if (sources.length === 0) {
      throw new Error("网页抓取失败，当前没有可带入的正文内容。");
    }

    this.appendProcessStepDetail(
      runtime,
      stepPanel,
      [
        this.resolveProcessDetail(reason),
        `从 ${searchState.providerLabel} 的搜索结果中抓取 ${sources.length} 个网页正文。`
      ].filter(Boolean).join("\n")
    );
    runtime.setMetaPanelSources(stepPanel, sources.map((source) => {
      const host = (() => {
        try {
          return new URL(source.url).hostname;
        } catch {
          return undefined;
        }
      })();
      return {
        title: source.name,
        url: source.url,
        host,
        note: source.snippet?.trim() || undefined
      };
    }));
    return sources;
  }

  private async streamWebSearchFinalAnswer(
    runtime: LocalAssistantTaskRuntime,
    transcript: MessageRecord[],
    latestSearchState?: ModelDrivenWebSearchState | null,
    originalQuery?: string,
    assistantSeed?: string | null
  ): Promise<void> {
    const seed = assistantSeed?.trim() || "";
    const fallbackQuery = latestSearchState?.selectedQuery?.trim() || originalQuery || "当前查询";
    await this.streamDisplayableModelAnswer(
      runtime,
      [
        this.createEphemeralMessage(
          "system",
          seed ? buildSidetWebSearchFinalAnswerRepairContext() : buildSidetWebSearchFinalAnswerContext()
        ),
        ...transcript,
        ...(seed ? [this.createEphemeralMessage("assistant", seed)] : [])
      ],
      {
        fallbackText: latestSearchState && latestSearchState.results.length > 0
          ? this.buildSearchOnlyFallbackAnswer(fallbackQuery, latestSearchState)
          : "当前没有得到可显示的回复。"
      }
    );
  }

  private appendMetaPanel(
    runtime: LocalAssistantTaskRuntime,
    panel: { kind: string; label: string; display?: "panel" | "status" | "step"; group?: string; groupLabel?: string },
    chunk: string
  ): void {
    runtime.appendMetaPanelText(panel, chunk);
  }

  private async repairWebSearchContinuation(
    runtime: LocalAssistantTaskRuntime,
    transcript: MessageRecord[],
    reply: {
      contentText: string;
      reasoningText: string;
    }
  ): Promise<{
    contentText: string;
    reasoningText: string;
  }> {
    return this.streamProtocolReply(
      runtime,
      [
        this.createEphemeralMessage("system", buildSidetWebSearchContinuationRepairContext()),
        ...transcript,
        this.createEphemeralMessage(
          "assistant",
          reply.contentText.trim() || "（上一条没有给出可执行下一步，也没有给出可显示答复）"
        )
      ],
      {
        parseSearch: true,
        parseFetch: true
      }
    );
  }

  private appendProcessStepDetail(
    runtime: LocalAssistantTaskRuntime,
    panel: ReturnType<typeof createWebStepPanel>,
    text: string | null
  ): void {
    const normalized = text?.trim();
    if (!normalized) {
      return;
    }
    this.appendMetaPanel(runtime, panel, `${normalized}\n`);
  }

  private async streamProtocolReply(
    runtime: LocalAssistantTaskRuntime,
    messages: MessageRecord[],
    options: {
      parseSearch?: boolean;
      parseFetch?: boolean;
    }
  ): Promise<{
    contentText: string;
    reasoningText: string;
  }> {
    const reply = await runtime.streamModelReply(messages, {
      webSearchMode: "off",
      onReasoningChunk: (chunk) => {
        runtime.appendReasoning(chunk);
      },
      shouldStop: ({ contentText }) => {
        if (options.parseSearch && parseSidetSearchBlock(contentText)) {
          return true;
        }
        if (options.parseFetch && parseSidetFetchBlock(contentText)) {
          return true;
        }
        return false;
      }
    });

    return {
      contentText: reply.contentText,
      reasoningText: reply.reasoningText
    };
  }

  private async streamDisplayableModelAnswer(
    runtime: LocalAssistantTaskRuntime,
    messages: MessageRecord[],
    options: {
      fallbackText?: string;
    } = {}
  ): Promise<void> {
    const streamer = createDisplayableAnswerStreamer((chunk) => {
      runtime.appendContent(chunk);
    });
    const reply = await runtime.streamModelReply(messages, {
      webSearchMode: "off",
      onReasoningChunk: (chunk) => {
        runtime.appendReasoning(chunk);
      },
      onContentChunk: (_chunk, state) => {
        streamer.sync(state.contentText);
      }
    });

    const visibleText = streamer.finish(reply.contentText);
    if (visibleText.trim()) {
      return;
    }

    const repairedReply = await runtime.completeModelReply([
      this.createEphemeralMessage("system", buildSidetWebSearchFinalAnswerRepairContext()),
      ...messages,
      ...(reply.contentText.trim()
        ? [this.createEphemeralMessage("assistant", reply.contentText)]
        : [])
    ], {
      webSearchMode: "off"
    });
    const repairedText = stripSidetProtocolBlocks(repairedReply.contentText).trim();
    if (repairedText) {
      runtime.appendContent(repairedText);
      return;
    }
    runtime.appendContent(options.fallbackText ?? "当前没有得到可显示的回复。");
  }

  private buildSearchOnlyFallbackAnswer(query: string, searchState: ModelDrivenWebSearchState): string {
    return [
      `我已经按“${query}”完成了这轮网页搜索，但当前还不足以整理出可靠结论。`,
      "",
      `本轮命中的网页已经按顺序放在上面的联网搜索里，共 ${searchState.results.length} 条。`,
      "",
      "下一步更合适的做法是继续抓取其中的网页正文，再整理成一版明确结论。"
    ].join("\n");
  }

  private resolveProcessDetail(reason: string | null | undefined): string | null {
    return pickVisibleProcessNote(reason);
  }

  private createEphemeralMessage(
    role: MessageRecord["role"],
    text: string,
    attachments: MessageAttachment[] = []
  ): MessageRecord {
    return {
      id: `sidet-virtual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      text,
      createdAt: Date.now(),
      status: "done",
      attachments: attachments.length > 0 ? attachments : undefined
    };
  }

  private resolveHomePinnedCommandInfo(item: HomePinnedCommandSetting): HomePinnedCommandInfo {
    const commandInfo = resolveRegisteredCommand(this.app, item.commandId);
    const commandName = commandInfo?.name ?? item.commandId;
    const sourceLabel = normalizeHomeCommandSourceLabel(commandInfo?.source.label ?? "");
    return {
      commandId: item.commandId,
      label: item.labelOverride || sourceLabel || commandName,
      commandName,
      sourceLabel,
      icon: item.iconOverride || commandInfo?.icon || "command",
      available: Boolean(commandInfo)
    };
  }

  private async refreshLeafView(leaf: WorkspaceLeaf, expectedType: string): Promise<void> {
    await this.leafNavigation.refreshLeafView(leaf, expectedType);
  }

  private refreshAllChatLeafHeaders(): void {
    for (const leaf of this.leafNavigation.getChatLeaves()) {
      this.refreshLeafHeader(leaf);
    }
  }

  private refreshLeafHeader(leaf: WorkspaceLeaf): void {
    syncLeafHeaderTitle(leaf, this.getChatLeafDisplayText(leaf), CHAT_VIEW_ICON);
  }

  private cleanupDetachedChatLeaves(): void {
    this.chatLeafRuntime.cleanupDetachedChatLeaves();
  }

  private reconcileKnowledgeBaseSelections(): boolean {
    let changed = false;
    for (const leaf of this.leafNavigation.getChatLeaves()) {
      const state = this.getChatLeafState(leaf);
      if (!state.knowledgeBaseIndexPath || state.knowledgeBaseIndexPath === ALL_KNOWLEDGE_BASES_SELECTION) {
        continue;
      }
      if (this.vaultAgent.findKnowledgeBaseByIndexPath(state.knowledgeBaseIndexPath)) {
        continue;
      }
      this.chatLeafRuntime.setKnowledgeBaseIndexPath(leaf, null, {
        immediatePersistence: true
      });
      changed = true;
    }
    return changed;
  }

  private getCommandRegistry(): CommandRegistryLike | null {
    return getCommandRegistry(this.app);
  }

  private buildWebSearchFailureMarkdown(query: string, error: unknown): string {
    const message = error instanceof Error ? error.message : "联网搜索失败。";
    return [
      "# 联网搜索失败",
      "",
      `- 查询：${query}`,
      `- 原因：${message}`,
      "",
      "## 建议",
      "",
      "- 稍后重试，或先直接用“引用网页”带入一个明确 URL。",
      "- 只要你先把网页带进输入框，后续继续提问就会回到普通模型回复链。"
    ].join("\n");
  }

}
