import { App, normalizePath, TFile } from "obsidian";
import { ensureFolder } from "../../shared/paths";
import { buildNormalizedWikiMarkdownFromPath, isWikiNotePath } from "../wiki/wiki-note-schema";

export type AgentActionKind =
  | "create-note"
  | "append-note"
  | "replace-note"
  | "replace-selection"
  | "replace-section";

export interface AgentActionPreview {
  kind: AgentActionKind;
  title: string;
  targetPath: string;
  content: string;
  contentLabel?: string;
  sourceLabel: string;
  riskNotes: string[];
  confirmLabel: string;
  successMessage: string;
  targetPathEditable?: boolean;
  selectionText?: string;
}

export interface AgentActionInput {
  targetPath: string;
  content: string;
}

export interface AgentActionResult {
  targetPath: string;
  message: string;
}

export function normalizeAgentActionTargetPath(rawPath: string): string {
  const trimmedPath = rawPath.trim();
  if (!trimmedPath) {
    return "";
  }
  const withExtension = trimmedPath.toLowerCase().endsWith(".md")
    ? trimmedPath
    : `${trimmedPath}.md`;
  return normalizePath(withExtension);
}

export class AgentActionExecutor {
  constructor(private readonly app: App) {}

  async execute(preview: AgentActionPreview, input: AgentActionInput): Promise<AgentActionResult> {
    const targetPath = normalizeAgentActionTargetPath(input.targetPath);
    const rawContent = input.content.trim();
    const content = (preview.kind === "create-note" || preview.kind === "replace-note") && isWikiNotePath(targetPath)
      ? buildNormalizedWikiMarkdownFromPath(targetPath, rawContent, {}, { preserveUpdatedAt: false })
      : rawContent;
    if (!targetPath || !content) {
      throw new Error("目标路径和写入内容不能为空。");
    }

    switch (preview.kind) {
      case "create-note":
        await this.createNote(targetPath, content);
        break;
      case "append-note":
        await this.appendNote(targetPath, content);
        break;
      case "replace-note":
        await this.replaceNote(targetPath, content);
        break;
      case "replace-selection":
        await this.replaceSelection(targetPath, preview.selectionText, content, "选区文本");
        break;
      case "replace-section":
        await this.replaceSelection(targetPath, preview.selectionText, content, "小节文本");
        break;
      default:
        throw new Error("暂不支持这个动作类型。");
    }

    return {
      targetPath,
      message: `${preview.successMessage}：${targetPath}`
    };
  }

  private async createNote(path: string, content: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(path)) {
      throw new Error("目标路径已存在，请换一个文件名。");
    }

    const folderPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folderPath) {
      await ensureFolder(this.app, folderPath);
    }
    await this.app.vault.create(path, `${content}\n`);
  }

  private async appendNote(path: string, content: string): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile) || target.extension !== "md") {
      throw new Error("目标路径不是可追加的 Markdown 笔记。");
    }

    await this.app.vault.process(target, (existing) => {
      const prefix = existing.trimEnd();
      return `${prefix ? `${prefix}\n\n` : ""}${content}\n`;
    });
  }

  private async replaceNote(path: string, content: string): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile) || target.extension !== "md") {
      throw new Error("目标路径不是可覆盖的 Markdown 笔记。");
    }

    await this.app.vault.modify(target, `${content}\n`);
  }

  private async replaceSelection(
    path: string,
    selectionText: string | undefined,
    content: string,
    label: string
  ): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile) || target.extension !== "md") {
      throw new Error("目标路径不是可替换的 Markdown 笔记。");
    }
    if (!selectionText?.trim()) {
      throw new Error(`没有可替换的${label}。`);
    }

    await this.app.vault.process(target, (existing) => {
      if (countExactOccurrences(existing, selectionText) !== 1) {
        throw new Error(`${label}在目标笔记中不是唯一匹配，已取消替换。`);
      }
      return existing.replace(selectionText, content);
    });
  }
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
