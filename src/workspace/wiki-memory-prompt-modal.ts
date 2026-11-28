import { ButtonComponent, Modal, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { createSidetModalFooter } from "../shared/modal/sidet-modal-shell";
import type { WorkspaceController } from "./workspace-controller";

export interface WikiMemoryPromptOptions {
  initialBoundary?: string;
  onSubmitStart?: () => void;
  onSubmitError?: () => void;
  onCancel?: () => void;
}

export type WikiMemoryPromptSource =
  | {
      kind: "conversation";
      leaf: WorkspaceLeaf;
    }
  | {
      kind: "markdown-file";
      file: TFile;
      targetLeaf?: WorkspaceLeaf;
    };

export class WikiMemoryPromptModal extends Modal {
  private boundaryInputEl: HTMLTextAreaElement | null = null;
  private didSubmit = false;

  constructor(
    private readonly controller: WorkspaceController,
    private readonly source: WikiMemoryPromptSource,
    private readonly options: WikiMemoryPromptOptions = {}
  ) {
    super(controller.getApp());
  }

  override onOpen(): void {
    this.modalEl.addClass("sidet-wiki-intake-modal");
    this.titleEl.setText(this.source.kind === "conversation" ? "整理这段对话" : "整理这篇笔记");
    this.contentEl.empty();

    const headerEl = this.contentEl.createDiv({ cls: "sidet-wiki-intake-header" });
    headerEl.createDiv({
      cls: "sidet-wiki-intake-lead",
      text: this.source.kind === "conversation"
        ? "先补一句这次想留下什么、跳过什么。Sidet 会先给出整理计划，不直接写入文件。"
        : "先补一句这篇笔记准备怎么整理。Sidet 会先给出整理计划，不直接写入文件。"
    });

    this.renderSourceCard();
    this.renderWhatThisStepDoes();

    const bodyEl = this.contentEl.createDiv({ cls: "sidet-wiki-intake-body" });
    const fieldEl = bodyEl.createDiv({ cls: "sidet-wiki-intake-field" });
    const fieldTopEl = fieldEl.createDiv({ cls: "sidet-wiki-intake-field-top" });
    fieldTopEl.createDiv({
      cls: "sidet-wiki-intake-label",
      text: "补一句整理方向"
    });
    fieldTopEl.createDiv({
      cls: "sidet-wiki-intake-optional",
      text: "可选"
    });
    fieldEl.createDiv({
      cls: "sidet-wiki-intake-help",
      text: this.source.kind === "conversation"
        ? "可以写想保留的主题、想跳过的临时过程，或说明只处理当前阶段。"
        : "可以写想保留的重点、想跳过的临时细节，或说明只提炼长期可复用内容。"
    });

    this.boundaryInputEl = fieldEl.createEl("textarea", {
      cls: "sidet-wiki-intake-input"
    });
    this.boundaryInputEl.setAttr("aria-label", "知识库整理需求与边界");
    this.boundaryInputEl.placeholder = this.source.kind === "conversation"
      ? "例如：只整理这段对话里关于 Sidet 智能体架构的长期判断。"
      : "例如：只整理这篇笔记里的核心判断，不带入临时过程。";
    this.boundaryInputEl.value = this.options.initialBoundary ?? "";
    this.boundaryInputEl.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    });

    const actionsEl = createSidetModalFooter(this.contentEl);
    new ButtonComponent(actionsEl)
      .setButtonText("取消")
      .setClass("mod-cancel")
      .onClick(() => this.close());

    new ButtonComponent(actionsEl)
      .setButtonText("先看整理计划")
      .setCta()
      .onClick(() => {
        this.submit();
      });

    window.setTimeout(() => {
      this.boundaryInputEl?.focus();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.boundaryInputEl = null;
    if (!this.didSubmit) {
      this.options.onCancel?.();
    }
  }

  private submit(): void {
    const boundary = this.boundaryInputEl?.value.trim();
    this.didSubmit = true;
    this.options.onSubmitStart?.();
    this.close();

    void this.runSubmit(boundary).catch((error) => {
      this.options.onSubmitError?.();
      const message = error instanceof Error ? error.message : "生成维护计划失败。";
      new Notice(message, 4000);
    });
  }

  private async runSubmit(boundary?: string): Promise<void> {
    if (this.source.kind === "conversation") {
      await this.controller.generateWikiMaintenancePlanFromConversation(
        this.source.leaf,
        boundary
      );
      return;
    }

    await this.controller.generateWikiMaintenancePlanFromMarkdownFile(
      this.source.file,
      this.source.targetLeaf,
      boundary
    );
  }

  private renderSourceCard(): void {
    const cardEl = this.contentEl.createDiv({ cls: "sidet-wiki-intake-source" });
    const topEl = cardEl.createDiv({ cls: "sidet-wiki-intake-source-top" });
    const iconEl = topEl.createSpan({ cls: "sidet-wiki-intake-source-icon" });
    setIcon(iconEl, this.source.kind === "conversation" ? "messages-square" : "file-text");
    topEl.createSpan({
      cls: "sidet-wiki-intake-source-kicker",
      text: this.source.kind === "conversation" ? "当前对话" : "Markdown 笔记"
    });

    cardEl.createDiv({
      cls: "sidet-wiki-intake-source-title",
      text: this.getSourceTitle()
    });
    cardEl.createDiv({
      cls: "sidet-wiki-intake-source-meta",
      text: this.getSourceMeta()
    });
  }

  private renderWhatThisStepDoes(): void {
    const sectionEl = this.contentEl.createDiv({ cls: "sidet-wiki-intake-what" });
    sectionEl.createDiv({
      cls: "sidet-wiki-intake-what-title",
      text: "这一步会先做"
    });
    const listEl = sectionEl.createEl("ul", { cls: "sidet-wiki-intake-what-list" });
    [
      "判断这次更适合新建、更新、合并、补链，还是跳过。",
      "优先保留下次还会用到的长期信息，不堆过程材料。",
      "先给整理计划，不直接创建或修改知识库文件。"
    ].forEach((item) => {
      listEl.createEl("li", {
        cls: "sidet-wiki-intake-what-item",
        text: item
      });
    });
  }

  private getSourceTitle(): string {
    if (this.source.kind === "conversation") {
      return this.controller.getChatLeafDisplayText(this.source.leaf);
    }
    return this.source.file.basename;
  }

  private getSourceMeta(): string {
    if (this.source.kind === "conversation") {
      return "默认只整理当前对话，不会顺带处理别的笔记。";
    }
    return this.source.file.path;
  }
}
