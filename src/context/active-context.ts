import { App, MarkdownView, TFile } from "obsidian";
import { MAX_MARKDOWN_ATTACHMENT_CONTEXT_CHARS, MAX_NOTE_CONTEXT_CHARS, MAX_SELECTION_CONTEXT_CHARS } from "../constants";
import {
  buildContextDraftResult,
  formatContextBundleBlock,
  type ContextBundle,
  type ContextBundleKind,
  type ContextDraftResult
} from "../agent/context-bundle";
import { makeId } from "../shared/paths";
import type { MarkdownMessageAttachment } from "../types";

function normalizeContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function normalizeSelectionText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const clipped = text.slice(0, maxChars).trimEnd();
  return {
    text: `${clipped}\n\n[已截断，原始内容过长]`,
    truncated: true
  };
}

function buildMarkdownContextBundle(
  kind: ContextBundleKind,
  title: string,
  path: string,
  content: string,
  truncated: boolean,
  label: "当前笔记" | "当前选区" | "引用笔记"
): ContextBundle {
  return {
    kind,
    title: `${label}：`,
    sections: [
      {
        metadata: [
          { label: "标题", value: title },
          { label: "路径", value: path },
          truncated ? { label: "说明", value: "已截断" } : { label: "说明", value: "" }
        ],
        content
      }
    ],
    truncated
  };
}

export class ActiveContextService {
  private lastMarkdownSourcePath: string | null = null;
  private lastSelectionSnapshot: { path: string; text: string } | null = null;
  private lastSectionSnapshot: { path: string; heading: string; headingLine: string; text: string } | null = null;

  constructor(private readonly app: App) {}

  rememberActiveMarkdownSource(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }

    this.lastMarkdownSourcePath = file.path;
    const selected = view?.file?.path === file.path ? normalizeSelectionText(view.editor.getSelection()) : "";
    if (selected.trim()) {
      this.lastSelectionSnapshot = {
        path: file.path,
        text: selected
      };
    }
    const section = view ? buildCurrentSectionSnapshot(view) : null;
    if (section) {
      this.lastSectionSnapshot = section;
    }
  }

  async buildCurrentNoteDraft(): Promise<ContextDraftResult> {
    const file = this.resolveMarkdownFile();
    const raw = normalizeContextText(await this.app.vault.cachedRead(file));

    if (!raw) {
      throw new Error("当前笔记是空的，暂时没有可带入的内容。");
    }

    const { text, truncated } = truncateText(raw, MAX_NOTE_CONTEXT_CHARS);
    return buildContextDraftResult(
      buildMarkdownContextBundle("current-note", file.basename, file.path, text, truncated, "当前笔记")
    );
  }

  buildCurrentSelectionDraft(): ContextDraftResult {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile = view?.file ?? null;
    const activeSelected = view && activeFile ? normalizeSelectionText(view.editor.getSelection()) : "";
    const file = activeFile ?? this.resolveMarkdownFile();
    const selected = activeSelected
      || (this.lastSelectionSnapshot?.path === file.path ? this.lastSelectionSnapshot.text : "");
    const normalizedSelected = normalizeContextText(selected);

    if (!normalizedSelected) {
      throw new Error("当前没有选中文本，先选一段内容再带入对话。");
    }

    const { text, truncated } = truncateText(normalizedSelected, MAX_SELECTION_CONTEXT_CHARS);
    return buildContextDraftResult(
      buildMarkdownContextBundle("current-selection", file.basename, file.path, text, truncated, "当前选区")
    );
  }

  resolveCurrentSelectionTarget(): { file: TFile; text: string } {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile = view?.file ?? null;
    const activeSelected = view && activeFile ? normalizeSelectionText(view.editor.getSelection()) : "";
    if (activeFile && activeSelected.trim()) {
      this.lastMarkdownSourcePath = activeFile.path;
      this.lastSelectionSnapshot = {
        path: activeFile.path,
        text: activeSelected
      };
      return {
        file: activeFile,
        text: activeSelected
      };
    }

    const snapshot = this.lastSelectionSnapshot;
    if (snapshot?.text.trim()) {
      const file = this.app.vault.getAbstractFileByPath(snapshot.path);
      if (file instanceof TFile && file.extension === "md") {
        return {
          file,
          text: snapshot.text
        };
      }
    }

    throw new Error("当前没有可替换的 Markdown 选区。");
  }

  resolveCurrentSectionTarget(): { file: TFile; heading: string; headingLine: string; text: string } {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeSection = view ? buildCurrentSectionSnapshot(view) : null;
    if (activeSection) {
      const file = this.app.vault.getAbstractFileByPath(activeSection.path);
      if (file instanceof TFile && file.extension === "md") {
        this.lastMarkdownSourcePath = file.path;
        this.lastSectionSnapshot = activeSection;
        return {
          file,
          heading: activeSection.heading,
          headingLine: activeSection.headingLine,
          text: activeSection.text
        };
      }
    }

    const snapshot = this.lastSectionSnapshot;
    if (snapshot?.text.trim()) {
      const file = this.app.vault.getAbstractFileByPath(snapshot.path);
      if (file instanceof TFile && file.extension === "md") {
        return {
          file,
          heading: snapshot.heading,
          headingLine: snapshot.headingLine,
          text: snapshot.text
        };
      }
    }

    throw new Error("当前光标不在可替换的 Markdown 小节内。");
  }

  async buildMarkdownFileDraft(file: TFile): Promise<ContextDraftResult> {
    const raw = normalizeContextText(await this.app.vault.cachedRead(file));

    if (!raw) {
      throw new Error("选中的 Markdown 文件是空的，暂时没有可带入的内容。");
    }

    const { text, truncated } = truncateText(raw, MAX_NOTE_CONTEXT_CHARS);
    return buildContextDraftResult(
      buildMarkdownContextBundle("markdown-file", file.basename, file.path, text, truncated, "引用笔记")
    );
  }

  async buildMarkdownFileAttachment(file: TFile): Promise<MarkdownMessageAttachment> {
    const raw = normalizeContextText(await this.app.vault.cachedRead(file));

    if (!raw) {
      throw new Error("选中的 Markdown 文件是空的，暂时没有可带入的内容。");
    }

    const { text, truncated } = truncateText(raw, MAX_MARKDOWN_ATTACHMENT_CONTEXT_CHARS);
    const bundle = buildMarkdownContextBundle("markdown-file", file.basename, file.path, text, truncated, "引用笔记");
    return {
      id: makeId("attachment"),
      type: "markdown",
      name: file.basename,
      path: file.path,
      content: formatContextBundleBlock(bundle),
      truncated,
      size: raw.length
    };
  }

  async buildCurrentMarkdownAttachment(): Promise<MarkdownMessageAttachment> {
    return this.buildMarkdownFileAttachment(this.resolveMarkdownFile());
  }

  private resolveMarkdownFile(): TFile {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file) {
      this.lastMarkdownSourcePath = view.file.path;
      return view.file;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof TFile && activeFile.extension === "md") {
      this.lastMarkdownSourcePath = activeFile.path;
      return activeFile;
    }

    const lastSource = this.lastMarkdownSourcePath
      ? this.app.vault.getAbstractFileByPath(this.lastMarkdownSourcePath)
      : null;
    if (lastSource instanceof TFile && lastSource.extension === "md") {
      return lastSource;
    }

    throw new Error("当前没有可带入的 Markdown 笔记。");
  }
}

function buildCurrentSectionSnapshot(
  view: MarkdownView
): { path: string; heading: string; headingLine: string; text: string } | null {
  const file = view.file;
  if (!(file instanceof TFile) || file.extension !== "md") {
    return null;
  }

  const value = normalizeSelectionText(view.editor.getValue());
  const lines = value.split("\n");
  const cursor = view.editor.getCursor();
  const currentLine = Math.min(Math.max(cursor.line, 0), Math.max(lines.length - 1, 0));
  let headingIndex = -1;
  let headingLevel = 0;
  let headingText = "";

  for (let index = currentLine; index >= 0; index -= 1) {
    const match = lines[index]?.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    headingIndex = index;
    headingLevel = match[1].length;
    headingText = match[2].trim();
    break;
  }

  if (headingIndex < 0 || !headingText) {
    return null;
  }

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match || match[1].length > headingLevel) {
      continue;
    }
    endIndex = index;
    break;
  }

  const text = lines.slice(headingIndex, endIndex).join("\n");
  if (!text.trim()) {
    return null;
  }

  return {
    path: file.path,
    heading: headingText,
    headingLine: lines[headingIndex],
    text
  };
}
