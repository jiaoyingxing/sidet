export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus = "streaming" | "done" | "error";
export interface ImageMessageAttachment {
  id: string;
  type: "image";
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

export interface MarkdownMessageAttachment {
  id: string;
  type: "markdown";
  name: string;
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

export interface WebpageMessageAttachment {
  id: string;
  type: "webpage";
  name: string;
  url: string;
  content: string;
  /** 抽取后的原始 Markdown；content 是带元数据包装的上下文块。 */
  rawContent?: string;
  truncated: boolean;
  size: number;
}

export type MessageAttachment = ImageMessageAttachment | MarkdownMessageAttachment | WebpageMessageAttachment;

export interface MessageKnowledgeBaseRoutingHit {
  path: string;
  basename: string;
  kindLabel: string;
}

export interface MessageKnowledgeBaseRoutingInfo {
  mode: "single" | "all";
  displayName: string;
  status?: "searching" | "complete" | "error";
  resultCount: number;
  hits: MessageKnowledgeBaseRoutingHit[];
}

export interface MessageMetaPanelSource {
  title: string;
  url?: string;
  host?: string;
  note?: string;
}

export type MessageSourceReadDepth = "full" | "summary";

/** 联网回答的结构化来源；正文里的 [n] 与数组序号一一对应。 */
export interface MessageSource {
  title: string;
  url?: string;
  host?: string;
  note?: string;
  readDepth?: MessageSourceReadDepth;
}

export type MessageMetaPanelDisplay = "panel" | "status" | "step";

export interface MessageMetaPanel {
  kind: string;
  label: string;
  text?: string;
  sources?: MessageMetaPanelSource[];
  display?: MessageMetaPanelDisplay;
  group?: string;
  groupLabel?: string;
}

/**
 * 一条历史回答版本。MessageRecord 的主字段始终表示当前激活版本，
 * answerVariants 只保存其余版本，按生成时间顺序排列。
 */
export interface MessageAnswerVariant {
  id: string;
  text: string;
  reasoningText?: string;
  reasoningLabel?: string;
  metaPanels?: MessageMetaPanel[];
  sources?: MessageSource[];
  status: "done" | "error";
  errorText?: string;
  createdAt: number;
}

export interface MessageRecord {
  id: string;
  role: MessageRole;
  text: string;
  reasoningText?: string;
  reasoningLabel?: string;
  createdAt: number;
  status: MessageStatus;
  /** 失败原因；有部分正文时正文保留，原因单独展示。 */
  errorText?: string;
  attachments?: MessageAttachment[];
  knowledgeBaseRouting?: MessageKnowledgeBaseRoutingInfo;
  metaPanels?: MessageMetaPanel[];
  sources?: MessageSource[];
  /** 其余回答版本；当前版本仍在主字段，不重复存放。 */
  answerVariants?: MessageAnswerVariant[];
  /** 当前版本在全部版本中的 0 基下标。 */
  activeAnswerVariantIndex?: number;
}

export interface ConversationContextSummary {
  text: string;
  /** 摘要覆盖到的最后一条消息；之后的消息仍原样发给模型。 */
  summarizedThroughMessageId: string;
  updatedAt: number;
}

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  isPinned: boolean;
  isArchived: boolean;
  archivedAt: number | null;
  folderId?: string | null;
  draft?: string;
  modelConfigId: string | null;
  messages: MessageRecord[];
  /** 较早对话的后台压缩摘要；不展示给用户，只进入 provider 上下文。 */
  contextSummary?: ConversationContextSummary;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  isPinned: boolean;
  isArchived: boolean;
  archivedAt: number | null;
  folderId: string | null;
  messageCount: number;
}

export interface ConversationFolderRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationFolderSummary {
  id: string;
  name: string;
  updatedAt: number;
  conversationCount: number;
}

export interface HomePinnedCommandSetting {
  commandId: string;
  labelOverride: string;
  iconOverride: string;
}

export interface UrlLauncherSetting {
  slot: number;
  commandId: string;
}

export type ModelProviderId = "siliconflow" | "mimo" | "openai" | "deepseek" | "openrouter" | "custom";
export type WebSearchMode = "auto" | "on" | "off";
export type ReasoningMode = "auto" | "off" | "low" | "medium" | "high";
export type ReasoningCompatibilityMode = "none" | "mimo";

export interface ModelProviderPreset {
  id: ModelProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  supportsReasoning?: boolean;
}

export interface ModelPreset {
  id: string;
  label: string;
  providerId: ModelProviderId;
  model: string;
  baseUrl: string;
  supportsImageInput?: boolean;
  /** 预设模型的上下文窗口（tokens）；用于请求历史装填预算。 */
  contextWindowTokens: number;
}

export interface ModelConfigRecord {
  id: string;
  name: string;
  providerId: ModelProviderId;
  providerLabel?: string;
  presetId?: string | null;
  model: string;
  baseUrl: string;
  reasoningEnabled: boolean;
  reasoningCompatibilityMode: ReasoningCompatibilityMode;
  supportsImageInput?: boolean;
}

export interface ResolvedModelConfig extends ModelConfigRecord {
  providerLabel: string;
}

export interface DialogPluginSettings {
  modelConfigs: ModelConfigRecord[];
  defaultModelConfigId: string | null;
  webSearchMode: WebSearchMode;
  exportFolder: string;
  homePinnedCommands: HomePinnedCommandSetting[];
  urlLaunchers: UrlLauncherSetting[];
}

export interface DialogRuntimeState {
  readonly __placeholder?: never;
}

export interface ChatLeafState extends Record<string, unknown> {
  conversationId: string | null;
  draft: string;
  modelConfigId: string | null;
  knowledgeBaseIndexPath: string | null;
  webSearchEnabled: boolean;
}

export interface ChatLeafExternalImportRequest {
  kind: "text" | "url" | "clipboard";
  text?: string;
  url?: string;
  append?: boolean;
  focusComposer?: boolean;
  source?: "uri";
}

/** 一次性消息定位请求；只在当前 leaf 内传递，不写入持久化状态。 */
export interface ChatLeafMessageRevealRequest {
  conversationId: string;
  messageId: string;
}

export interface ChatLeafViewState {
  composerDraft: string;
  focusComposerNonce: number;
  draftOrigin: string | null;
  suppressEchoToOrigin: boolean;
  externalImportRequest: ChatLeafExternalImportRequest | null;
  externalImportRequestNonce: number;
  messageRevealRequest: ChatLeafMessageRevealRequest | null;
  messageRevealRequestNonce: number;
  modelConfigId: string | null;
  knowledgeBaseIndexPath: string | null;
  webSearchEnabled: boolean;
}

export interface DialogPluginData {
  settings: DialogPluginSettings;
  runtimeState: DialogRuntimeState;
}

export interface ProviderStreamInput {
  apiKey: string;
  baseUrl: string;
  modelProviderId: ModelProviderId;
  model: string;
  webSearchMode: WebSearchMode;
  reasoningMode: ReasoningMode;
  reasoningCompatibilityMode?: ReasoningCompatibilityMode;
  messages: MessageRecord[];
  signal: AbortSignal;
}

export type ProviderStreamEvent =
  | {
      type: "content";
      text: string;
    }
  | {
      type: "reasoning";
      text: string;
    };

export interface ProviderAdapter {
  streamReply(input: ProviderStreamInput): AsyncIterable<ProviderStreamEvent>;
}

export type StoreListener = () => void;
export type ValueListener<T> = (value: T) => void;
