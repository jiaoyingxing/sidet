import { stripSidetToolActionBlock } from "../agent/actions/agent-tool-protocol";
import { stripSidetProtocolBlocks } from "../agent/web-search/sidet-protocol";
import type {
  ConversationContextSummary,
  ConversationRecord,
  MessageRecord
} from "../types";

/** 最近多少条消息保持原样，不进入摘要范围。 */
export const CONTEXT_SUMMARY_RAW_MESSAGE_COUNT = 16;
/** 至少积累多少条新旧消息才再调一次摘要模型，避免每轮都多一次请求。 */
export const CONTEXT_SUMMARY_MIN_NEW_MESSAGES = 6;
export const CONTEXT_SUMMARY_MAX_INPUT_CHARS = 16000;
export const CONTEXT_SUMMARY_MAX_OUTPUT_CHARS = 1200;
export const CONTEXT_SUMMARY_TIMEOUT_MS = 20000;

const CONTEXT_SUMMARY_SYSTEM_PROMPT = [
  "你是 Sidet 的对话压缩器。根据已有摘要和新增旧对话，生成一段给后续模型使用的背景摘要。",
  "保留：用户目标、关键事实、已确认决定、未解决问题、用户偏好、重要文件或链接。",
  "不要寒暄，不要编造，不要大段复述原话；用中文，只输出摘要正文。"
].join("");

export interface ContextSummaryRange {
  previousSummary: ConversationContextSummary | null;
  startIndex: number;
  endIndex: number;
  endMessage: MessageRecord;
  messages: MessageRecord[];
}

/**
 * 找出这次要压缩的旧消息区间：锚点之后、原始窗口之前。
 * 新消息不足 CONTEXT_SUMMARY_MIN_NEW_MESSAGES 时不触发，避免每轮多一次模型调用。
 */
export function findContextSummaryRange(conversation: ConversationRecord): ContextSummaryRange | null {
  const rawWindowStart = Math.max(
    0,
    conversation.messages.length - CONTEXT_SUMMARY_RAW_MESSAGE_COUNT
  );
  if (rawWindowStart <= 0) {
    return null;
  }

  const previousSummary = conversation.contextSummary ?? null;
  const previousIndex = previousSummary
    ? conversation.messages.findIndex((message) => {
      return message.id === previousSummary.summarizedThroughMessageId;
    })
    : -1;
  const startIndex = previousIndex >= 0 ? previousIndex + 1 : 0;
  const endIndex = rawWindowStart - 1;
  if (startIndex > endIndex) {
    return null;
  }

  const messages = conversation.messages.slice(startIndex, endIndex + 1);
  if (messages.length < CONTEXT_SUMMARY_MIN_NEW_MESSAGES) {
    return null;
  }

  return {
    previousSummary,
    startIndex,
    endIndex,
    endMessage: conversation.messages[endIndex],
    messages
  };
}

export function buildContextSummaryInput(range: ContextSummaryRange): string {
  const lines: string[] = [];
  if (range.previousSummary?.text.trim()) {
    lines.push("已有背景摘要：", range.previousSummary.text.trim(), "", "新增旧对话：");
  }

  for (const message of range.messages) {
    const rawText = message.role === "assistant"
      ? stripSidetToolActionBlock(stripSidetProtocolBlocks(message.text))
      : message.text;
    const text = rawText.replace(/\s+/g, " ").trim();
    if (text) {
      lines.push(`${message.role === "user" ? "用户" : "Sidet"}：${text}`);
    }
    const attachments = (message.attachments ?? []).map((attachment) => {
      if (attachment.type === "image") {
        return `[图片 ${attachment.name}]`;
      }
      if (attachment.type === "markdown") {
        return `[笔记 ${attachment.name}]`;
      }
      return `[网页 ${attachment.name}]`;
    });
    if (attachments.length > 0) {
      lines.push(`（附件：${attachments.join("，")}）`);
    }
  }

  const input = lines.join("\n").trim();
  if (input.length <= CONTEXT_SUMMARY_MAX_INPUT_CHARS) {
    return input;
  }
  return `（较早内容已省略）\n${input.slice(-CONTEXT_SUMMARY_MAX_INPUT_CHARS)}`;
}

export function buildContextSummaryRequestMessages(input: string): MessageRecord[] {
  return [
    {
      id: "sidet-context-summary-system",
      role: "system",
      text: CONTEXT_SUMMARY_SYSTEM_PROMPT,
      createdAt: 0,
      status: "done"
    },
    {
      id: "sidet-context-summary-input",
      role: "user",
      text: input,
      createdAt: 0,
      status: "done"
    }
  ];
}

export function normalizeContextSummaryText(text: string): string | null {
  const normalized = text
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/```$/gm, "")
    .replace(/^摘要[:：]\s*/, "")
    .trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= CONTEXT_SUMMARY_MAX_OUTPUT_CHARS
    ? normalized
    : `${normalized.slice(0, CONTEXT_SUMMARY_MAX_OUTPUT_CHARS - 1).trimEnd()}…`;
}

/** provider 上下文里的摘要消息；不是会话消息，不展示、不导出。 */
export function buildContextSummaryMessage(
  summary: ConversationContextSummary
): MessageRecord {
  return {
    id: "sidet-context-summary",
    role: "system",
    text: `较早对话摘要：\n${summary.text}`,
    createdAt: summary.updatedAt,
    status: "done"
  };
}

/** 找到摘要锚点，返回摘要消息与锚点之后的原始消息；锚点不存在时返回 null。 */
export function selectProviderMessagesWithContextSummary(
  messages: readonly MessageRecord[],
  summary: ConversationContextSummary
): {
  summaryMessage: MessageRecord;
  recentMessages: MessageRecord[];
} | null {
  const anchorIndex = messages.findIndex((message) => {
    return message.id === summary.summarizedThroughMessageId;
  });
  if (anchorIndex < 0) {
    return null;
  }
  return {
    summaryMessage: buildContextSummaryMessage(summary),
    recentMessages: messages.slice(anchorIndex + 1)
  };
}
