import { trimTextAfterSidetActionBlock } from "../agent/actions/agent-tool-protocol";
import { UNTITLED_CONVERSATION_TITLE } from "../constants";
import { getAssistantDisplayText } from "./assistant-visible-text";
import { makeId } from "../shared/paths";
import { now } from "../shared/time";
import type {
  ConversationContextSummary,
  ConversationRecord,
  MessageAnswerVariant,
  MessageMetaPanel,
  MessageMetaPanelSource,
  MessageRecord,
  MessageSource
} from "../types";
import { buildConversationTitle } from "./conversation-store-records";

interface ConversationStoreMessageRuntimeOptions {
  requireConversation: (conversationId: string) => ConversationRecord;
  requireMessage: (conversation: ConversationRecord, messageId: string) => MessageRecord;
  saveImmediately: (conversationId: string) => Promise<void>;
  scheduleSave: (conversationId: string) => void;
  getStreamingConversationId: () => string | null;
  setStreamingConversationId: (conversationId: string | null) => void;
  emitStoreChange: () => void;
  emitAssistantChunk: (event: {
    conversationId: string;
    messageId: string;
    segment: "content" | "reasoning" | "meta";
    text: string;
  }) => void;
}

function clampAnswerVariantIndex(index: number | undefined, totalVersions: number): number {
  if (totalVersions <= 1) {
    return 0;
  }
  if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < totalVersions) {
    return index;
  }
  return totalVersions - 1;
}

/** 把「主字段激活版本 + answerVariants」还原成按时间排列的完整版本列表。 */
function buildAnswerVariantList(message: MessageRecord): MessageAnswerVariant[] {
  const variants = message.answerVariants ?? [];
  const activeIndex = clampAnswerVariantIndex(message.activeAnswerVariantIndex, variants.length + 1);
  const activeVariant: MessageAnswerVariant = {
    id: message.id,
    text: message.text,
    reasoningText: message.reasoningText,
    reasoningLabel: message.reasoningLabel,
    metaPanels: message.metaPanels,
    sources: message.sources,
    status: message.status === "error" ? "error" : "done",
    errorText: message.errorText,
    createdAt: message.createdAt
  };

  return [
    ...variants.slice(0, activeIndex),
    activeVariant,
    ...variants.slice(activeIndex)
  ];
}

function shouldInheritAnswerVariants(message: MessageRecord | undefined): message is MessageRecord {
  if (!message || message.role !== "assistant" || message.status === "streaming") {
    return false;
  }
  return message.status === "done" || (message.answerVariants?.length ?? 0) > 0;
}

/**
 * Provider 只应看到当前版本的最终回答；历史版本留在本地消息上。
 * 事件流消息的 `message.text` 还包含动作之间的过程正文，不能整条发给模型。
 */
function toProviderMessage(message: MessageRecord): MessageRecord {
  const visibleText = message.role === "assistant"
    ? getAssistantDisplayText(message)
    : message.text;
  if (
    visibleText === message.text
    && !message.answerVariants
    && message.activeAnswerVariantIndex === undefined
    && message.agentAction === undefined
  ) {
    return message;
  }
  const {
    answerVariants: _answerVariants,
    activeAnswerVariantIndex: _activeAnswerVariantIndex,
    agentAction: _agentAction,
    ...providerMessage
  } = message;
  return visibleText === message.text
    ? providerMessage
    : { ...providerMessage, text: visibleText };
}

export class ConversationStoreMessageRuntime {
  constructor(private readonly options: ConversationStoreMessageRuntimeOptions) {}

  async appendUserMessage(
    conversationId: string,
    text: string,
    attachments: MessageRecord["attachments"] = []
  ): Promise<MessageRecord> {
    const conversation = this.options.requireConversation(conversationId);
    const message: MessageRecord = {
      id: makeId("message"),
      role: "user",
      text,
      createdAt: now(),
      status: "done",
      attachments: attachments.length > 0 ? attachments : undefined
    };

    conversation.messages.push(message);
    if (conversation.title === UNTITLED_CONVERSATION_TITLE) {
      conversation.title = buildConversationTitle(text);
    }
    conversation.updatedAt = now();
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
    return message;
  }

  updateMessageAgentAction(
    conversationId: string,
    messageId: string,
    agentAction: MessageRecord["agentAction"]
  ): void {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    message.agentAction = agentAction ?? undefined;
    conversation.updatedAt = now();
    this.options.scheduleSave(conversationId);
    this.options.emitStoreChange();
  }

  async beginAssistantMessage(
    conversationId: string,
    options: { reasoningLabel?: string; variantOfMessageId?: string } = {}
  ): Promise<MessageRecord> {
    const conversation = this.options.requireConversation(conversationId);
    const variantSource = options.variantOfMessageId
      ? conversation.messages.find((message) => message.id === options.variantOfMessageId)
      : undefined;
    const inheritedVariants = shouldInheritAnswerVariants(variantSource)
      ? buildAnswerVariantList(variantSource)
      : undefined;
    const message: MessageRecord = {
      id: makeId("message"),
      role: "assistant",
      text: "",
      createdAt: now(),
      status: "streaming",
      reasoningLabel: options.reasoningLabel?.trim() || undefined,
      processStreamVersion: 1,
      answerVariants: inheritedVariants,
      activeAnswerVariantIndex: inheritedVariants?.length
    };

    conversation.messages.push(message);
    conversation.updatedAt = now();
    this.options.setStreamingConversationId(conversationId);
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
    return message;
  }

  async appendAssistantMessage(conversationId: string, text: string): Promise<MessageRecord> {
    const conversation = this.options.requireConversation(conversationId);
    const message: MessageRecord = {
      id: makeId("message"),
      role: "assistant",
      text,
      createdAt: now(),
      status: "done"
    };

    conversation.messages.push(message);
    conversation.updatedAt = now();
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
    return message;
  }

  appendAssistantChunk(conversationId: string, messageId: string, chunk: string): void {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    message.text += chunk;
    conversation.updatedAt = now();
    this.options.scheduleSave(conversationId);
    this.options.emitAssistantChunk({
      conversationId,
      messageId,
      segment: "content",
      text: message.text
    });
  }

  appendAssistantReasoningChunk(conversationId: string, messageId: string, chunk: string): void {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    message.reasoningText = `${message.reasoningText ?? ""}${chunk}`;
    conversation.updatedAt = now();
    this.options.scheduleSave(conversationId);
    this.options.emitAssistantChunk({
      conversationId,
      messageId,
      segment: "reasoning",
      text: message.reasoningText
    });
  }

  appendAssistantMetaPanelChunk(
    conversationId: string,
    messageId: string,
    panel: Pick<MessageMetaPanel, "kind" | "label" | "display" | "group" | "groupLabel">,
    chunk: string
  ): void {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    const targetPanel = this.ensureMetaPanel(message, panel);
    const nextChunk = chunk.trim();
    const previousText = targetPanel.text ?? "";
    if (nextChunk && previousText.trimEnd().endsWith(nextChunk)) {
      return;
    }
    targetPanel.text = `${previousText}${chunk}`;
    conversation.updatedAt = now();
    this.options.scheduleSave(conversationId);
    this.options.emitAssistantChunk({
      conversationId,
      messageId,
      segment: "meta",
      text: targetPanel.text
    });
  }

  replaceAssistantMetaPanelSources(
    conversationId: string,
    messageId: string,
    panel: Pick<MessageMetaPanel, "kind" | "label" | "display" | "group" | "groupLabel">,
    sources: MessageMetaPanelSource[]
  ): void {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    const targetPanel = this.ensureMetaPanel(message, panel);
    const mergedSources = [
      ...(targetPanel.sources ?? []),
      ...sources.map((source) => ({ ...source }))
    ];
    const dedupedSources: MessageMetaPanelSource[] = [];
    const seen = new Set<string>();
    for (const source of mergedSources) {
      const key = `${source.url ?? ""}::${source.title}::${source.host ?? ""}::${source.note ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      dedupedSources.push(source);
    }
    targetPanel.sources = dedupedSources.length > 0 ? dedupedSources : undefined;
    conversation.updatedAt = now();
    this.options.scheduleSave(conversationId);
    this.options.emitAssistantChunk({
      conversationId,
      messageId,
      segment: "meta",
      text: `${targetPanel.text ?? ""}${targetPanel.sources?.length ?? 0}`
    });
  }

  setAssistantSources(
    conversationId: string,
    messageId: string,
    sources: MessageSource[]
  ): void {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    if (message.role !== "assistant") {
      return;
    }
    message.sources = sources.length > 0
      ? sources.map((source) => ({ ...source }))
      : undefined;
    conversation.updatedAt = now();
    this.options.scheduleSave(conversationId);
    this.options.emitStoreChange();
  }

  async finishAssistantMessage(conversationId: string, messageId: string): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    message.text = trimTextAfterSidetActionBlock(message.text);
    message.status = "done";
    message.errorText = undefined;
    conversation.updatedAt = now();
    this.options.setStreamingConversationId(null);
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
  }

  async failAssistantMessage(conversationId: string, messageId: string, errorText: string): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    message.status = "error";
    message.errorText = errorText.trim() || undefined;
    if (!message.text.trim()) {
      message.text = errorText;
    }
    conversation.updatedAt = now();
    this.options.setStreamingConversationId(null);
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
  }

  async selectAnswerVariant(
    conversationId: string,
    messageId: string,
    index: number
  ): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    if (conversation.isArchived) {
      throw new Error("已归档对话需先恢复后才能切换回答版本。");
    }
    const message = this.options.requireMessage(conversation, messageId);
    if (message.role !== "assistant" || message.status === "streaming") {
      throw new Error("当前回答还在生成，暂时不能切换版本。");
    }
    const versions = buildAnswerVariantList(message);
    if (versions.length <= 1) {
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= versions.length) {
      throw new Error("回答版本不存在。");
    }
    if (index === clampAnswerVariantIndex(message.activeAnswerVariantIndex, versions.length)) {
      return;
    }

    const target = versions[index];
    const remaining = versions.filter((_version, versionIndex) => versionIndex !== index);
    message.text = target.text;
    message.reasoningText = target.reasoningText;
    message.reasoningLabel = target.reasoningLabel;
    message.metaPanels = target.metaPanels;
    message.sources = target.sources;
    message.status = target.status;
    message.errorText = target.errorText;
    if (target.createdAt > 0) {
      message.createdAt = target.createdAt;
    }
    message.answerVariants = remaining.length > 0 ? remaining : undefined;
    message.activeAnswerVariantIndex = remaining.length > 0 ? index : undefined;
    conversation.updatedAt = now();
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
  }

  async setContextSummary(
    conversationId: string,
    summary: ConversationContextSummary | null
  ): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    conversation.contextSummary = summary ?? undefined;
    await this.options.saveImmediately(conversationId);
  }

  async removeMessage(conversationId: string, messageId: string): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    conversation.messages = conversation.messages.filter((message) => message.id !== messageId);
    this.pruneContextSummary(conversation);
    conversation.updatedAt = now();
    this.options.setStreamingConversationId(null);
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
  }

  async deleteMessageAndFollowing(
    conversationId: string,
    messageId: string,
    options: { updateConversationOrder?: boolean } = {}
  ): Promise<void> {
    await this.pruneConversationAfterMessage(conversationId, messageId, {
      includeTarget: true,
      touchUpdatedAt: options.updateConversationOrder ?? true
    });
  }

  async deleteMessagesBetween(
    conversationId: string,
    fromMessageId: string,
    beforeMessageId: string,
    options: { updateConversationOrder?: boolean } = {}
  ): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    const fromIndex = conversation.messages.findIndex((message) => message.id === fromMessageId);
    const beforeIndex = conversation.messages.findIndex((message) => message.id === beforeMessageId);
    if (fromIndex < 0 || beforeIndex < 0 || beforeIndex <= fromIndex) {
      throw new Error("Missing replacement message range.");
    }

    const targetMessage = conversation.messages[fromIndex];
    const previousTitle = conversation.title;
    const previousDerivedTitle = buildConversationTitle(targetMessage.text);
    conversation.messages = [
      ...conversation.messages.slice(0, fromIndex),
      ...conversation.messages.slice(beforeIndex)
    ];
    this.pruneContextSummary(conversation);

    if (
      fromIndex === 0 &&
      (previousTitle === UNTITLED_CONVERSATION_TITLE || previousTitle === previousDerivedTitle)
    ) {
      this.restoreLeadingAutoTitle(conversation);
    }

    if (options.updateConversationOrder ?? true) {
      conversation.updatedAt = now();
    }
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
  }

  async pruneConversationAfterMessage(
    conversationId: string,
    messageId: string,
    options: { includeTarget?: boolean; touchUpdatedAt?: boolean } = {}
  ): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    const messageIndex = conversation.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) {
      throw new Error(`Missing message: ${messageId}`);
    }

    const includeTarget = options.includeTarget ?? false;
    const targetMessage = conversation.messages[messageIndex];
    const nextMessages = conversation.messages.slice(0, includeTarget ? messageIndex : messageIndex + 1);
    if (nextMessages.length === conversation.messages.length) {
      return;
    }

    const previousTitle = conversation.title;
    const previousDerivedTitle = buildConversationTitle(targetMessage.text);
    conversation.messages = nextMessages;
    this.pruneContextSummary(conversation);

    if (this.options.getStreamingConversationId() === conversationId) {
      this.options.setStreamingConversationId(null);
    }

    if (
      includeTarget &&
      messageIndex === 0 &&
      (previousTitle === UNTITLED_CONVERSATION_TITLE || previousTitle === previousDerivedTitle)
    ) {
      this.restoreLeadingAutoTitle(conversation);
    }

    if (options.touchUpdatedAt ?? true) {
      conversation.updatedAt = now();
    }
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
  }

  buildProviderMessages(conversationId: string): MessageRecord[] {
    const conversation = this.options.requireConversation(conversationId);
    return conversation.messages
      .filter((message) => message.status !== "streaming")
      .map(toProviderMessage);
  }

  buildReplacementProviderMessages(
    conversationId: string,
    replaceFromMessageId: string,
    replacementMessageId: string
  ): MessageRecord[] {
    const conversation = this.options.requireConversation(conversationId);
    const replaceIndex = conversation.messages.findIndex((message) => message.id === replaceFromMessageId);
    if (replaceIndex < 0) {
      throw new Error(`Missing message: ${replaceFromMessageId}`);
    }

    const replacementMessage = this.options.requireMessage(conversation, replacementMessageId);
    return [
      ...conversation.messages.slice(0, replaceIndex),
      replacementMessage
    ]
      .filter((message) => message.status !== "streaming")
      .map(toProviderMessage);
  }

  private pruneContextSummary(conversation: ConversationRecord): void {
    const summarizedThroughMessageId = conversation.contextSummary?.summarizedThroughMessageId;
    if (!summarizedThroughMessageId) {
      return;
    }
    if (!conversation.messages.some((message) => message.id === summarizedThroughMessageId)) {
      conversation.contextSummary = undefined;
    }
  }

  private restoreLeadingAutoTitle(conversation: ConversationRecord): void {
    const nextFirstUserMessage = conversation.messages.find((message) => message.role === "user");
    conversation.title = nextFirstUserMessage
      ? buildConversationTitle(nextFirstUserMessage.text)
      : UNTITLED_CONVERSATION_TITLE;
  }

  private ensureMetaPanel(
    message: MessageRecord,
    panel: Pick<MessageMetaPanel, "kind" | "label" | "display" | "group" | "groupLabel">
  ) {
    const normalizedKind = panel.kind.trim();
    const normalizedLabel = panel.label.trim();
    const normalizedDisplay = panel.display;
    const normalizedGroup = panel.group?.trim() || undefined;
    const normalizedGroupLabel = panel.groupLabel?.trim() || undefined;
    if (!message.metaPanels) {
      message.metaPanels = [];
    }
    let targetPanel = message.metaPanels.find((item) => item.kind === normalizedKind && item.label === normalizedLabel);
    if (!targetPanel) {
      targetPanel = {
        kind: normalizedKind,
        label: normalizedLabel,
        display: normalizedDisplay,
        group: normalizedGroup,
        groupLabel: normalizedGroupLabel,
        // 面板第一次出现时记下推理 / 正文已经写到哪里，渲染层据此把事件插回原位。
        reasoningBefore: message.reasoningText?.length ?? 0,
        textBefore: message.text.length
      };
      message.metaPanels.push(targetPanel);
      return targetPanel;
    }

    if (normalizedLabel) {
      targetPanel.label = normalizedLabel;
    }
    targetPanel.display = normalizedDisplay;
    targetPanel.group = normalizedGroup;
    targetPanel.groupLabel = normalizedGroupLabel;
    return targetPanel;
  }
}
