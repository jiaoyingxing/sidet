import { App, Notice, normalizePath } from "obsidian";
import { PLUGIN_NAME } from "../constants";
import { ensureFolder, sanitizeFileName } from "../shared/paths";
import { formatDateTime, formatFileTimestamp } from "../shared/time";
import type { ConversationRecord, DialogPluginSettings, MessageAttachment, MessageRecord } from "../types";

interface ConversationTurn {
  userMessage: MessageRecord;
  followUps: MessageRecord[];
}

function normalizeMessageText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : " ";
}

function buildCallout(calloutType: string, title: string, text: string): string {
  const lines = normalizeMessageText(text).split("\n");
  return [
    `> [!${calloutType}] ${title}`,
    ...lines.map((line) => line.length > 0 ? `> ${line}` : ">")
  ].join("\n");
}

function sanitizeWikilinkPart(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/\[\[/g, "[ [")
    .replace(/\]\]/g, "] ]")
    .trim();
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function buildWikilink(target: string, alias?: string): string {
  const safeTarget = sanitizeWikilinkPart(target);
  const safeAlias = alias ? sanitizeWikilinkPart(alias) : "";
  if (!safeAlias || safeAlias === safeTarget) {
    return `[[${safeTarget}]]`;
  }
  return `[[${safeTarget}|${safeAlias}]]`;
}

function formatAttachmentReference(attachment: MessageAttachment): string {
  if (attachment.type === "markdown") {
    const target = stripMarkdownExtension(normalizePath(attachment.path));
    const alias = stripMarkdownExtension(attachment.name);
    return `笔记：${buildWikilink(target, alias)}`;
  }

  if (attachment.type === "webpage") {
    return `网页：${attachment.name}（${attachment.url}）`;
  }

  return `图片：${buildWikilink(attachment.name)}`;
}

function buildAttachmentReferenceText(attachments: MessageAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  return [
    "引用：",
    ...attachments.map((attachment) => `- ${formatAttachmentReference(attachment)}`)
  ].join("\n");
}

function buildSourceReferenceText(message: MessageRecord): string {
  if (message.role !== "assistant" || !message.sources?.length) {
    return "";
  }
  const lines = ["**来源**", ""];
  message.sources.forEach((source, index) => {
    const title = (source.title || source.url || "来源")
      .replace(/\[/g, "［")
      .replace(/\]/g, "］");
    const link = source.url ? `[${title}](${source.url})` : title;
    const host = source.host ? ` — ${source.host}` : "";
    const depth = source.readDepth === "full" ? "（已读全文）" : "（仅摘要）";
    lines.push(`${index + 1}. ${link}${host}${depth}`);
  });
  return lines.join("\n");
}

function buildMessageText(message: MessageRecord): string {
  return [
    message.text.trim(),
    buildAttachmentReferenceText(message.attachments),
    buildSourceReferenceText(message)
  ].filter((part) => part.length > 0).join("\n\n");
}

function buildConversationMeta(conversation: ConversationRecord, modelDisplayName: string): string {
  return [
    "> [!info] 对话信息",
    `> 创建时间：${formatDateTime(conversation.createdAt)}`,
    `> 最后更新：${formatDateTime(conversation.updatedAt)}`,
    `> 使用模型：${modelDisplayName}`
  ].join("\n");
}

function splitConversationTurns(messages: MessageRecord[]): {
  prefixMessages: MessageRecord[];
  turns: ConversationTurn[];
} {
  const prefixMessages: MessageRecord[] = [];
  const turns: ConversationTurn[] = [];
  let activeTurn: ConversationTurn | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      if (activeTurn) {
        turns.push(activeTurn);
      }
      activeTurn = {
        userMessage: message,
        followUps: []
      };
      continue;
    }

    if (!activeTurn) {
      prefixMessages.push(message);
      continue;
    }

    activeTurn.followUps.push(message);
  }

  if (activeTurn) {
    turns.push(activeTurn);
  }

  return { prefixMessages, turns };
}

function buildNonUserMessageBlock(message: MessageRecord): string {
  const text = buildMessageText(message);
  if (message.role === "assistant") {
    if (message.status === "error") {
      return buildCallout("failure", "本轮回复异常", text);
    }
    return normalizeMessageText(text);
  }

  return buildCallout("info", "系统提示", text);
}

function buildTurnBlock(turn: ConversationTurn, turnIndex: number): string {
  const parts = [
    buildCallout("question", `第 ${turnIndex + 1} 轮 · 我的输入`, buildMessageText(turn.userMessage))
  ];

  for (const message of turn.followUps) {
    parts.push(buildNonUserMessageBlock(message));
  }

  return parts.join("\n\n").trim();
}

function buildConversationBody(messages: MessageRecord[]): string {
  const { prefixMessages, turns } = splitConversationTurns(messages);
  const sections: string[] = [];

  for (const message of prefixMessages) {
    sections.push(buildNonUserMessageBlock(message));
  }

  for (const [index, turn] of turns.entries()) {
    sections.push(buildTurnBlock(turn, index));
  }

  return sections.join("\n\n---\n\n").trim();
}

function buildMarkdown(
  conversation: ConversationRecord,
  modelDisplayName: string
): string {
  const body = buildConversationBody(conversation.messages);
  return [
    "---",
    `title: ${JSON.stringify(conversation.title)}`,
    `created: ${JSON.stringify(formatDateTime(conversation.createdAt))}`,
    `updated: ${JSON.stringify(formatDateTime(conversation.updatedAt))}`,
    `model: ${JSON.stringify(modelDisplayName)}`,
    `conversation_id: ${JSON.stringify(conversation.id)}`,
    `source: ${JSON.stringify(PLUGIN_NAME)}`,
    "---",
    "",
    `# ${conversation.title}`,
    "",
    buildConversationMeta(conversation, modelDisplayName),
    "",
    body.trim(),
    ""
  ].join("\n");
}

export class MarkdownExportService {
  constructor(private readonly app: App) {}

  async exportConversation(
    conversation: ConversationRecord | null,
    settings: DialogPluginSettings,
    modelDisplayName: string
  ): Promise<void> {
    if (!conversation || conversation.messages.length === 0) {
      new Notice("当前没有可导出的对话。", 3000);
      return;
    }

    await ensureFolder(this.app, settings.exportFolder);

    const baseName = sanitizeFileName(conversation.title);
    const primaryPath = normalizePath(`${settings.exportFolder}/${baseName}.md`);
    const filePath = await this.findAvailablePath(primaryPath);

    const content = buildMarkdown(conversation, modelDisplayName);
    await this.app.vault.create(filePath, content);
    new Notice(`已导出对话：${filePath}`, 4000);
  }

  private async findAvailablePath(initialPath: string): Promise<string> {
    if (!this.app.vault.getAbstractFileByPath(initialPath)) {
      return initialPath;
    }

    const suffix = formatFileTimestamp(Date.now());
    return initialPath.replace(/\.md$/i, `-${suffix}.md`);
  }
}
