import type { ConversationRecord, MessageRecord } from "../types";
import { getAssistantDisplayText } from "./assistant-visible-text";

export interface ConversationMessageSearchRange {
  start: number;
  end: number;
}

export interface ConversationMessageSearchHit {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  role: "user" | "assistant";
  snippet: string;
  matchRanges: ConversationMessageSearchRange[];
  messageCreatedAt: number;
  updatedAt: number;
  folderId: string | null;
  folderName: string | null;
  isArchived: boolean;
}

export interface ConversationMessageSearchOptions {
  limit?: number;
  perConversationLimit?: number;
  includeArchived?: boolean;
  folderNames?: ReadonlyMap<string, string>;
}

const DEFAULT_RESULT_LIMIT = 30;
const DEFAULT_PER_CONVERSATION_LIMIT = 3;
const SNIPPET_LEADING_CHARS = 40;
const SNIPPET_TRAILING_CHARS = 60;
const MAX_SNIPPET_RANGES = 30;

/** 标题与正文共用一套词法：空白分词、大小写不敏感、所有词都命中。 */
export function normalizeConversationSearchTerms(query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return [];
  }
  return Array.from(new Set(normalized.split(/\s+/).filter((term) => term.length > 0)));
}

export function matchesConversationSearchQuery(text: string, query: string): boolean {
  const terms = normalizeConversationSearchTerms(query);
  if (terms.length === 0) {
    return true;
  }
  const normalizedText = normalizeSearchWhitespace(text).toLocaleLowerCase();
  return terms.every((term) => normalizedText.includes(term));
}

/**
 * 在内存中的会话记录里搜索消息正文。
 *
 * 只读当前激活版本（MessageRecord 主字段）；assistant 文本先去掉协议块和
 * 工具动作块，与界面显示口径一致。结果按会话更新时间倒序，再按消息生成时间
 * 倒序；默认单会话 3 条、总计 30 条，可通过 options 调整。
 */
export function searchConversationMessages(
  conversations: Iterable<ConversationRecord>,
  query: string,
  options: ConversationMessageSearchOptions = {}
): ConversationMessageSearchHit[] {
  const terms = normalizeConversationSearchTerms(query);
  if (terms.length === 0) {
    return [];
  }

  const limit = Math.max(1, options.limit ?? DEFAULT_RESULT_LIMIT);
  const perConversationLimit = Math.max(1, options.perConversationLimit ?? DEFAULT_PER_CONVERSATION_LIMIT);
  const orderedConversations = Array.from(conversations)
    .filter((conversation) => options.includeArchived === true || !conversation.isArchived)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const hits: ConversationMessageSearchHit[] = [];
  for (const conversation of orderedConversations) {
    if (hits.length >= limit) {
      break;
    }

    let conversationHitCount = 0;
    for (let messageIndex = conversation.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      if (hits.length >= limit || conversationHitCount >= perConversationLimit) {
        break;
      }
      const message = conversation.messages[messageIndex];
      const searchableText = getSearchableMessageText(message);
      if (!searchableText) {
        continue;
      }
      const matchRanges = findTermRanges(searchableText, terms);
      if (matchRanges.length === 0) {
        continue;
      }
      const firstRange = matchRanges[0];
      const snippet = buildSearchSnippet(searchableText, firstRange, matchRanges);

      hits.push({
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        messageId: message.id,
        role: message.role === "assistant" ? "assistant" : "user",
        snippet: snippet.text,
        matchRanges: snippet.ranges,
        messageCreatedAt: message.createdAt,
        updatedAt: conversation.updatedAt,
        folderId: conversation.folderId ?? null,
        folderName: conversation.folderId
          ? options.folderNames?.get(conversation.folderId) ?? null
          : null,
        isArchived: conversation.isArchived
      });
      conversationHitCount += 1;
    }
  }

  return hits;
}

function getSearchableMessageText(message: MessageRecord): string {
  if (message.role !== "user" && message.role !== "assistant") {
    return "";
  }
  const rawText = message.role === "assistant"
    ? stripMarkdownNoise(getAssistantDisplayText(message))
    : message.text;
  return normalizeSearchWhitespace(rawText);
}

/** 片段是给人看的单行文本；去掉标题记号、围栏和链接目标，保留链接文字。 */
function stripMarkdownNoise(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function normalizeSearchWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function findTermRanges(text: string, terms: readonly string[]): ConversationMessageSearchRange[] {
  const ranges: ConversationMessageSearchRange[] = [];
  for (const term of terms) {
    const pattern = new RegExp(escapeRegExp(term), "giu");
    let termMatched = false;
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      ranges.push({ start, end: start + match[0].length });
      termMatched = true;
    }
    if (!termMatched) {
      return [];
    }
  }
  return mergeRanges(ranges).sort((left, right) => left.start - right.start);
}

function buildSearchSnippet(
  text: string,
  firstRange: ConversationMessageSearchRange,
  allRanges: readonly ConversationMessageSearchRange[]
): { text: string; ranges: ConversationMessageSearchRange[] } {
  const start = Math.max(0, firstRange.start - SNIPPET_LEADING_CHARS);
  const end = Math.min(text.length, firstRange.end + SNIPPET_TRAILING_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const snippetText = `${prefix}${text.slice(start, end)}${suffix}`;
  const ranges: ConversationMessageSearchRange[] = [];

  for (const range of allRanges) {
    if (range.end <= start || range.start >= end) {
      continue;
    }
    const clippedStart = Math.max(range.start, start);
    const clippedEnd = Math.min(range.end, end);
    if (clippedEnd <= clippedStart) {
      continue;
    }
    ranges.push({
      start: clippedStart - start + prefix.length,
      end: clippedEnd - start + prefix.length
    });
    if (ranges.length >= MAX_SNIPPET_RANGES) {
      break;
    }
  }

  return {
    text: snippetText,
    ranges: mergeRanges(ranges)
  };
}

function mergeRanges(ranges: readonly ConversationMessageSearchRange[]): ConversationMessageSearchRange[] {
  if (ranges.length <= 1) {
    return ranges.map((range) => ({ ...range }));
  }
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ConversationMessageSearchRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
