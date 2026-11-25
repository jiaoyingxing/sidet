import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, MODEL_PRESETS } from "../constants";
import type { MessageRecord, ModelConfigRecord } from "../types";

/** 模型预设的上下文窗口；自定义模型回退到保守默认值。 */
export function resolveModelContextWindowTokens(
  modelConfig: Pick<ModelConfigRecord, "providerId" | "presetId" | "model">
): number {
  const preset = (modelConfig.presetId
    ? MODEL_PRESETS.find((item) => item.id === modelConfig.presetId)
    : undefined)
    ?? MODEL_PRESETS.find((item) => {
      return item.providerId === modelConfig.providerId && item.model === modelConfig.model;
    });
  return preset?.contextWindowTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
}

export interface ProviderContextBudgetOptions {
  maxChars: number;
  reservedChars: number;
  imageCostChars: number;
}

export interface ProviderContextBudgetResult {
  messages: MessageRecord[];
  omittedCount: number;
  truncated: boolean;
}

/**
 * 字符近似成本：正文按长度；图片按固定成本（data URL 长度不等于模型 token 成本）；
 * Markdown / 网页附件按 content 长度。reasoning / metaPanels / sources 不发给 provider。
 */
export function estimateProviderMessageChars(
  message: MessageRecord,
  imageCostChars: number
): number {
  let total = message.text.length;
  for (const attachment of message.attachments ?? []) {
    if (attachment.type === "image") {
      total += imageCostChars;
      continue;
    }
    total += attachment.content.length;
  }
  return total;
}

/**
 * 从最新消息往前装填，超出预算时省略更早的消息。
 *
 * - 最后一条消息（当前用户消息）无论多大都保留；单条超大消息仍可能被模型拒绝，
 *   由发送侧另行处理。
 * - 选出的切片必须以 user 消息开头；预算边界落在 assistant 中间时丢掉孤立前缀。
 */
export function trimProviderMessagesForBudget(
  messages: readonly MessageRecord[],
  options: ProviderContextBudgetOptions
): ProviderContextBudgetResult {
  if (messages.length === 0) {
    return { messages: [], omittedCount: 0, truncated: false };
  }

  const budget = Math.max(0, options.maxChars - options.reservedChars);
  let totalChars = 0;
  let startIndex = messages.length;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageChars = estimateProviderMessageChars(messages[index], options.imageCostChars);
    const isLastMessage = index === messages.length - 1;
    if (!isLastMessage && totalChars + messageChars > budget) {
      break;
    }
    totalChars += messageChars;
    startIndex = index;
  }

  while (startIndex < messages.length - 1 && messages[startIndex].role !== "user") {
    startIndex += 1;
  }

  return {
    messages: messages.slice(startIndex),
    omittedCount: startIndex,
    truncated: startIndex > 0
  };
}
