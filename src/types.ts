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

export interface MessageRecord {
  id: string;
  role: MessageRole;
  text: string;
  reasoningText?: string;
  reasoningLabel?: string;
  createdAt: number;
  status: MessageStatus;
  attachments?: MessageAttachment[];
  knowledgeBaseRouting?: MessageKnowledgeBaseRoutingInfo;
  metaPanels?: MessageMetaPanel[];
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

export interface ChatLeafViewState {
  composerDraft: string;
  focusComposerNonce: number;
  draftOrigin: string | null;
  suppressEchoToOrigin: boolean;
  externalImportRequest: ChatLeafExternalImportRequest | null;
  externalImportRequestNonce: number;
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
