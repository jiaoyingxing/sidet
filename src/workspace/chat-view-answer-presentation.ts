import type { ConversationRecord, MessageRecord, MessageSource } from "../types";

export type AnswerActionKind =
  | "copy"
  | "regenerate"
  | "more"
  | "retry"
  | "copy-error"
  | "open-settings";

export type AnswerPresentationMode = "none" | "done" | "error";

export interface AnswerActionPlan {
  mode: AnswerPresentationMode;
  actions: AnswerActionKind[];
}

export type CitationSegment =
  | { type: "text"; text: string }
  | { type: "citation"; index: number; raw: string };

export type AssistantErrorKind =
  | "auth"
  | "network"
  | "timeout"
  | "rate-limit"
  | "protocol"
  | "unknown";

export interface AssistantErrorPresentation {
  kind: AssistantErrorKind;
  title: string;
  reason: string;
  actions: AnswerActionKind[];
}

export interface AnswerVersionInfo {
  total: number;
  index: number;
  hasMultiple: boolean;
  label: string;
}

/**
 * 回答版本只挂在 assistant 消息上；主字段是当前版本，
 * answerVariants 是其余版本。非法下标回退到最新版本。
 */
export function getAnswerVersionInfo(message: MessageRecord): AnswerVersionInfo {
  const total = (message.answerVariants?.length ?? 0) + 1;
  const rawIndex = message.activeAnswerVariantIndex;
  const index = total > 1
    && typeof rawIndex === "number"
    && Number.isInteger(rawIndex)
    && rawIndex >= 0
    && rawIndex < total
    ? rawIndex
    : total - 1;

  return {
    total,
    index,
    hasMultiple: total > 1,
    label: `${index + 1} / ${total}`
  };
}

const CITATION_PATTERN = /\[(\d{1,3})\]/g;

/**
 * 回答底部的操作排只放当前状态真正可执行的动作。
 *
 * - 正常完成：复制、更多；最新一条再加重新生成。
 * - 失败：重试、复制错误信息；错误类型需要设置时再加去设置。
 * - 流式中不渲染操作排，停止按钮仍在 composer。
 */
export function getAnswerActionPlan(message: MessageRecord): AnswerActionPlan {
  if (message.role !== "assistant" || message.status === "streaming") {
    return { mode: "none", actions: [] };
  }

  if (message.status === "error") {
    const error = classifyAssistantError(message.errorText ?? message.text);
    return {
      mode: "error",
      actions: error.actions
    };
  }

  return {
    mode: "done",
    actions: ["copy", "regenerate", "more"]
  };
}

export function isLatestAssistantMessage(
  conversationMessages: readonly MessageRecord[],
  message: MessageRecord
): boolean {
  const last = conversationMessages[conversationMessages.length - 1];
  return Boolean(last && last.id === message.id && last.role === "assistant");
}

export interface RegenerateAnswerTarget {
  userMessage: MessageRecord;
  variantOfMessageId: string | null;
}

/**
 * 最后一条回答重新生成的目标：复用最后一条用户消息；旧回答已完成时保留为版本。
 * 归档检查留在控制器，因为这里只处理会话内的消息结构。
 */
export function resolveRegenerateAnswerTarget(conversation: ConversationRecord): RegenerateAnswerTarget {
  const lastMessage = conversation.messages[conversation.messages.length - 1] ?? null;
  if (!lastMessage || lastMessage.role !== "assistant" || lastMessage.status === "streaming") {
    throw new Error("只有最后一条已完成的回答可以重新生成。");
  }

  let userMessage: MessageRecord | null = null;
  for (let index = conversation.messages.length - 2; index >= 0; index -= 1) {
    const candidate = conversation.messages[index];
    if (candidate.role === "user") {
      userMessage = candidate;
      break;
    }
  }
  if (!userMessage) {
    throw new Error("没有找到可重新发送的用户消息。");
  }
  if (userMessage.knowledgeBaseRouting) {
    throw new Error("知识库检索结果暂不支持重新生成。");
  }

  const keepPreviousAnswer = lastMessage.status === "done"
    || (lastMessage.answerVariants?.length ?? 0) > 0;
  return {
    userMessage,
    variantOfMessageId: keepPreviousAnswer ? lastMessage.id : null
  };
}

export function hasPartialErrorContent(message: MessageRecord): boolean {
  if (message.status !== "error" || !message.text.trim()) {
    return false;
  }
  const errorText = message.errorText?.trim();
  return Boolean(errorText) && message.text.trim() !== errorText;
}

export function getSourceSummary(sources: readonly MessageSource[]): {
  total: number;
  fullCount: number;
  summaryCount: number;
  label: string;
} {
  const total = sources.length;
  const fullCount = sources.filter((source) => source.readDepth === "full").length;
  const summaryCount = total - fullCount;
  let label = "";
  if (total > 0) {
    if (fullCount > 0 && summaryCount > 0) {
      label = `${fullCount} 篇已读全文 · ${summaryCount} 条摘要`;
    } else if (fullCount > 0) {
      label = `${fullCount} 篇已读全文`;
    } else {
      label = `${summaryCount} 条摘要 · 未逐页核对`;
    }
  }
  return { total, fullCount, summaryCount, label };
}

/** 把正文里的 [n] 拆成可渲染的片段；未知编号仍按普通文字保留。 */
export function splitCitationSegments(
  text: string,
  sourceCount: number
): CitationSegment[] {
  const segments: CitationSegment[] = [];
  let cursor = 0;
  CITATION_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const raw = match[0];
    const index = Number.parseInt(match[1], 10);
    const start = match.index ?? 0;
    if (!Number.isSafeInteger(index) || index < 1 || index > sourceCount) {
      continue;
    }
    if (start > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, start) });
    }
    segments.push({ type: "citation", index, raw });
    cursor = start + raw.length;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ type: "text", text }];
}

export function classifyAssistantError(errorText: string): AssistantErrorPresentation {
  const text = errorText.toLowerCase();

  if (
    /api key|apikey|密钥|401|403|unauthorized|authentication|未填写.*key|模型设置/.test(text)
  ) {
    return {
      kind: "auth",
      title: "模型没有配置好",
      reason: "这条模型缺少 API Key，或 Key 已失效。",
      actions: ["open-settings", "retry", "copy-error"]
    };
  }

  if (/429|rate limit|too many|请求过于频繁|限流|频率/.test(text)) {
    return {
      kind: "rate-limit",
      title: "请求太频繁",
      reason: "稍等片刻再试。",
      actions: ["retry", "copy-error"]
    };
  }

  if (/timeout|timed out|超时|等待生成超时/.test(text)) {
    return {
      kind: "timeout",
      title: "模型响应超时",
      reason: "等待时间过长。",
      actions: ["retry", "copy-error"]
    };
  }

  if (
    /网络|network|failed to fetch|fetch failed|断网|连接中断|连接失败|econn|socket|dns|offline/.test(text)
  ) {
    return {
      kind: "network",
      title: "网络连接中断",
      reason: "",
      actions: ["retry", "copy-error"]
    };
  }

  if (/协议|protocol|无法识别|无法解析|invalid|malformed|接口未返回|unexpected token/.test(text)) {
    return {
      kind: "protocol",
      title: "服务返回了无法识别的内容",
      reason: "可以重试，或复制错误信息排查。",
      actions: ["retry", "copy-error"]
    };
  }

  return {
    kind: "unknown",
    title: "这次没有生成完成",
    reason: "可以重试；如果反复出现，复制错误信息排查。",
    actions: ["retry", "copy-error"]
  };
}
