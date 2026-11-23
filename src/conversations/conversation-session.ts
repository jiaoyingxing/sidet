import type {
  MessageAttachment,
  MessageMetaPanel,
  MessageMetaPanelSource,
  MessageRecord,
  ProviderAdapter,
  ReasoningMode,
  ResolvedModelConfig,
  WebSearchMode
} from "../types";
import { ConversationStore, type ConversationSnapshot } from "./conversation-store";

interface SendOptions {
  requestContext?: string | null;
  replaceFromMessageId?: string | null;
  knowledgeBaseRouting?: MessageRecord["knowledgeBaseRouting"];
  onReplacementCommit?: (() => void) | null;
}

interface LocalAssistantReplyPayload {
  assistantText: string;
  knowledgeBaseRouting?: MessageRecord["knowledgeBaseRouting"];
}

export interface LocalAssistantTaskRuntime {
  appendReasoning: (chunk: string) => void;
  appendContent: (chunk: string) => void;
  appendMetaPanelText: (panel: Pick<MessageMetaPanel, "kind" | "label" | "display" | "group" | "groupLabel">, chunk: string) => void;
  setMetaPanelSources: (panel: Pick<MessageMetaPanel, "kind" | "label" | "display" | "group" | "groupLabel">, sources: MessageMetaPanelSource[]) => void;
  buildRequestMessages: (requestContext?: string | null) => MessageRecord[];
  completeModelReply: (
    messages: MessageRecord[],
    options?: {
      webSearchMode?: WebSearchMode;
      reasoningMode?: ReasoningMode;
    }
  ) => Promise<{
    contentText: string;
    reasoningText: string;
  }>;
  streamModelReply: (
    messages: MessageRecord[],
    options?: {
      webSearchMode?: WebSearchMode;
      reasoningMode?: ReasoningMode;
      onReasoningChunk?: (chunk: string, state: { contentText: string; reasoningText: string }) => void;
      onContentChunk?: (chunk: string, state: { contentText: string; reasoningText: string }) => void;
      shouldStop?: (state: { contentText: string; reasoningText: string }) => boolean;
    }
  ) => Promise<{
    contentText: string;
    reasoningText: string;
    stoppedEarly: boolean;
  }>;
}

interface StreamAssistantOptions {
  replaceSnapshot?: ConversationSnapshot | null;
  onFirstAssistantResponse?: () => Promise<void>;
  isReplacementCommitted?: () => boolean;
}

interface ActiveStream {
  conversationId: string;
  assistantMessageId: string;
  abortController: AbortController;
  forceStopped: boolean;
  stopFallbackTimer: number | null;
  settled: Promise<void>;
  resolveSettled: () => void;
  replaceSnapshot: ConversationSnapshot | null;
  isReplacementCommitted: (() => boolean) | null;
}

export class ConversationSession {
  private activeStream: ActiveStream | null = null;

  constructor(
    private readonly store: ConversationStore,
    private readonly provider: ProviderAdapter,
    private readonly getApiKey: (modelConfigId: string) => string | null
  ) {}

  isStreaming(): boolean {
    return this.activeStream !== null;
  }

  getActiveConversationId(): string | null {
    return this.activeStream?.conversationId ?? null;
  }

  stop(): void {
    const stream = this.activeStream;
    if (!stream) {
      return;
    }

    stream.abortController.abort();
    if (stream.stopFallbackTimer !== null) {
      return;
    }

    stream.stopFallbackTimer = window.setTimeout(() => {
      stream.stopFallbackTimer = null;
      void this.forceStopStream(stream);
    }, 1200);
  }

  async stopAndWait(): Promise<void> {
    const stream = this.activeStream;
    if (!stream) {
      return;
    }

    this.stop();
    await stream.settled;
  }

  async send(
    conversationId: string,
    modelConfig: ResolvedModelConfig,
    text: string,
    attachments: MessageAttachment[] = [],
    options: SendOptions = {}
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      return;
    }

    if (this.activeStream) {
      throw new Error("当前已有回复正在生成。");
    }

    if (!this.store.hasConversation(conversationId)) {
      throw new Error("当前对话不存在，无法发送。");
    }

    const apiKey = this.getApiKey(modelConfig.id);
    if (!apiKey) {
      throw new Error("请先在模型设置里填写这条模型的 API Key。");
    }

    const messageText = trimmed || (attachments.some((attachment) => attachment.type === "image")
      ? "请解析这张图片。"
      : attachments.some((attachment) => attachment.type === "webpage")
        ? "请阅读引用网页。"
        : "请阅读引用笔记。");
    const replaceFromMessageId = options.replaceFromMessageId ?? null;
    const replaceSnapshot = replaceFromMessageId
      ? this.store.captureConversationSnapshot(conversationId)
      : null;
    let replacementCommitted = false;
    try {
      const userMessage = await this.store.appendUserMessage(conversationId, messageText, attachments, {
        knowledgeBaseRouting: options.knowledgeBaseRouting
      });
      const commitReplacement = async (): Promise<void> => {
        if (!replaceFromMessageId || replacementCommitted) {
          return;
        }
        await this.store.deleteMessagesBetween(conversationId, replaceFromMessageId, userMessage.id, {
          updateConversationOrder: false
        });
        replacementCommitted = true;
        options.onReplacementCommit?.();
      };
      const providerMessages = replaceFromMessageId
        ? this.store.buildReplacementProviderMessages(conversationId, replaceFromMessageId, userMessage.id)
        : this.store.buildProviderMessages(conversationId);
      const requestMessages = this.withRequestContext(
        providerMessages,
        userMessage.id,
        options.requestContext
      );
      await this.streamAssistantResponse(conversationId, modelConfig, apiKey, requestMessages, {
        replaceSnapshot,
        onFirstAssistantResponse: replaceFromMessageId ? commitReplacement : undefined,
        isReplacementCommitted: () => replacementCommitted
      });
      if (replaceSnapshot && !replacementCommitted) {
        await this.store.restoreConversationSnapshot(replaceSnapshot);
      }
    } catch (error) {
      if (replaceSnapshot && !replacementCommitted) {
        await this.store.restoreConversationSnapshot(replaceSnapshot);
      }
      throw error;
    }
  }

  async sendLocalAssistantReply(
    conversationId: string,
    text: string,
    assistantReply: string | ((userMessage: MessageRecord) => Promise<LocalAssistantReplyPayload | string>),
    attachments: MessageAttachment[] = [],
    options: SendOptions = {}
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      return;
    }

    if (this.activeStream) {
      throw new Error("当前已有回复正在生成。");
    }

    if (!this.store.hasConversation(conversationId)) {
      throw new Error("当前对话不存在，无法发送。");
    }

    const messageText = trimmed || (attachments.some((attachment) => attachment.type === "image")
      ? "请解析这张图片。"
      : attachments.some((attachment) => attachment.type === "webpage")
        ? "请阅读引用网页。"
        : "请阅读引用笔记。");
    const replaceFromMessageId = options.replaceFromMessageId ?? null;
    const replaceSnapshot = replaceFromMessageId
      ? this.store.captureConversationSnapshot(conversationId)
      : null;
    let replacementCommitted = false;
    let assistantMessage: MessageRecord | null = null;
    let userMessage: MessageRecord | null = null;
    try {
      const appendedUserMessage = await this.store.appendUserMessage(conversationId, messageText, attachments, {
        knowledgeBaseRouting: options.knowledgeBaseRouting
      });
      userMessage = appendedUserMessage;
      const commitReplacement = async (): Promise<void> => {
        if (!replaceFromMessageId || replacementCommitted) {
          return;
        }
        await this.store.deleteMessagesBetween(conversationId, replaceFromMessageId, appendedUserMessage.id, {
          updateConversationOrder: false
        });
        replacementCommitted = true;
        options.onReplacementCommit?.();
      };
      assistantMessage = await this.store.beginAssistantMessage(conversationId);
      const replyPayload = typeof assistantReply === "string"
        ? assistantReply
        : await assistantReply(appendedUserMessage);
      const resolvedReply = typeof replyPayload === "string"
        ? {
            assistantText: replyPayload,
            knowledgeBaseRouting: undefined
          }
        : replyPayload;
      if (resolvedReply.knowledgeBaseRouting) {
        this.store.updateMessageKnowledgeBaseRouting(
          conversationId,
          appendedUserMessage.id,
          resolvedReply.knowledgeBaseRouting
        );
      } else if (appendedUserMessage.knowledgeBaseRouting?.status === "searching") {
        this.store.updateMessageKnowledgeBaseRouting(
          conversationId,
          appendedUserMessage.id,
          {
            ...appendedUserMessage.knowledgeBaseRouting,
            status: "error",
            resultCount: 0,
            hits: []
          }
        );
      }
      this.store.appendAssistantChunk(
        conversationId,
        assistantMessage.id,
        resolvedReply.assistantText.trim() || "当前没有可显示的知识库检索结果。"
      );
      await this.store.finishAssistantMessage(conversationId, assistantMessage.id);
      await commitReplacement();
    } catch (error) {
      if (replaceSnapshot && !replacementCommitted) {
        await this.store.restoreConversationSnapshot(replaceSnapshot);
      } else {
        if (userMessage?.knowledgeBaseRouting?.status === "searching") {
          this.store.updateMessageKnowledgeBaseRouting(
            conversationId,
            userMessage.id,
            {
              ...userMessage.knowledgeBaseRouting,
              status: "error",
              resultCount: 0,
              hits: []
            }
          );
        }
        if (assistantMessage) {
          const message = error instanceof Error ? error.message : "本地回复失败。";
          await this.store.failAssistantMessage(conversationId, assistantMessage.id, message);
        }
      }
      throw error;
    }
  }

  async sendLocalAssistantTask(
    conversationId: string,
    modelConfig: ResolvedModelConfig,
    text: string,
    attachments: MessageAttachment[] = [],
    task: (runtime: LocalAssistantTaskRuntime) => Promise<void>,
    options: SendOptions & { reasoningLabel?: string } = {}
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      return;
    }

    if (this.activeStream) {
      throw new Error("当前已有回复正在生成。");
    }

    if (!this.store.hasConversation(conversationId)) {
      throw new Error("当前对话不存在，无法发送。");
    }

    const messageText = trimmed || (attachments.some((attachment) => attachment.type === "image")
      ? "请解析这张图片。"
      : attachments.some((attachment) => attachment.type === "webpage")
        ? "请阅读引用网页。"
        : "请阅读引用笔记。");
    const replaceFromMessageId = options.replaceFromMessageId ?? null;
    const replaceSnapshot = replaceFromMessageId
      ? this.store.captureConversationSnapshot(conversationId)
      : null;
    let replacementCommitted = false;
    const replacementCommitState: { promise: Promise<void> | null } = { promise: null };

    try {
      const userMessage = await this.store.appendUserMessage(conversationId, messageText, attachments, {
        knowledgeBaseRouting: options.knowledgeBaseRouting
      });
      const commitReplacement = async (): Promise<void> => {
        if (!replaceFromMessageId || replacementCommitted) {
          return;
        }
        await this.store.deleteMessagesBetween(conversationId, replaceFromMessageId, userMessage.id, {
          updateConversationOrder: false
        });
        replacementCommitted = true;
        options.onReplacementCommit?.();
      };
      const handleFirstAssistantResponse = (): void => {
        if (!replaceFromMessageId || replacementCommitted || replacementCommitState.promise) {
          return;
        }
        replacementCommitState.promise = commitReplacement();
      };
      const providerMessages = replaceFromMessageId
        ? this.store.buildReplacementProviderMessages(conversationId, replaceFromMessageId, userMessage.id)
        : this.store.buildProviderMessages(conversationId);
      const assistantMessage = await this.store.beginAssistantMessage(conversationId, {
        reasoningLabel: options.reasoningLabel
      });
      const runtime: LocalAssistantTaskRuntime = {
        appendReasoning: (chunk) => {
          if (!chunk) {
            return;
          }
          if (chunk.trim()) {
            handleFirstAssistantResponse();
          }
          this.store.appendAssistantReasoningChunk(conversationId, assistantMessage.id, chunk);
        },
        appendContent: (chunk) => {
          if (!chunk) {
            return;
          }
          if (chunk.trim()) {
            handleFirstAssistantResponse();
          }
          this.store.appendAssistantChunk(conversationId, assistantMessage.id, chunk);
        },
        appendMetaPanelText: (panel, chunk) => {
          if (!chunk) {
            return;
          }
          if (chunk.trim()) {
            handleFirstAssistantResponse();
          }
          this.store.appendAssistantMetaPanelChunk(conversationId, assistantMessage.id, panel, chunk);
        },
        setMetaPanelSources: (panel, sources) => {
          if (sources.length > 0) {
            handleFirstAssistantResponse();
          }
          this.store.replaceAssistantMetaPanelSources(conversationId, assistantMessage.id, panel, sources);
        },
        buildRequestMessages: (requestContext) => this.withRequestContext(
          providerMessages.map((message) => ({ ...message })),
          userMessage.id,
          requestContext
        ),
        completeModelReply: (messages, modelOptions = {}) => this.collectProviderReply(modelConfig, messages, modelOptions),
        streamModelReply: (messages, modelOptions = {}) => this.streamCollectedProviderReply(modelConfig, messages, modelOptions)
      };

      await task(runtime);
      if (replacementCommitState.promise) {
        await replacementCommitState.promise;
      }
      await this.store.finishAssistantMessage(conversationId, assistantMessage.id);
      await commitReplacement();
    } catch (error) {
      if (replaceSnapshot && !replacementCommitted) {
        await this.store.restoreConversationSnapshot(replaceSnapshot);
      } else {
        const currentConversation = this.store.getConversation(conversationId);
        const latestAssistantMessage = currentConversation?.messages[currentConversation.messages.length - 1] ?? null;
        if (latestAssistantMessage?.role === "assistant" && latestAssistantMessage.status === "streaming") {
          const message = error instanceof Error ? error.message : "本地回复失败。";
          await this.store.failAssistantMessage(conversationId, latestAssistantMessage.id, message);
        }
      }
      throw error;
    }
  }

  private isCurrentStream(stream: ActiveStream): boolean {
    return this.activeStream === stream && !stream.forceStopped;
  }

  private withRequestContext(
    messages: MessageRecord[],
    userMessageId: string,
    requestContext: string | null | undefined
  ): MessageRecord[] {
    const context = requestContext?.trim();
    if (!context) {
      return messages;
    }

    return messages.map((message) => {
      if (message.id !== userMessageId) {
        return message;
      }

      return {
        ...message,
        text: [
          context,
          "",
          "用户原始消息：",
          message.text
        ].join("\n")
      };
    });
  }

  private clearStopFallbackTimer(stream: ActiveStream): void {
    if (stream.stopFallbackTimer === null) {
      return;
    }

    window.clearTimeout(stream.stopFallbackTimer);
    stream.stopFallbackTimer = null;
  }

  private async collectProviderReply(
    modelConfig: ResolvedModelConfig,
    requestMessages: MessageRecord[],
    options: {
      webSearchMode?: WebSearchMode;
      reasoningMode?: ReasoningMode;
    } = {}
  ): Promise<{
    contentText: string;
    reasoningText: string;
  }> {
    const { contentText, reasoningText } = await this.streamCollectedProviderReply(modelConfig, requestMessages, options);
    return { contentText, reasoningText };
  }

  private async streamCollectedProviderReply(
    modelConfig: ResolvedModelConfig,
    requestMessages: MessageRecord[],
    options: {
      webSearchMode?: WebSearchMode;
      reasoningMode?: ReasoningMode;
      onReasoningChunk?: (chunk: string, state: { contentText: string; reasoningText: string }) => void;
      onContentChunk?: (chunk: string, state: { contentText: string; reasoningText: string }) => void;
      shouldStop?: (state: { contentText: string; reasoningText: string }) => boolean;
    } = {}
  ): Promise<{
    contentText: string;
    reasoningText: string;
    stoppedEarly: boolean;
  }> {
    const apiKey = this.getApiKey(modelConfig.id);
    if (!apiKey) {
      throw new Error("请先在模型设置里填写这条模型的 API Key。");
    }

    const abortController = new AbortController();
    let contentText = "";
    let reasoningText = "";
    let stoppedEarly = false;

    try {
      for await (const chunk of this.provider.streamReply({
        apiKey,
        baseUrl: modelConfig.baseUrl,
        modelProviderId: modelConfig.providerId,
        model: modelConfig.model,
        webSearchMode: options.webSearchMode ?? "off",
        reasoningMode: options.reasoningMode ?? (modelConfig.reasoningEnabled ? "high" : "off"),
        reasoningCompatibilityMode: modelConfig.reasoningCompatibilityMode,
        messages: requestMessages,
        signal: abortController.signal
      })) {
        if (chunk.type === "reasoning") {
          reasoningText += chunk.text;
          options.onReasoningChunk?.(chunk.text, {
            contentText,
            reasoningText
          });
        } else {
          contentText += chunk.text;
          options.onContentChunk?.(chunk.text, {
            contentText,
            reasoningText
          });
        }

        if (options.shouldStop?.({ contentText, reasoningText })) {
          stoppedEarly = true;
          abortController.abort();
          break;
        }
      }
    } catch (error) {
      if (!(stoppedEarly && error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }
    }

    return {
      contentText,
      reasoningText,
      stoppedEarly
    };
  }

  private async streamAssistantResponse(
    conversationId: string,
    modelConfig: ResolvedModelConfig,
    apiKey: string,
    requestMessages: MessageRecord[],
    options: StreamAssistantOptions = {}
  ): Promise<void> {
    const assistantMessage = await this.store.beginAssistantMessage(conversationId);
    let firstAssistantResponseHandled = false;
    const handleFirstAssistantResponse = async (): Promise<void> => {
      if (firstAssistantResponseHandled) {
        return;
      }
      firstAssistantResponseHandled = true;
      await options.onFirstAssistantResponse?.();
    };
    const stream: ActiveStream = {
      conversationId,
      assistantMessageId: assistantMessage.id,
      abortController: new AbortController(),
      forceStopped: false,
      stopFallbackTimer: null,
      settled: Promise.resolve(),
      resolveSettled: () => undefined,
      replaceSnapshot: options.replaceSnapshot ?? null,
      isReplacementCommitted: options.isReplacementCommitted ?? null
    };
    stream.settled = new Promise<void>((resolve) => {
      stream.resolveSettled = resolve;
    });
    this.activeStream = stream;

    try {
      for await (const chunk of this.provider.streamReply({
        apiKey,
        baseUrl: modelConfig.baseUrl,
        modelProviderId: modelConfig.providerId,
        model: modelConfig.model,
        webSearchMode: "off",
        reasoningMode: modelConfig.reasoningEnabled ? "high" : "off",
        reasoningCompatibilityMode: modelConfig.reasoningCompatibilityMode,
        messages: requestMessages,
        signal: stream.abortController.signal
      })) {
        if (!this.isCurrentStream(stream)) {
          return;
        }
        if (chunk.type === "reasoning") {
          if (chunk.text.trim()) {
            await handleFirstAssistantResponse();
          }
          this.store.appendAssistantReasoningChunk(conversationId, assistantMessage.id, chunk.text);
          continue;
        }
        if (chunk.text.trim()) {
          await handleFirstAssistantResponse();
        }
        this.store.appendAssistantChunk(conversationId, assistantMessage.id, chunk.text);
      }

      if (!this.isCurrentStream(stream)) {
        return;
      }
      await this.store.finishAssistantMessage(conversationId, assistantMessage.id);
    } catch (error) {
      if (!this.isCurrentStream(stream)) {
        return;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        if (options.replaceSnapshot && !options.isReplacementCommitted?.()) {
          await this.store.restoreConversationSnapshot(options.replaceSnapshot);
          return;
        }
        const latest = this.store.getConversation(conversationId)?.messages.find(
          (message) => message.id === assistantMessage.id
        );
        if (latest && (latest.text.trim().length > 0 || latest.reasoningText?.trim())) {
          await this.store.finishAssistantMessage(conversationId, assistantMessage.id);
        } else {
          await this.store.removeMessage(conversationId, assistantMessage.id);
        }
        return;
      }

      const message = error instanceof Error ? error.message : "请求失败，请稍后再试。";
      if (!options.replaceSnapshot || options.isReplacementCommitted?.()) {
        await this.store.failAssistantMessage(conversationId, assistantMessage.id, message);
      }
      throw error;
    } finally {
      this.clearStopFallbackTimer(stream);
      if (this.activeStream === stream) {
        this.activeStream = null;
      }
      stream.resolveSettled();
    }
  }

  private async forceStopStream(stream: ActiveStream): Promise<void> {
    if (this.activeStream !== stream) {
      return;
    }

    stream.forceStopped = true;
    this.clearStopFallbackTimer(stream);
    const latest = this.store.getConversation(stream.conversationId)?.messages.find(
      (message) => message.id === stream.assistantMessageId
    );

    try {
      if (stream.replaceSnapshot && !stream.isReplacementCommitted?.()) {
        await this.store.restoreConversationSnapshot(stream.replaceSnapshot);
      } else if (latest && (latest.text.trim().length > 0 || latest.reasoningText?.trim())) {
        await this.store.finishAssistantMessage(stream.conversationId, stream.assistantMessageId);
      } else if (latest) {
        await this.store.removeMessage(stream.conversationId, stream.assistantMessageId);
      }
    } finally {
      if (this.activeStream === stream) {
        this.activeStream = null;
      }
    }
  }
}
