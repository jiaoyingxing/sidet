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
  /**
   * 预览时读到的目标内容。覆盖 / 追加 / 选区替换在真正写入前必须与它一致；
   * 不一致说明目标在用户查看后被别处改过，直接放弃本次写入。
   */
  expectedExistingContent?: string;
}

export const AGENT_ACTION_STALE_TARGET_MESSAGE = "目标笔记在预览后有改动，请重新查看差异。";

export class AgentActionStaleTargetError extends Error {
  constructor() {
    super(AGENT_ACTION_STALE_TARGET_MESSAGE);
    this.name = "AgentActionStaleTargetError";
  }
}

export interface AgentActionResult {
  targetPath: string;
  message: string;
}

export function normalizeAgentActionTargetPath(rawPath: string): string {
  const trimmedPath = rawPath.trim().replace(/\\/g, "/");
  if (!trimmedPath) {
    return "";
  }
  // 路径来自模型输出，必须挡在 vault 根之外，也拒绝配置目录 / 隐藏目录：
  // `..` 段会让 normalizePath 之后的路径仍指向上级目录；`.` 段和多余斜杠
  // 在这里一并归一，保证预览、存在性检查和写入使用同一条路径。
  const segments = trimmedPath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    return "";
  }
  if (segments.some((segment) => (
    segment === ".."
    || segment.startsWith(".")
    || segment.includes(":")
    // eslint-disable-next-line no-control-regex -- 该正则的用途就是拒绝路径中的控制字符
    || /[\u0000-\u001f]/.test(segment)
  ))) {
    return "";
  }
  const normalizedBase = segments.join("/");
  const withExtension = normalizedBase.toLowerCase().endsWith(".md")
    ? normalizedBase
    : `${normalizedBase}.md`;
  return normalizePath(withExtension);
}

export class AgentActionExecutor {
  constructor(private readonly app: App) {}

  async execute(preview: AgentActionPreview, input: AgentActionInput): Promise<AgentActionResult> {
    const targetPath = normalizeAgentActionTargetPath(input.targetPath);
    await this.flushOpenEditors(targetPath);
    const rawContent = input.content.trim();
    const content = (preview.kind === "create-note" || preview.kind === "replace-note") && isWikiNotePath(targetPath)
      ? buildNormalizedWikiMarkdownFromPath(targetPath, rawContent, {}, { preserveUpdatedAt: false })
      : rawContent;
    if (!targetPath) {
      throw new Error("目标路径无效，已取消写入。");
    }
    if (!content) {
      throw new Error("写入内容不能为空。");
    }

    switch (preview.kind) {
      case "create-note":
        await this.createNote(targetPath, content);
        break;
      case "append-note":
        await this.appendNote(targetPath, content, input.expectedExistingContent);
        break;
      case "replace-note":
        await this.replaceNote(targetPath, content, input.expectedExistingContent);
        break;
      case "replace-selection":
        await this.replaceSelection(
          targetPath,
          preview.selectionText,
          content,
          "选区文本",
          input.expectedExistingContent
        );
        break;
      case "replace-section":
        await this.replaceSelection(
          targetPath,
          preview.selectionText,
          content,
          "小节文本",
          input.expectedExistingContent
        );
        break;
      default:
        throw new Error("暂不支持这个动作类型。");
    }

    return {
      targetPath,
      message: `${preview.successMessage}：${targetPath}`
    };
  }

  /**
   * 目标笔记如果正在编辑器里且用户还有未保存输入，先落盘再走 expected 校验；
   * 否则 `vault.process` 读到的是旧磁盘版本，编辑器稍后保存时可能覆盖本次写入。
   */
  async flushOpenEditors(targetPath: string): Promise<void> {
    if (!targetPath) {
      return;
    }
    const leaves = this.app.workspace?.getLeavesOfType?.("markdown") ?? [];
    for (const leaf of leaves) {
      const view = leaf.view as {
        file?: { path?: string } | null;
        save?: () => Promise<void>;
      } | null;
      if (view?.file?.path !== targetPath || typeof view.save !== "function") {
        continue;
      }
      await view.save();
    }
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

  private async appendNote(
    path: string,
    content: string,
    expectedExistingContent: string | undefined
  ): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile) || target.extension !== "md") {
      throw new Error("目标路径不是可追加的 Markdown 笔记。");
    }

    await this.app.vault.process(target, (existing) => {
      assertAgentActionExpectedContent(existing, expectedExistingContent);
      const prefix = existing.trimEnd();
      return `${prefix ? `${prefix}\n\n` : ""}${content}\n`;
    });
  }

  private async replaceNote(
    path: string,
    content: string,
    expectedExistingContent: string | undefined
  ): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile) || target.extension !== "md") {
      throw new Error("目标路径不是可覆盖的 Markdown 笔记。");
    }

    await this.app.vault.process(target, (existing) => {
      assertAgentActionExpectedContent(existing, expectedExistingContent);
      return `${content}\n`;
    });
  }

  private async replaceSelection(
    path: string,
    selectionText: string | undefined,
    content: string,
    label: string,
    expectedExistingContent: string | undefined
  ): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile) || target.extension !== "md") {
      throw new Error("目标路径不是可替换的 Markdown 笔记。");
    }
    if (!selectionText?.trim()) {
      throw new Error(`没有可替换的${label}。`);
    }

    await this.app.vault.process(target, (existing) => {
      assertAgentActionExpectedContent(existing, expectedExistingContent);
      if (countExactOccurrences(existing, selectionText) !== 1) {
        throw new Error(`${label}在目标笔记中不是唯一匹配，已取消替换。`);
      }
      // 用函数替换，避免正文里的 `$&` / `$`` / `$'` 被 String.replace 当成
      // 替换模式展开（AI 生成的代码片段里完全可能出现这些字符）。
      return existing.replace(selectionText, () => content);
    });
  }
}

export function assertAgentActionExpectedContent(
  existing: string,
  expected: string | undefined
): void {
  if (expected !== undefined && existing !== expected) {
    throw new AgentActionStaleTargetError();
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
