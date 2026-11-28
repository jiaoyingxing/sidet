import { ButtonComponent, Component, MarkdownRenderer, Modal, Notice } from "obsidian";
import { extractWebpageAttachmentMarkdown } from "../context/webpage-attachment-markdown";
import { createSidetModalFooter } from "../shared/modal/sidet-modal-shell";
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
    this.titleEl.setText(this.attachment.name);
    this.contentEl.empty();

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

    const actionsEl = createSidetModalFooter(this.contentEl);
    new ButtonComponent(actionsEl)
      .setButtonText("关闭")
      .setClass("mod-cancel")
      .onClick(() => {
        this.close();
      });

    new ButtonComponent(actionsEl)
      .setButtonText("打开原网页")
      .onClick(() => {
        this.openOriginalPage();
      });

    new ButtonComponent(actionsEl)
      .setButtonText("保存为 Markdown")
      .setCta()
      .onClick(() => {
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
