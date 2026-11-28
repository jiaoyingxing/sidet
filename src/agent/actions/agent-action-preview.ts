import { App, normalizePath, TFile } from "obsidian";
import {
  DEFAULT_AGENT_DRAFT_FOLDER,
  DEFAULT_WEB_CLIPPING_FOLDER
} from "../../constants";
import {
  extractWebpageAttachmentMarkdown,
  stripLeadingWebpageTitle
} from "../../context/webpage-attachment-markdown";
import { sanitizeFileName } from "../../shared/paths";
import { formatDateTime, formatFileDatePrefix, formatFileTimestamp } from "../../shared/time";
import type { ConversationRecord, MessageRecord, WebpageMessageAttachment } from "../../types";
import type { AgentActionPreview } from "./agent-action";
import { stripSidetActionAndFollowing } from "./agent-tool-protocol";
import { stripSidetProtocolBlocks } from "../web-search/sidet-protocol";

function normalizeMarkdown(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function startsWithMarkdownHeading(markdown: string): boolean {
  const firstLine = markdown.split("\n").find((line) => line.trim().length > 0) ?? "";
  return /^#{1,6}\s+/.test(firstLine.trim());
}

function getLatestAssistantMessage(conversation: ConversationRecord): MessageRecord | null {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role !== "assistant" || message.status !== "done" || !message.text.trim()) {
      continue;
    }
    // 动作 / 工具协议块不能写进笔记：对话里的最近回复可能就是一张写入卡，
    // 保存 / 追加 / 整理时必须只用用户实际看到的正文。
    const text = stripSidetActionAndFollowing(stripSidetProtocolBlocks(message.text)).trim();
    if (!text) {
      return null;
    }
    return { ...message, text };
  }

  return null;
}

function extractFirstHeading(markdown: string): string | null {
  return markdown.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function stripMatchingLeadingHeading(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex < 0) {
    return markdown;
  }

  const firstLine = lines[firstContentIndex].trim();
  const match = firstLine.match(/^#{1,2}\s+(.+)$/);
  if (!match || match[1]?.trim() !== heading) {
    return markdown;
  }

  lines.splice(firstContentIndex, 1);
  return lines.join("\n").trim();
}

function countExactOccurrences(text: string, pattern: string): number {
  if (!pattern) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (offset <= text.length) {
    const index = text.indexOf(pattern, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    if (count > 1) {
      return count;
    }
    offset = index + pattern.length;
  }
  return count;
}

function resolveWebpageClipTitle(attachment: WebpageMessageAttachment): string {
  const rawTitle = attachment.name.trim();
  if (rawTitle) {
    return rawTitle;
  }

  try {
    return new URL(attachment.url).hostname;
  } catch {
    return "网页剪藏";
  }
}

function buildDatePrefixedFileName(title: string, timestamp: number): string {
  return sanitizeFileName(`${formatFileDatePrefix(timestamp)} ${title}`);
}

async function findAvailablePath(app: App, preferredPath: string): Promise<string> {
  const normalized = normalizePath(preferredPath);
  if (!app.vault.getAbstractFileByPath(normalized)) {
    return normalized;
  }

  const suffix = formatFileTimestamp(Date.now());
  return normalized.replace(/\.md$/i, `-${suffix}.md`);
}

export class AgentActionPreviewService {
  constructor(private readonly app: App) {}

  async buildCreateNoteFromLatestAssistant(conversation: ConversationRecord | null): Promise<AgentActionPreview> {
    if (!conversation) {
      throw new Error("当前没有可保存的 Sidet 对话。");
    }

    const message = getLatestAssistantMessage(conversation);
    if (!message) {
      throw new Error("当前对话还没有可保存的 AI 回复。");
    }

    const rawMarkdown = normalizeMarkdown(message.text);
    const heading = extractFirstHeading(rawMarkdown);
    const noteTitle = heading || conversation.title || "Sidet 草稿笔记";
    const body = heading ? stripMatchingLeadingHeading(rawMarkdown, heading) : rawMarkdown;
    const createdAt = Date.now();
    const targetPath = await findAvailablePath(
      this.app,
      `${DEFAULT_AGENT_DRAFT_FOLDER}/${buildDatePrefixedFileName(noteTitle, createdAt)}.md`
    );
    const created = formatDateTime(createdAt);
    const content = [
      `# ${noteTitle}`,
      "",
      "> [!info] Sidet 来源",
      `> 对话：${conversation.title || "未命名对话"}`,
      `> 对话 ID：${conversation.id}`,
      `> 创建时间：${created}`,
      "",
      body
    ].join("\n").trim() + "\n";

    return {
      kind: "create-note",
      title: "创建草稿笔记",
      targetPath,
      content,
      sourceLabel: `最近一条 AI 回复 · ${conversation.title || "未命名对话"}`,
      riskNotes: [
        "只会在确认后创建一篇新 Markdown 笔记。",
        "不会修改原始笔记、不会删除对话、不会自动写入长期记忆。",
        "如果目标路径已存在，需要改名后再创建。"
      ],
      confirmLabel: "确认创建",
      successMessage: "已创建草稿笔记"
    };
  }

  async buildCreateNoteFromWebpageAttachment(
    attachment: WebpageMessageAttachment
  ): Promise<AgentActionPreview> {
    const displayTitle = resolveWebpageClipTitle(attachment);
    const capturedAtMs = Date.now();
    const fileTitle = buildDatePrefixedFileName(displayTitle, capturedAtMs);
    const targetPath = await findAvailablePath(
      this.app,
      `${DEFAULT_WEB_CLIPPING_FOLDER}/${fileTitle}.md`
    );
    const capturedAt = formatDateTime(capturedAtMs);
    const body = stripLeadingWebpageTitle(
      extractWebpageAttachmentMarkdown(attachment.content),
      displayTitle
    );
    const content = [
      "> [!info] 网页剪藏",
      `> 来源：${attachment.url}`,
      `> 抓取时间：${capturedAt}`,
      body ? `\n${body}` : ""
    ].join("\n").trim() + "\n";

    return {
      kind: "create-note",
      title: "保存网页为 Markdown",
      targetPath,
      content,
      contentLabel: "网页 Markdown 内容",
      sourceLabel: `网页附件 · ${displayTitle}`,
      riskNotes: [
        "只会在确认后创建一篇新的 Markdown 网页剪藏。",
        `默认保存到 ${DEFAULT_WEB_CLIPPING_FOLDER}，确认前可以改路径或改正文。`,
        "不会重新抓取网页、不会调用 AI 总结、不会修改现有草稿或网页剪藏文件。"
      ],
      confirmLabel: "确认保存",
      successMessage: "已保存网页剪藏"
    };
  }

  async buildAppendLatestAssistantToMarkdown(
    conversation: ConversationRecord | null,
    file: TFile
  ): Promise<AgentActionPreview> {
    if (!conversation) {
      throw new Error("当前没有可追加的 Sidet 对话。");
    }

    const message = getLatestAssistantMessage(conversation);
    if (!message) {
      throw new Error("当前对话还没有可追加的 AI 回复。");
    }

    const rawMarkdown = normalizeMarkdown(message.text);
    const heading = extractFirstHeading(rawMarkdown);
    const title = heading || "Sidet 追加";
    const body = heading ? stripMatchingLeadingHeading(rawMarkdown, heading) : rawMarkdown;
    const created = formatDateTime(Date.now());
    const content = [
      `## ${title} · ${created}`,
      "",
      "> [!info] Sidet 来源",
      `> 对话：${conversation.title || "未命名对话"}`,
      `> 对话 ID：${conversation.id}`,
      `> 追加时间：${created}`,
      "",
      body
    ].join("\n").trim() + "\n";

    return {
      kind: "append-note",
      title: "追加到现有笔记",
      targetPath: file.path,
      content,
      sourceLabel: `最近一条 AI 回复 -> ${file.path}`,
      riskNotes: [
        "只会在确认后把内容追加到目标 Markdown 笔记末尾。",
        "不会替换原文、不会修改其他文件、不会自动整理整篇笔记。",
        "如果目标路径不存在或不是 Markdown 文件，会拒绝追加。"
      ],
      confirmLabel: "确认追加",
      successMessage: "已追加到笔记"
    };
  }

  async buildReplaceSelectionWithLatestAssistant(
    conversation: ConversationRecord | null,
    file: TFile,
    selectionText: string
  ): Promise<AgentActionPreview> {
    if (!conversation) {
      throw new Error("当前没有可用于替换的 Sidet 对话。");
    }

    const message = getLatestAssistantMessage(conversation);
    if (!message) {
      throw new Error("当前对话还没有可用于替换的 AI 回复。");
    }

    const normalizedSelection = normalizeLineEndings(selectionText);
    if (!normalizedSelection.trim()) {
      throw new Error("当前没有可替换的选区。");
    }

    const existing = await this.app.vault.cachedRead(file);
    if (countExactOccurrences(existing, normalizedSelection) !== 1) {
      throw new Error("选区文本在目标笔记中不是唯一匹配，暂不生成替换预览。");
    }

    const rawMarkdown = normalizeMarkdown(message.text);
    return {
      kind: "replace-selection",
      title: "替换当前选区",
      targetPath: file.path,
      targetPathEditable: false,
      content: rawMarkdown,
      contentLabel: "替换后的内容",
      sourceLabel: `最近一条 AI 回复 -> ${file.path}`,
      selectionText: normalizedSelection,
      riskNotes: [
        "只会在确认后替换目标笔记中的当前选区。",
        "选区文本必须在目标笔记中唯一匹配；如果不唯一，会拒绝替换。",
        "不会修改其他文件、不会全文重写、不会自动整理整篇笔记。"
      ],
      confirmLabel: "确认替换",
      successMessage: "已替换当前选区"
    };
  }

  async buildReplaceSectionWithLatestAssistant(
    conversation: ConversationRecord | null,
    file: TFile,
    heading: string,
    headingLine: string,
    sectionText: string
  ): Promise<AgentActionPreview> {
    if (!conversation) {
      throw new Error("当前没有可用于替换的 Sidet 对话。");
    }

    const message = getLatestAssistantMessage(conversation);
    if (!message) {
      throw new Error("当前对话还没有可用于替换的 AI 回复。");
    }

    const normalizedSection = normalizeLineEndings(sectionText);
    if (!normalizedSection.trim()) {
      throw new Error("当前没有可替换的小节。");
    }

    const existing = await this.app.vault.cachedRead(file);
    if (countExactOccurrences(existing, normalizedSection) !== 1) {
      throw new Error("小节文本在目标笔记中不是唯一匹配，暂不生成替换预览。");
    }

    const rawMarkdown = normalizeMarkdown(message.text);
    const content = startsWithMarkdownHeading(rawMarkdown)
      ? rawMarkdown
      : `${headingLine}\n\n${rawMarkdown}`;
    return {
      kind: "replace-section",
      title: "替换当前小节",
      targetPath: file.path,
      targetPathEditable: false,
      content,
      contentLabel: "替换后的小节",
      sourceLabel: `最近一条 AI 回复 -> ${file.path} · ${heading}`,
      selectionText: normalizedSection,
      riskNotes: [
        "只会在确认后替换目标笔记中的当前 Markdown 小节。",
        "小节文本必须在目标笔记中唯一匹配；如果不唯一，会拒绝替换。",
        "不会修改其他文件、不会全文重写、不会自动整理整篇笔记。"
      ],
      confirmLabel: "确认替换",
      successMessage: "已替换当前小节"
    };
  }
}
