import type { AgentActionPreview } from "./agent-action";
import { buildNormalizedWikiMarkdownFromPath, isWikiNotePath } from "../wiki/wiki-note-schema";
import {
  buildSidetFileToolContext as buildSidetFileToolPrompt,
  buildSidetFileToolSummaryContext as buildSidetFileToolSummaryPrompt
} from "../prompts/tool-action-prompt";

type SidetToolKind = "create_note" | "append_note" | "replace_note";

interface SidetToolAction {
  tool: SidetToolKind;
  targetPath: string;
  title?: string;
  reason?: string;
  content: string;
}

const ACTION_BLOCK_PATTERN = /```sidet-action\s*\n([\s\S]*?)```/i;

export function buildSidetFileToolContext(): string {
  return buildSidetFileToolPrompt();
}

export function buildSidetFileToolSummaryContext(): string {
  return buildSidetFileToolSummaryPrompt();
}

export function parseSidetToolActionPreview(
  markdown: string,
  sourceLabel: string
): AgentActionPreview | null {
  const action = parseSidetToolAction(markdown);
  if (!action) {
    return null;
  }

  const isCreate = action.tool === "create_note";
  const isReplace = action.tool === "replace_note";
  const normalizedTargetPath = normalizeTargetPath(action.targetPath);
  const normalizedContent = (isCreate || isReplace) && isWikiNotePath(normalizedTargetPath)
    ? buildNormalizedWikiMarkdownFromPath(normalizedTargetPath, action.content, {}, { preserveUpdatedAt: false })
    : action.content;

  return {
    kind: isCreate ? "create-note" : isReplace ? "replace-note" : "append-note",
    title: action.title || (isCreate ? "创建笔记" : isReplace ? "覆盖现有笔记" : "追加到笔记"),
    targetPath: normalizedTargetPath,
    content: normalizedContent,
    sourceLabel,
    riskNotes: [
      "这是 AI 在对话中请求的文件动作，只有确认后才会执行。",
      isCreate
        ? "将创建一篇新的 Markdown 笔记；目标路径已存在时会拒绝覆盖。"
        : isReplace
          ? "将覆盖目标 Markdown 笔记的现有内容；目标不存在或不是 Markdown 时会拒绝。"
          : "将追加到已有 Markdown 笔记末尾；目标不存在或不是 Markdown 时会拒绝。",
      action.reason ? `AI 理由：${action.reason}` : "确认前请检查目标路径和写入内容。"
    ],
    confirmLabel: isCreate ? "确认创建" : isReplace ? "确认覆盖" : "确认追加",
    successMessage: isCreate ? "已创建笔记" : isReplace ? "已覆盖笔记" : "已追加到笔记",
    targetPathEditable: isReplace ? false : undefined
  };
}

function normalizeTargetPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\\/g, "/").replace(/\.md$/i, "").concat(".md");
}

function parseSidetToolAction(markdown: string): SidetToolAction | null {
  const match = markdown.match(ACTION_BLOCK_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const rawBlock = match[1].trim();
  const separatorIndex = rawBlock.indexOf("\n---");
  if (separatorIndex < 0) {
    return null;
  }

  const headerText = rawBlock.slice(0, separatorIndex).trim();
  const content = rawBlock.slice(separatorIndex + "\n---".length).trim();
  if (!content) {
    return null;
  }

  const fields = parseHeaderFields(headerText);
  const tool = fields.tool as SidetToolKind | undefined;
  const targetPath = fields.targetpath || fields.target_path || fields.target || fields.path || "";
  if (tool !== "create_note" && tool !== "append_note" && tool !== "replace_note") {
    return null;
  }
  if (!targetPath.trim()) {
    return null;
  }

  return {
    tool,
    targetPath: targetPath.trim(),
    title: fields.title?.trim(),
    reason: fields.reason?.trim(),
    content
  };
}

function parseHeaderFields(headerText: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of headerText.split("\n")) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }
    fields[match[1].toLowerCase()] = match[2] ?? "";
  }
  return fields;
}

export function stripSidetToolActionBlock(markdown: string): string {
  return markdown.replace(ACTION_BLOCK_PATTERN, "").trim();
}
