import type { MessageAttachment } from "../../types";

export type SidetFileToolPromptMode = "off" | "compact" | "full";

const FILE_TOOL_FULL_INTENT_PATTERNS: RegExp[] = [
  /保存(?:成|为)?(?:一篇|一份)?笔记/,
  /保存对话/,
  /写入/,
  /写到/,
  /落盘/,
  // “整理成一篇笔记 / 写一份笔记 / 做成一篇笔记”：中间常有量词，不能只匹配紧邻写法。
  /(?:整理|写|生成|创建|保存|做成|变成)(?:成|为|到)?(?:一篇|一份|一个)?[^，。；\n]{0,8}笔记/,
  /整理成笔记/,
  /新建.*笔记/,
  /创建.*笔记/,
  /生成.*笔记/,
  /再(?:帮我)?(?:创建|写|保存|生成|整理)/,
  /(?:创建|写|保存|生成)一条/,
  /一条.*笔记/,
  /我要写入/,
  /写入.*笔记/,
  /追加/,
  /覆盖/,
  /替换/,
  /更新.*笔记/i,
  /create_note/i,
  /append_note/i,
  /replace_note/i
];

const FILE_TOOL_FULL_CONTEXT_PREFIX_PATTERNS: RegExp[] = [
  /^执行模式：/m,
  /单条写入草稿/,
  /sidet-action/i
];

function normalizePromptContextText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildSidetCurrentDateContext(now: Date = new Date()): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][now.getDay()];
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absoluteOffsetMinutes / 60));
  const offsetRemainderMinutes = pad(absoluteOffsetMinutes % 60);
  const formattedDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const formattedTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  return [
    `当前时间：${formattedDate} ${weekday} ${formattedTime} (UTC${offsetSign}${offsetHours}:${offsetRemainderMinutes})。`,
    "如果用户提到今天、明天、昨天、最近、最新，请按这个时间理解。"
  ].join("\n");
}

export function resolveSidetFileToolPromptMode(input: {
  text: string;
  attachments?: MessageAttachment[];
  requestContextPrefix?: string | null;
}): SidetFileToolPromptMode {
  const contentText = normalizePromptContextText([
    input.text,
    ...(input.attachments ?? []).map((attachment) => attachment.name)
  ]
    .join("\n")
  );
  const requestContextPrefix = normalizePromptContextText(input.requestContextPrefix ?? "");

  if (!contentText && !requestContextPrefix) {
    return "off";
  }

  if (requestContextPrefix && FILE_TOOL_FULL_CONTEXT_PREFIX_PATTERNS.some((pattern) => pattern.test(requestContextPrefix))) {
    return "full";
  }

  return FILE_TOOL_FULL_INTENT_PATTERNS.some((pattern) => pattern.test(contentText))
    ? "full"
    : "compact";
}

export function joinSidetRequestContexts(...contexts: Array<string | null | undefined>): string | null {
  const seen = new Set<string>();
  const normalized = contexts
    .map((context) => context?.trim() ?? "")
    .filter(Boolean)
    .filter((context) => {
      if (seen.has(context)) {
        return false;
      }
      seen.add(context);
      return true;
    });

  return normalized.length > 0 ? normalized.join("\n\n") : null;
}
