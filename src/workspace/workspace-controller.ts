import { App, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
  CHAT_VIEW_ICON,
  CHAT_VIEW_TYPE,
  MAX_AGENT_TOOL_RESULT_CHARS,
  MAX_AGENT_TOOL_ROUNDS,
  PROVIDER_CONTEXT_CHARS_PER_TOKEN,
  PROVIDER_IMAGE_CONTEXT_COST_CHARS,
  PROVIDER_RESPONSE_RESERVE_TOKENS
} from "../constants";
import {
  estimateProviderMessageChars,
  resolveModelContextWindowTokens
} from "../conversations/conversation-context-budget";
import { ActiveContextService } from "../context/active-context";
import { resolveRegenerateAnswerTarget } from "./chat-view-answer-presentation";
import {
  WebSearchService,
  type WebSearchResult
} from "../context/web-search-service";
import { WebpageContextService, WEBPAGE_RESEARCH_REQUEST_TIMEOUT_MS } from "../context/webpage-context";
import { AgentActionPreviewService } from "../agent/actions/agent-action-preview";
import { runAgentToolLoop } from "../agent/tools/agent-tool-loop";
import { resolveAgentToolDefinitions } from "../agent/tools/tool-registry";
import type {
  AgentToolExecutionResult,
  AgentToolInvocation
} from "../agent/tools/tool-types";
import { buildWebResearchToolContent } from "../agent/tools/web-research-tool";
import { VaultToolService } from "../agent/tools/vault-tool-service";
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
  buildResearchAttemptSummary,
  pickVisibleProcessNote
} from "../agent/web-search/web-search-runtime-policy";
import { createDisplayableAnswerStreamer } from "../agent/web-search/displayable-answer-stream";
import {
  buildSidetResearchDecisionContext,
  buildSidetResearchEvidenceContext,
  buildSidetResearchFinalAnswerContext,
  buildSidetResearchFinalAnswerRepairContext,
  buildSidetResearchQueryContext,
  buildSidetResearchRepairContext
} from "../agent/prompts/web-search-prompts";
import {
  parseSidetResearchBlock,
  stripSidetProtocolBlocks
} from "../agent/web-search/sidet-protocol";
import {
  createResearchBudget,
  FAST_RESEARCH_EVIDENCE_CHARS,
  runWebResearchRound,
  type ResearchBudget,
  type ResearchPage,
  type ResearchRoundProgress,
  type ResearchRoundResult
} from "../agent/web-search/research-agent";
import {
  createResearchLoopState,
  runWebResearchLoop,
  type ResearchLoopState
} from "../agent/web-search/research-loop";
import { VaultAgentService } from "../agent/vault-agent";
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
import { createAgentToolStepPresenter } from "./agent-tool-step-presenter";
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
import { WorkspaceNewTabEmptyStateEnhancer } from "./new-tab-empty-state-enhancer";
import { applyWebSearchEnabled } from "./chat-leaf-mode-rules";
import {
  resolveConversationModelDisplayName as resolveModelDisplayName,
  resolveDefaultModelConfigId as resolveDefaultModelId,
  resolveLeafModelConfigId as resolveLeafModelId,
  resolveReconciledConversationModelConfigId,
  resolveReconciledLeafModelConfigId
} from "./model-selection-rules";
import type {
  ChatLeafState,
  ChatLeafViewState,
  ChatLeafExternalImportRequest,
  ChatLeafMessageRevealRequest,
  DialogPluginSettings,
  HomePinnedCommandSetting,
  MarkdownMessageAttachment,
  MessageAttachment,
  MessageRecord,
  MessageSource,
  ModelConfigRecord,
  ResolvedModelConfig,
  WebpageMessageAttachment
} from "../types";

interface OpenConversationOptions {
  focusComposer?: boolean;
  forceActiveOnMobile?: boolean;
  /** 打开后定位到指定消息；一次性请求，不写入持久化状态。 */
  messageId?: string;
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
  /** 重新生成时保留旧回答：旧消息 id 作为新回答的一个历史版本。 */
  variantOfMessageId?: string | null;
  webSearchEnabledOverride?: boolean;
  onReplacementCommit?: (() => void) | null;
}


export interface HomePinnedCommandInfo {
  commandId: string;
  label: string;
  commandName: string;
  sourceLabel: string;
  icon: string;
  available: boolean;
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

interface AutoWebSearchContext {
  state: ResearchLoopState;
  rounds: number;
}

/**
 * 一条消息内的自动联网上下文：来源编号、已读 URL 与查询跨多次工具调用累积，
 * 每次调用仍按一轮检索的现役预算执行；总调用次数由工具循环的轮次与结果预算约束。
 */
function createAutoWebSearchContext(): AutoWebSearchContext {
  return {
    state: createResearchLoopState(""),
    rounds: 0
  };
}

export class WorkspaceController {
  private readonly workspaceListeners = new SimpleListeners();
  private readonly chatLeafRuntime: ChatLeafRuntime;
  private readonly leafNavigation: WorkspaceLeafNavigation;
  private readonly conversationActions: WorkspaceConversationActions;
  private readonly nativeNewTabTakeover: WorkspaceNativeNewTabTakeover;
  private readonly newTabEmptyStateEnhancer: WorkspaceNewTabEmptyStateEnhancer;
  private readonly draftIntake: ChatDraftIntake;
  private readonly vaultToolService: VaultToolService;

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
    this.newTabEmptyStateEnhancer = new WorkspaceNewTabEmptyStateEnhancer(app, this.leafNavigation);
    this.vaultToolService = new VaultToolService({
      app
    });
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

  isWebSearchEnabled(leaf: WorkspaceLeaf): boolean {
    return this.getChatLeafState(leaf).webSearchEnabled === true;
  }

  /**
   * 全局自动联网开关（设置页「模型服务」）。只管普通对话要不要带联网工具；
   * 手动「联网搜索」是叶子级显式模式，不受这里影响。
   */
  private isAutoWebSearchEnabled(): boolean {
    return this.getSettings().webSearchMode === "auto";
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

  queueMessageReveal(leaf: WorkspaceLeaf, request: ChatLeafMessageRevealRequest | null): void {
    this.chatLeafRuntime.queueMessageReveal(leaf, request);
  }

  clearMessageReveal(leaf: WorkspaceLeaf): void {
    this.chatLeafRuntime.clearMessageReveal(leaf);
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
    const preSendContext = await this.buildPreSendAgentContext(
      trimmed,
      attachments,
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
            // 用户停止时 provider 会抛 AbortError；这不是联网失败，不写失败说明。
            if (!runtime.getAbortSignal().aborted) {
              runtime.appendContent(this.buildWebSearchFailureMarkdown(trimmed, error));
            }
            throw error;
          }
        },
        {
          replaceFromMessageId: options.replaceFromMessageId,
          variantOfMessageId: options.variantOfMessageId,
          requestContextChars: requestContext?.length ?? 0,
          onReplacementCommit: options.onReplacementCommit
        }
      );
      return;
    }
    if (options.replaceFromMessageId) {
      await this.stopStreamingAndWait();
    }
    await this.session.sendLocalAssistantTask(
      conversationId,
      modelConfig,
      trimmed,
      attachments,
      async (runtime) => {
        const toolStepPresenter = createAgentToolStepPresenter({
          appendPanelText: (panel, chunk) => runtime.appendMetaPanelText(panel, chunk),
          appendVisibleContent: (chunk) => runtime.appendContent(chunk)
        });
        const baseMessages = runtime.buildRequestMessages(requestContext);
        const autoWebSearch = createAutoWebSearchContext();
        await runAgentToolLoop({
          baseMessages,
          createMessage: (role, messageText) => this.createEphemeralMessage(role, messageText),
          callModel: (messages, callOptions) => runtime.streamModelReply(messages, {
            webSearchMode: "off",
            ...callOptions
          }),
          toolDefinitions: resolveAgentToolDefinitions({
            webResearch: this.isAutoWebSearchEnabled()
          }),
          executeTool: (invocation) => this.executeAgentTool(
            invocation,
            runtime,
            baseMessages,
            autoWebSearch
          ),
          onVisibleContent: (chunk) => toolStepPresenter.appendVisibleContent(chunk),
          onReasoning: (chunk) => runtime.appendReasoning(chunk),
          onToolStep: (step) => toolStepPresenter.handleStep(step),
          maxToolResultChars: this.resolveToolResultCharBudget(baseMessages, modelConfig),
          signal: runtime.getAbortSignal()
        });
      },
      {
        replaceFromMessageId: options.replaceFromMessageId,
        variantOfMessageId: options.variantOfMessageId,
        requestContextChars: requestContext?.length ?? 0,
        onReplacementCommit: options.onReplacementCommit
      }
    );
  }

  private resolveToolResultCharBudget(
    baseMessages: MessageRecord[],
    modelConfig: ResolvedModelConfig
  ): number {
    const contextWindowTokens = resolveModelContextWindowTokens(modelConfig);
    const requestBudgetChars = Math.floor(contextWindowTokens * PROVIDER_CONTEXT_CHARS_PER_TOKEN);
    const baseChars = baseMessages.reduce((total, message) => {
      return total + estimateProviderMessageChars(message, PROVIDER_IMAGE_CONTEXT_COST_CHARS);
    }, 0);
    const reservedChars = Math.floor(PROVIDER_RESPONSE_RESERVE_TOKENS * PROVIDER_CONTEXT_CHARS_PER_TOKEN);
    const remainingChars = requestBudgetChars - baseChars - reservedChars;
    return Math.max(
      0,
      Math.min(MAX_AGENT_TOOL_RESULT_CHARS * MAX_AGENT_TOOL_ROUNDS, remainingChars)
    );
  }

  async insertCurrentNoteIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    return this.draftIntake.insertCurrentNoteIntoDraft(targetLeaf);
  }

  async insertCurrentSelectionIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.draftIntake.insertCurrentSelectionIntoDraft(targetLeaf);
  }

  async insertMarkdownFileIntoDraft(file: TFile, targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.draftIntake.insertMarkdownFileIntoDraft(file, targetLeaf);
  }


  /**
   * 重新生成最后一条回答：复用最后一条用户消息和附件，替换旧的一轮。
   *
   * 旧回答作为版本保留在新回答上；和现有「修改最后一条提问」使用同一条
   * replaceFromMessageId 链。流式中或不是最后一条回答时拒绝。
   */
  async regenerateLatestAnswer(leaf: WorkspaceLeaf): Promise<void> {
    await this.ensureConversationStoreReady();
    const conversationId = this.getChatLeafState(leaf).conversationId;
    if (!conversationId) {
      throw new Error("当前没有可重新生成的对话。");
    }
    if (this.store.isConversationArchived(conversationId)) {
      throw new Error("已归档对话需先恢复后才能重新生成。");
    }
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) {
      throw new Error("当前对话不存在，无法重新生成。");
    }
    const target = resolveRegenerateAnswerTarget(conversation);
    await this.sendMessageFromLeaf(
      leaf,
      target.userMessage.text,
      target.userMessage.attachments ?? [],
      {
        replaceFromMessageId: target.userMessage.id,
        variantOfMessageId: target.variantOfMessageId
      }
    );
  }

  async selectAnswerVariant(leaf: WorkspaceLeaf, messageId: string, index: number): Promise<void> {
    await this.ensureConversationStoreReady();
    const conversationId = this.getChatLeafState(leaf).conversationId;
    if (!conversationId) {
      throw new Error("当前没有可切换版本的对话。");
    }
    // 只切换已有版本的激活项，不新增消息；归档对话也可翻阅。
    await this.store.selectAnswerVariant(conversationId, messageId, index);
  }









  async insertDraftNotePreviewPromptIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.draftIntake.insertDraftNotePreviewPromptIntoDraft(targetLeaf);
  }

  async openCreateDraftNotePreview(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.conversationActions.openCreateDraftNotePreview(targetLeaf);
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

  async buildWebpageAttachment(
    url: string,
    options?: { timeoutMs?: number }
  ): Promise<WebpageMessageAttachment> {
    return this.conversationActions.buildWebpageAttachment(url, options);
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
    this.newTabEmptyStateEnhancer.scheduleRefresh(6);
  }

  handleLayoutChange(): void {
    this.activeContext.rememberActiveMarkdownSource();
    this.cleanupDetachedChatLeaves();
    this.leafNavigation.dedupeBrowserLeaves();
    this.nativeNewTabTakeover.scheduleRecovery();
    this.newTabEmptyStateEnhancer.scheduleRefresh(6);
    this.workspaceListeners.emit();
  }

  handleActiveLeafChange(): void {
    this.activeContext.rememberActiveMarkdownSource();
    const activeLeaf = this.leafNavigation.getActiveChatLeaf();
    if (activeLeaf) {
      this.chatLeafRuntime.rememberFocusedChatLeaf(activeLeaf);
    }
    this.nativeNewTabTakeover.scheduleRecovery();
    this.newTabEmptyStateEnhancer.scheduleRefresh(3);
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
    this.newTabEmptyStateEnhancer.dispose();
  }

  private async ensureConversationStoreReady(): Promise<void> {
    await this.store.ensureLoaded();
  }



  private async buildPreSendAgentContext(
    text: string,
    attachments: MessageAttachment[],
    requestContextPrefix: string | null = null
  ): Promise<{ requestContext: string | null }> {
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
      const routerContext = await this.vaultAgent.buildPreSendAgentContext(text, attachments);
      return {
        requestContext: joinSidetRequestContexts(timeContext, routerContext.requestContext, toolContext)
      };
    } catch (error) {
      console.warn("Sidet：发送前上下文路由失败，已跳过自动上下文。", error);
      return {
        requestContext: joinSidetRequestContexts(timeContext, toolContext)
      };
    }
  }

  private async runModelDrivenWebSearch(
    originalQuery: string,
    requestContext: string | null,
    runtime: LocalAssistantTaskRuntime
  ): Promise<void> {
    const baseMessages = runtime.buildRequestMessages(requestContext);
    await runWebResearchLoop({
      initialQuestion: originalQuery,
      baseMessages,
      decisionContext: buildSidetResearchDecisionContext(),
      createMessage: (role, text) => this.createEphemeralMessage(role, text),
      callDecisionModel: (messages) => this.streamProtocolReply(runtime, messages, {
        parseResearch: true,
        streamVisibleContent: true
      }),
      callRepairModel: (messages) => this.streamProtocolReply(
        runtime,
        [
          this.createEphemeralMessage("system", buildSidetResearchRepairContext()),
          ...messages
        ],
        {
          parseResearch: true,
          streamVisibleContent: true
        }
      ),
      runResearchRound: (round, question, budget, state, reason) => this.runResearchRound(
        round,
        question,
        reason ?? null,
        budget,
        state,
        runtime,
        baseMessages,
        { fastEvidence: true }
      ),
      streamFinalAnswer: (messages, state) => this.streamWebSearchFinalAnswer(runtime, messages, {
        originalQuery,
        exhausted: state.exhausted,
        pages: state.pages,
        searchResults: state.lastSearchResults
      }),
      onVisibleContent: (text) => runtime.appendContent(text),
      commitSources: (state) => this.commitWebSearchSources(
        runtime,
        state.pages,
        state.lastSearchResults
      ),
      signal: runtime.getAbortSignal(),
      streamDecisionContent: true,
      now: Date.now
    });
  }

  /**
   * 普通对话的工具执行路由：vault 三件直接进 `VaultToolService`，
   * `web_research` 走同一消息内的联网上下文。联网工具是否在工具表里由
   * `resolveAgentToolDefinitions` 决定，这里不再做第二道开关。
   */
  private async executeAgentTool(
    invocation: AgentToolInvocation,
    runtime: LocalAssistantTaskRuntime,
    baseMessages: MessageRecord[],
    autoWebSearch: AutoWebSearchContext
  ): Promise<AgentToolExecutionResult> {
    if (invocation.tool !== "web_research") {
      return this.vaultToolService.execute(invocation);
    }

    const query = invocation.query?.trim() ?? "";
    if (!query) {
      return {
        tool: "web_research",
        status: "error",
        content: "缺少 query，无法联网检索。"
      };
    }

    autoWebSearch.rounds += 1;
    const result = await this.runResearchRound(
      autoWebSearch.rounds,
      query,
      null,
      createResearchBudget(),
      autoWebSearch.state,
      runtime,
      baseMessages
    );

    autoWebSearch.state.pages = [...autoWebSearch.state.pages, ...result.pages];
    autoWebSearch.state.lastSearchResults = result.results;
    autoWebSearch.state.lastQuestion = query;
    autoWebSearch.state.queries = [...autoWebSearch.state.queries, ...result.queries];
    this.commitWebSearchSources(runtime, autoWebSearch.state.pages, result.results);

    if (result.status === "empty") {
      return {
        tool: "web_research",
        status: "error",
        content: result.evidenceText.trim() || "没有检索到可用结果。"
      };
    }

    return {
      tool: "web_research",
      status: "ok",
      content: buildWebResearchToolContent(result, autoWebSearch.state.pages)
    };
  }

  private async runResearchRound(
    round: number,
    question: string,
    reason: string | null,
    budget: ResearchBudget,
    state: ResearchLoopState,
    runtime: LocalAssistantTaskRuntime,
    baseMessages: MessageRecord[],
    options: { fastEvidence?: boolean } = {}
  ): Promise<ResearchRoundResult> {
    const fastFirstRound = options.fastEvidence === true && round === 1;
    const stepPanel = createWebStepPanel(
      `web-step-research-${round}`,
      round > 1 ? `研究 ${round}` : "研究"
    );
    this.appendProcessStepDetail(runtime, stepPanel, `研究问题：${question}`);
    this.appendProcessStepDetail(runtime, stepPanel, this.resolveProcessDetail(reason));

    const previousAttempts = state.attempts;
    const result = await runWebResearchRound({
      round,
      question,
      budget,
      alreadyFetchedUrls: new Set(state.pages.map((page) => page.url)),
      sourceStart: state.pages.length + 1,
      signal: runtime.getAbortSignal(),
      previousAttempts,
      expandQueries: async (researchQuestion, maxQueries, attempts) => {
        const reply = await runtime.completeModelReply(
          [
            this.createEphemeralMessage(
              "system",
              buildSidetResearchQueryContext(researchQuestion, new Date(), maxQueries, attempts)
            ),
            ...baseMessages
          ],
          {
            webSearchMode: "off"
          }
        );
        return reply.contentText;
      },
      searchMany: (queries, onProgress) => this.webSearch.searchMany(queries, {
        maxQueries: 4,
        onProgress: (event) => onProgress?.({ message: event.message })
      }),
      fetchPage: async (url) => {
        const attachment = await this.buildWebpageAttachment(url, {
          timeoutMs: WEBPAGE_RESEARCH_REQUEST_TIMEOUT_MS
        });
        return {
          title: attachment.name,
          url: attachment.url,
          content: attachment.rawContent ?? attachment.content
        };
      },
      compressEvidence: async (researchQuestion, evidenceInput, maxChars) => {
        const reply = await runtime.completeModelReply(
          [
            this.createEphemeralMessage(
              "system",
              buildSidetResearchEvidenceContext(researchQuestion, maxChars)
            ),
            this.createEphemeralMessage("user", evidenceInput)
          ],
          {
            webSearchMode: "off"
          }
        );
        return reply.contentText;
      },
      evidenceCharLimit: fastFirstRound ? FAST_RESEARCH_EVIDENCE_CHARS : undefined,
      skipCompressionWhenFits: fastFirstRound,
      onProgress: (event: ResearchRoundProgress) => {
        this.appendProcessStepDetail(runtime, stepPanel, event.message);
      },
      now: Date.now
    });

    if (result.pages.length > 0) {
      runtime.setMetaPanelSources(stepPanel, result.pages.map((page) => ({
        title: page.title,
        url: page.url,
        host: page.host,
        note: page.snippet?.trim() || undefined
      })));
    } else if (result.results.length > 0) {
      runtime.setMetaPanelSources(stepPanel, result.results.slice(0, 8).map((item, index) => ({
        title: `${index + 1}. ${item.title}`,
        url: item.url,
        host: item.host,
        note: item.snippet
      })));
    }

    // 只保留最近几轮，避免长会话把早期失败方向一直带下去。
    state.attempts = [
      ...state.attempts,
      buildResearchAttemptSummary(
        question,
        result.queries,
        [...result.results, ...result.pages],
        result.pages.length
      )
    ].slice(-6);

    return result;
  }

  private async streamWebSearchFinalAnswer(
    runtime: LocalAssistantTaskRuntime,
    transcript: MessageRecord[],
    options: {
      originalQuery: string;
      exhausted: boolean;
      pages: ResearchPage[];
      searchResults: WebSearchResult[];
    }
  ): Promise<string> {
    return this.streamDisplayableModelAnswer(
      runtime,
      [
        this.createEphemeralMessage(
          "system",
          buildSidetResearchFinalAnswerContext({
            hasEvidence: options.pages.length > 0 || options.searchResults.length > 0,
            exhausted: options.exhausted
          })
        ),
        ...transcript
      ],
      {
        fallbackText: this.buildResearchFallbackAnswer(
          options.originalQuery,
          options.pages,
          options.searchResults
        )
      }
    );
  }

  private buildResearchFallbackAnswer(
    query: string,
    pages: ResearchPage[],
    searchResults: WebSearchResult[]
  ): string {
    if (pages.length > 0) {
      return [
        `我已经围绕“${query}”读了 ${pages.length} 个网页，但当前还没能整理出完整答复。`,
        "",
        "已读来源已经按顺序放在回答下方；可以先看这些来源，或让我基于其中某一页继续整理。"
      ].join("\n");
    }
    if (searchResults.length > 0) {
      return this.buildSearchOnlyFallbackAnswer(query, searchResults);
    }
    return `我已经围绕“${query}”做了检索，但当前没有找到可用资料。`;
  }

  /**
   * 把本轮联网来源写成结构化数据，由回答底部的来源列表渲染。
   *
   * 有抓取正文时按全局编号给出来源，正文里的 [n] 与数组序号一一对应；
   * 只有搜索摘要时列前 5 条并标记为 summary。来源不再写进正文，避免
   * 复制、导出和渲染时重复出现两套来源列表。
   */
  private commitWebSearchSources(
    runtime: LocalAssistantTaskRuntime,
    pages: ResearchPage[],
    searchResults: WebSearchResult[]
  ): void {
    if (runtime.getAbortSignal().aborted) {
      return;
    }

    const seenUrls = new Set<string>();
    const uniquePages = pages.filter((page) => {
      if (seenUrls.has(page.url)) {
        return false;
      }
      seenUrls.add(page.url);
      return true;
    });

    let sources: MessageSource[];
    if (uniquePages.length > 0) {
      sources = uniquePages.map((page) => ({
        title: page.title,
        url: page.url,
        host: page.host || this.resolveWebSourceHost(page.url) || undefined,
        note: page.snippet?.trim() || undefined,
        readDepth: "full"
      }));
    } else {
      sources = searchResults.slice(0, 8).map((result) => ({
        title: result.title,
        url: result.url,
        host: result.host,
        note: result.snippet?.trim() || undefined,
        readDepth: "summary"
      }));
    }

    runtime.setSources(sources);
  }

  private resolveWebSourceHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private appendMetaPanel(
    runtime: LocalAssistantTaskRuntime,
    panel: { kind: string; label: string; display?: "panel" | "status" | "step"; group?: string; groupLabel?: string },
    chunk: string
  ): void {
    runtime.appendMetaPanelText(panel, chunk);
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
      parseResearch?: boolean;
      streamVisibleContent?: boolean;
    }
  ): Promise<{
    contentText: string;
    reasoningText: string;
    visibleContentStreamed: boolean;
  }> {
    let visibleContentStreamed = false;
    const streamer = options.streamVisibleContent
      ? createDisplayableAnswerStreamer(
          (chunk) => {
            visibleContentStreamed = true;
            runtime.appendContent(chunk);
          },
          { holdResearchProtocolPreamble: options.parseResearch === true }
        )
      : null;
    const reply = await runtime.streamModelReply(messages, {
      webSearchMode: "off",
      onReasoningChunk: (chunk) => {
        runtime.appendReasoning(chunk);
      },
      ...(streamer
        ? {
            onContentChunk: (
              _chunk: string,
              state: { contentText: string; reasoningText: string }
            ) => {
              streamer.sync(state.contentText);
            }
          }
        : {}),
      shouldStop: ({ contentText }) => {
        return Boolean(options.parseResearch && parseSidetResearchBlock(contentText));
      }
    });
    streamer?.finish(reply.contentText);

    return {
      contentText: reply.contentText,
      reasoningText: reply.reasoningText,
      visibleContentStreamed
    };
  }

  private async streamDisplayableModelAnswer(
    runtime: LocalAssistantTaskRuntime,
    messages: MessageRecord[],
    options: {
      fallbackText?: string;
    } = {}
  ): Promise<string> {
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
      return visibleText;
    }

    const repairedReply = await runtime.completeModelReply([
      this.createEphemeralMessage("system", buildSidetResearchFinalAnswerRepairContext()),
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
      return repairedText;
    }
    const fallbackText = options.fallbackText ?? "当前没有得到可显示的回复。";
    runtime.appendContent(fallbackText);
    return fallbackText;
  }

  private buildSearchOnlyFallbackAnswer(query: string, results: WebSearchResult[]): string {
    return [
      `我已经按“${query}”完成了这轮网页搜索，但当前还不足以整理出可靠结论。`,
      "",
      `本轮命中的网页已经按顺序放在上面的联网搜索里，共 ${results.length} 条。`,
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
