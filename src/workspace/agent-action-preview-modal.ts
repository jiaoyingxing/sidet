import { Modal, Notice } from "obsidian";
import {
  AgentActionExecutor,
  normalizeAgentActionTargetPath,
  type AgentActionPreview
} from "../agent/actions/agent-action";
import type { WorkspaceController } from "./workspace-controller";

export class AgentActionPreviewModal extends Modal {
  private pathInputEl: HTMLInputElement | null = null;
  private contentTextareaEl: HTMLTextAreaElement | null = null;
  private confirmButtonEl: HTMLButtonElement | null = null;
  private readonly executor: AgentActionExecutor;

  constructor(
    controller: WorkspaceController,
    private readonly preview: AgentActionPreview
  ) {
    super(controller.getApp());
    this.executor = new AgentActionExecutor(controller.getApp());
  }

  override onOpen(): void {
    this.containerEl.addClass("sidet-agent-preview-modal-container");
    this.modalEl.addClass("sidet-agent-preview-modal");
    this.contentEl.empty();

    this.contentEl.createEl("h2", {
      cls: "sidet-agent-preview-title",
      text: this.preview.title
    });
    this.contentEl.createDiv({
      cls: "sidet-agent-preview-source",
      text: this.preview.sourceLabel
    });

    const bodyEl = this.contentEl.createDiv({ cls: "sidet-agent-preview-body" });
    const pathFieldEl = bodyEl.createDiv({ cls: "sidet-agent-preview-field" });
    pathFieldEl.createDiv({ cls: "sidet-agent-preview-label", text: "目标路径" });
    this.pathInputEl = pathFieldEl.createEl("input", {
      cls: "sidet-agent-preview-path",
      type: "text"
    });
    this.pathInputEl.value = this.preview.targetPath;
    this.pathInputEl.setAttr("aria-label", "写入目标路径");
    this.pathInputEl.disabled = this.preview.targetPathEditable === false;

    const contentFieldEl = bodyEl.createDiv({ cls: "sidet-agent-preview-field is-content" });
    contentFieldEl.createDiv({
      cls: "sidet-agent-preview-label",
      text: this.preview.contentLabel ?? "将写入的内容"
    });
    this.contentTextareaEl = contentFieldEl.createEl("textarea", {
      cls: "sidet-agent-preview-content"
    });
    this.contentTextareaEl.value = this.preview.content;
    this.contentTextareaEl.setAttr("aria-label", "写入内容预览");

    const riskListEl = bodyEl.createDiv({ cls: "sidet-agent-preview-risks" });
    for (const note of this.preview.riskNotes) {
      riskListEl.createDiv({ cls: "sidet-agent-preview-risk", text: note });
    }

    const actionsEl = this.contentEl.createDiv({ cls: "sidet-agent-preview-actions" });
    const cancelButtonEl = actionsEl.createEl("button", {
      cls: "mod-muted",
      text: "取消"
    });
    cancelButtonEl.type = "button";
    cancelButtonEl.addEventListener("click", () => {
      this.close();
    });

    this.confirmButtonEl = actionsEl.createEl("button", {
      cls: "mod-cta",
      text: this.preview.confirmLabel
    });
    this.confirmButtonEl.type = "button";
    this.confirmButtonEl.addEventListener("click", () => {
      void this.submit();
    });

    this.pathInputEl.addEventListener("input", () => this.syncConfirmState());
    this.contentTextareaEl.addEventListener("input", () => this.syncConfirmState());
    this.contentTextareaEl.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      this.close();
    });

    this.syncConfirmState();
    window.setTimeout(() => {
      if (this.preview.targetPathEditable === false) {
        this.contentTextareaEl?.focus();
        return;
      }
      this.pathInputEl?.focus();
      this.pathInputEl?.select();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.pathInputEl = null;
    this.contentTextareaEl = null;
    this.confirmButtonEl = null;
  }

  private syncConfirmState(): void {
    if (!this.confirmButtonEl) {
      return;
    }
    this.confirmButtonEl.disabled = !this.resolveTargetPath() || !this.contentTextareaEl?.value.trim();
  }

  private resolveTargetPath(): string {
    const rawPath = this.pathInputEl?.value.trim() ?? "";
    if (!rawPath) {
      return "";
    }
    return normalizeAgentActionTargetPath(rawPath);
  }

  private async submit(): Promise<void> {
    const path = this.resolveTargetPath();
    const content = this.contentTextareaEl?.value.trim();
    if (!path || !content) {
      this.syncConfirmState();
      return;
    }
    try {
      const result = await this.executor.execute(this.preview, {
        targetPath: path,
        content
      });
      new Notice(result.message, 3600);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行动作失败。";
      new Notice(message, 3600);
      if (message.includes("目标路径")) {
        this.pathInputEl?.focus();
      }
    }
  }
}
