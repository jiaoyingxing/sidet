import { UNTITLED_CONVERSATION_TITLE } from "../constants";
import { makeId } from "../shared/paths";
import { now } from "../shared/time";
import type { ConversationRecord, MessageMetaPanel, MessageMetaPanelSource, MessageRecord } from "../types";
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

export class ConversationStoreMessageRuntime {
  constructor(private readonly options: ConversationStoreMessageRuntimeOptions) {}

  async appendUserMessage(
    conversationId: string,
    text: string,
    attachments: MessageRecord["attachments"] = [],
    options: {
      knowledgeBaseRouting?: MessageRecord["knowledgeBaseRouting"];
    } = {}
  ): Promise<MessageRecord> {
    const conversation = this.options.requireConversation(conversationId);
    const message: MessageRecord = {
      id: makeId("message"),
      role: "user",
      text,
      createdAt: now(),
      status: "done",
      attachments: attachments.length > 0 ? attachments : undefined,
      knowledgeBaseRouting: options.knowledgeBaseRouting ?? undefined
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

  updateMessageKnowledgeBaseRouting(
    conversationId: string,
    messageId: string,
    knowledgeBaseRouting: MessageRecord["knowledgeBaseRouting"]
  ): void {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    message.knowledgeBaseRouting = knowledgeBaseRouting ?? undefined;
    conversation.updatedAt = now();
    this.options.scheduleSave(conversationId);
    this.options.emitStoreChange();
  }

  async beginAssistantMessage(
    conversationId: string,
    options: { reasoningLabel?: string } = {}
  ): Promise<MessageRecord> {
    const conversation = this.options.requireConversation(conversationId);
    const message: MessageRecord = {
      id: makeId("message"),
      role: "assistant",
      text: "",
      createdAt: now(),
      status: "streaming",
      reasoningLabel: options.reasoningLabel?.trim() || undefined
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

  async finishAssistantMessage(conversationId: string, messageId: string): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    message.status = "done";
    conversation.updatedAt = now();
    this.options.setStreamingConversationId(null);
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
  }

  async failAssistantMessage(conversationId: string, messageId: string, errorText: string): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    const message = this.options.requireMessage(conversation, messageId);
    message.status = "error";
    if (!message.text.trim()) {
      message.text = errorText;
    }
    conversation.updatedAt = now();
    this.options.setStreamingConversationId(null);
    await this.options.saveImmediately(conversationId);
    this.options.emitStoreChange();
  }

  async removeMessage(conversationId: string, messageId: string): Promise<void> {
    const conversation = this.options.requireConversation(conversationId);
    conversation.messages = conversation.messages.filter((message) => message.id !== messageId);
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
    return conversation.messages.filter((message) => message.status !== "streaming");
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
    ].filter((message) => message.status !== "streaming");
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
        groupLabel: normalizedGroupLabel
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
