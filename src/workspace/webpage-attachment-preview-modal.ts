import { Component, MarkdownRenderer, Modal, Notice } from "obsidian";
import { extractWebpageAttachmentMarkdown } from "../context/webpage-attachment-markdown";
import type { WebpageMessageAttachment } from "../types";
import type { WorkspaceController } from "./workspace-controller";

export class WebpageAttachmentPreviewModal extends Modal {
  private readonly renderComponent = new Component();

  constructor(
    private readonly controller: WorkspaceController,
    private readonly attachment: WebpageMessageAttachment
  ) {
    super(controller.getApp());
  }

  override onOpen(): void {
    this.modalEl.addClass("sidet-webpage-preview-modal");
    this.contentEl.empty();

    this.contentEl.createEl("h2", {
      cls: "sidet-agent-preview-title",
      text: this.attachment.name
    });
    this.contentEl.createDiv({
      cls: "sidet-agent-preview-source",
      text: this.attachment.url
    });

    const bodyEl = this.contentEl.createDiv({ cls: "sidet-webpage-preview-body" });
    void this.renderPreview(bodyEl);

    if (this.attachment.truncated) {
      this.contentEl.createDiv({
        cls: "sidet-webpage-preview-note",
        text: "这份网页正文较长，当前附件只保留了截断后的可读内容。"
      });
    }

    const actionsEl = this.contentEl.createDiv({ cls: "sidet-agent-preview-actions" });
    const closeButtonEl = actionsEl.createEl("button", {
      cls: "mod-muted",
      text: "关闭"
    });
    closeButtonEl.type = "button";
    closeButtonEl.addEventListener("click", () => {
      this.close();
    });

    const openButtonEl = actionsEl.createEl("button", {
      text: "打开原网页"
    });
    openButtonEl.type = "button";
    openButtonEl.addEventListener("click", () => {
      this.openOriginalPage();
    });

    const saveButtonEl = actionsEl.createEl("button", {
      cls: "mod-cta",
      text: "保存为 Markdown"
    });
    saveButtonEl.type = "button";
    saveButtonEl.addEventListener("click", () => {
      this.close();
      void this.controller.openCreateWebpageClipPreview(this.attachment);
    });
  }

  override onClose(): void {
    this.renderComponent.unload();
    this.contentEl.empty();
  }

  private async renderPreview(containerEl: HTMLElement): Promise<void> {
    const markdown = extractWebpageAttachmentMarkdown(this.attachment.content);
    try {
      await MarkdownRenderer.render(
        this.controller.getApp(),
        markdown,
        containerEl,
        "",
        this.renderComponent
      );
    } catch (error) {
      console.error("Sidet：渲染网页附件预览失败", error);
      containerEl.addClass("sidet-message-content");
      containerEl.addClass("-plain");
      containerEl.setText(markdown);
    }
  }

  private openOriginalPage(): void {
    const openedWindow = window.open(this.attachment.url, "_blank", "noopener,noreferrer");
    if (!openedWindow) {
      new Notice("当前环境未能直接打开原网页。", 3200);
    }
  }
}
