import { ButtonComponent, Component, MarkdownRenderer, Modal, Notice, TFile } from "obsidian";
import {
  AgentActionExecutor,
  AgentActionStaleTargetError,
  normalizeAgentActionTargetPath,
  type AgentActionResult,
  type AgentActionPreview
} from "../agent/actions/agent-action";
import {
  buildAgentActionAppendDiff,
  computeAgentActionDiff,
  formatAgentActionPath,
  type AgentActionDiff
} from "../agent/actions/agent-action-diff";
import {
  createSidetModalError,
  createSidetModalFooter,
  keepModalFocusOnBody,
  type SidetModalErrorHandle
} from "../shared/modal/sidet-modal-shell";
import { bindMobileModalKeyboardDismissal } from "../shared/modal/mobile-modal-keyboard";
import { ModalCloseGuard } from "../shared/modal/modal-close-guard";
import { confirmSidetModalDiscard } from "../shared/modal/modal-discard-guard";
import { renderAgentActionDiff, renderAgentActionNewContent } from "./agent-action-render";
import type { WorkspaceController } from "./workspace-controller";

export interface AgentActionExecutedDetails {
  previousContent: string | null;
  writtenContent: string;
  /** 用户最终确认写入的内容；撤销后卡片按这份内容回到待确认。 */
  content: string;
}

export interface AgentActionPreviewModalOptions {
  /** 从聊天卡片进入时回写「已写入」并带上撤销快照。 */
  onExecuted?: (result: AgentActionResult, details: AgentActionExecutedDetails) => void;
  /** 卡片入口用固定动作名，避免把 AI 自由填写的 title 带进弹窗标题。 */
  title?: string;
}

/**
 * 写入调整弹窗：查看 / 手动修改 / 最终确认。
 *
 * 查看态只显示路径、差异或渲染正文；手动修改态才出现路径输入和全文 textarea。
 * 写入前用打开预览时读到的目标内容做 expected 校验，目标被改过就刷新差异并停留。
 */
export class AgentActionPreviewModal extends Modal {
  private pathSlotEl: HTMLElement | null = null;
  private pathInputEl: HTMLInputElement | null = null;
  private manualButtonEl: HTMLButtonElement | null = null;
  private conflictEl: HTMLElement | null = null;
  private viewEl: HTMLElement | null = null;
  private contentTextareaEl: HTMLTextAreaElement | null = null;
  private primaryButtonEl: HTMLButtonElement | null = null;
  private errorHandle: SidetModalErrorHandle | null = null;
  private readonly executor: AgentActionExecutor;
  private readonly renderComponent = new Component();
  private readonly closeGuard = new ModalCloseGuard({
    isDirty: () => this.isDirty(),
    isBusy: () => this.executing,
    confirmDiscard: () => confirmSidetModalDiscard(this.app),
    close: () => this.closeNow()
  });

  private currentPath = "";
  private contentDraft = "";
  private diff: AgentActionDiff | null = null;
  private existingContent: string | null = null;
  private conflictMessage = "";
  private targetChecked = false;
  private targetInvalid = false;
  private noChanges = false;
  private editing = false;
  private executing = false;
  private refreshGeneration = 0;
  private refreshTimer: number | null = null;
  private unbindMobileKeyboardDismissal: (() => void) | null = null;

  constructor(
    controller: WorkspaceController,
    private readonly preview: AgentActionPreview,
    private readonly options: AgentActionPreviewModalOptions = {}
  ) {
    super(controller.getApp());
    this.executor = new AgentActionExecutor(controller.getApp());
    this.contentDraft = preview.content;
    this.currentPath = preview.targetPath;
  }

  override onOpen(): void {
    this.modalEl.addClass("sidet-agent-preview-modal");
    this.titleEl.setText(this.options.title ?? this.preview.title);
    this.contentEl.empty();

    const bodyEl = this.contentEl.createDiv({ cls: "sidet-agent-preview-body" });
    const headEl = bodyEl.createDiv({ cls: "sidet-agent-preview-head" });
    this.pathSlotEl = headEl.createDiv({ cls: "sidet-agent-preview-path-slot" });
    this.manualButtonEl = new ButtonComponent(headEl)
      .setButtonText("手动修改")
      .buttonEl;
    this.manualButtonEl.addClass("sidet-agent-preview-manual");
    this.manualButtonEl.addEventListener("click", () => {
      this.toggleEditing();
    });

    this.conflictEl = bodyEl.createDiv({ cls: "sidet-agent-preview-conflict" });
    this.viewEl = bodyEl.createDiv({ cls: "sidet-agent-preview-view" });

    const errorHandle = createSidetModalError(this.contentEl);
    this.errorHandle = errorHandle;
    const actionsEl = createSidetModalFooter(this.contentEl);
    new ButtonComponent(actionsEl)
      .setButtonText("取消")
      .setClass("mod-cancel")
      .onClick(() => {
        this.close();
      });

    this.primaryButtonEl = new ButtonComponent(actionsEl)
      .setButtonText(this.getPrimaryLabel())
      .setCta()
      .onClick(() => {
        void this.submit();
      })
      .buttonEl;

    this.unbindMobileKeyboardDismissal = bindMobileModalKeyboardDismissal(this);
    keepModalFocusOnBody(this);
    void this.refreshTarget();
  }

  override close(): void {
    if (this.executing) {
      return;
    }
    void this.closeGuard.requestClose();
  }

  override onClose(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.unbindMobileKeyboardDismissal?.();
    this.unbindMobileKeyboardDismissal = null;
    this.renderComponent.unload();
    this.contentEl.empty();
    this.pathSlotEl = null;
    this.pathInputEl = null;
    this.manualButtonEl = null;
    this.conflictEl = null;
    this.viewEl = null;
    this.contentTextareaEl = null;
    this.primaryButtonEl = null;
    this.errorHandle = null;
  }

  private closeNow(): void {
    super.close();
  }

  private isDirty(): boolean {
    return this.contentDraft !== this.preview.content
      || this.resolveTargetPath() !== normalizeAgentActionTargetPath(this.preview.targetPath);
  }

  private isPathEditable(): boolean {
    return this.preview.targetPathEditable !== false;
  }

  private resolveTargetPath(): string {
    const rawPath = this.currentPath.trim();
    if (!rawPath) {
      return "";
    }
    return normalizeAgentActionTargetPath(rawPath);
  }

  private toggleEditing(): void {
    if (this.executing) {
      return;
    }
    if (this.editing && this.contentTextareaEl) {
      this.contentDraft = this.contentTextareaEl.value;
    }
    this.editing = !this.editing;
    if (!this.editing) {
      if (this.targetChecked) {
        this.recomputeDiff();
      } else {
        void this.refreshTarget();
      }
    }
    this.renderMode();
    this.syncPrimary();
    if (this.editing) {
      this.contentTextareaEl?.focus();
      return;
    }
    this.manualButtonEl?.focus();
  }

  private scheduleTargetRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshTarget();
    }, 280);
  }

  private renderMode(): void {
    this.renderPathSlot();
    this.renderConflict();
    if (this.manualButtonEl) {
      this.manualButtonEl.setText(this.editing ? "完成修改" : "手动修改");
      this.manualButtonEl.disabled = this.executing;
    }
    const viewEl = this.viewEl;
    if (!viewEl) {
      return;
    }
    viewEl.empty();
    this.contentTextareaEl = null;

    if (this.editing) {
      this.renderEditor(viewEl);
      return;
    }
    this.renderReadOnly(viewEl);
  }

  private renderPathSlot(): void {
    const slotEl = this.pathSlotEl;
    if (!slotEl) {
      return;
    }
    const previousInput = this.pathInputEl;
    const hadFocus = previousInput !== null
      && this.modalEl.ownerDocument.activeElement === previousInput;
    slotEl.empty();
    this.pathInputEl = null;
    if (this.editing && this.isPathEditable()) {
      this.pathInputEl = slotEl.createEl("input", {
        cls: "sidet-agent-preview-path-input",
        type: "text"
      });
      this.pathInputEl.value = this.currentPath;
      this.pathInputEl.setAttr("aria-label", "写入目标路径");
      this.pathInputEl.disabled = this.executing;
      this.pathInputEl.addEventListener("input", () => {
        this.errorHandle?.clear();
        this.currentPath = this.pathInputEl?.value ?? "";
        this.targetChecked = false;
        this.targetInvalid = false;
        this.conflictMessage = "";
        this.renderConflict();
        this.syncPrimary();
        this.scheduleTargetRefresh();
      });
      if (hadFocus) {
        this.pathInputEl.focus();
      }
      return;
    }
    const pathParts = formatAgentActionPath(this.resolveTargetPath() || this.currentPath);
    slotEl.createSpan({
      cls: "sidet-agent-preview-path-folder",
      text: pathParts.folder
    });
    slotEl.createSpan({
      cls: "sidet-agent-preview-path-file",
      text: pathParts.fileName
    });
  }

  private renderConflict(): void {
    const conflictEl = this.conflictEl;
    if (!conflictEl) {
      return;
    }
    conflictEl.setText(this.conflictMessage);
    conflictEl.hidden = !this.conflictMessage;
  }

  private renderEditor(viewEl: HTMLElement): void {
    this.contentTextareaEl = viewEl.createEl("textarea", {
      cls: "sidet-agent-preview-content",
      attr: { "aria-label": "写入内容" }
    });
    this.contentTextareaEl.value = this.contentDraft;
    this.contentTextareaEl.disabled = this.executing;
    this.contentTextareaEl.addEventListener("input", () => {
      this.errorHandle?.clear();
      this.contentDraft = this.contentTextareaEl?.value ?? "";
      this.syncPrimary();
    });
  }

  private renderReadOnly(viewEl: HTMLElement): void {
    if (this.preview.kind === "create-note") {
      renderAgentActionNewContent(viewEl, this.contentDraft, (parentEl, markdown) => {
        void this.renderMarkdown(parentEl, markdown);
      });
      return;
    }
    if (this.noChanges) {
      viewEl.createDiv({
        cls: "sidet-agent-preview-empty",
        text: "新内容和现有笔记一样，没有需要写入的改动。"
      });
      return;
    }
    if (!this.diff) {
      return;
    }
    if (this.diff.truncated) {
      viewEl.createDiv({
        cls: "sidet-agent-preview-empty",
        text: "笔记内容较长，无法在这里显示完整差异。请打开笔记查看，或手动修改内容。"
      });
      return;
    }
    if (this.diff.entries.length === 0) {
      viewEl.createDiv({
        cls: "sidet-agent-preview-empty",
        text: "没有可显示的改动。"
      });
      return;
    }
    renderAgentActionDiff(viewEl, this.diff);
  }

  private async refreshTarget(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const path = this.resolveTargetPath();
    this.targetChecked = false;
    this.targetInvalid = false;
    this.noChanges = false;
    this.existingContent = null;
    this.conflictMessage = "";
    if (!this.editing) {
      this.renderConflict();
      this.renderPathSlot();
    }
    this.syncPrimary();

    if (!path) {
      this.targetChecked = true;
      this.targetInvalid = true;
      this.conflictMessage = "目标路径不能为空。";
      this.finishRefresh();
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (this.preview.kind === "create-note") {
      this.targetChecked = true;
      this.targetInvalid = file instanceof TFile;
      this.conflictMessage = this.targetInvalid ? "目标已存在，不能新建。" : "";
      this.finishRefresh();
      return;
    }

    if (!(file instanceof TFile) || file.extension !== "md") {
      this.targetChecked = true;
      this.targetInvalid = true;
      this.conflictMessage = this.preview.kind === "replace-note"
        ? "目标不存在，无法覆写。"
        : "目标不存在，无法写入。";
      this.finishRefresh();
      return;
    }

    try {
      const existingContent = await this.app.vault.cachedRead(file);
      if (generation !== this.refreshGeneration) {
        return;
      }
      this.existingContent = existingContent;
      this.targetChecked = true;
      this.targetInvalid = false;
      this.conflictMessage = "";
      this.recomputeDiff();
    } catch (error) {
      if (generation !== this.refreshGeneration) {
        return;
      }
      this.targetChecked = true;
      this.targetInvalid = true;
      this.conflictMessage = error instanceof Error && error.message.trim()
        ? `读取目标失败：${error.message.trim()}`
        : "读取目标失败。";
    }
    this.finishRefresh();
  }

  private finishRefresh(): void {
    this.renderConflict();
    if (!this.editing) {
      this.renderReadOnlyIntoView();
    }
    this.syncPrimary();
  }

  private renderReadOnlyIntoView(): void {
    const viewEl = this.viewEl;
    if (!viewEl) {
      return;
    }
    viewEl.empty();
    this.renderReadOnly(viewEl);
  }

  private recomputeDiff(): void {
    if (this.preview.kind === "create-note") {
      return;
    }
    const oldText = this.preview.kind === "replace-selection" || this.preview.kind === "replace-section"
      ? this.preview.selectionText
      : this.existingContent;
    if (oldText === null || oldText === undefined) {
      return;
    }
    this.diff = this.preview.kind === "append-note"
      ? buildAgentActionAppendDiff(oldText, this.contentDraft)
      : computeAgentActionDiff(oldText, this.contentDraft);
    this.noChanges = !this.diff.truncated
      && this.preview.kind === "replace-note"
      && this.diff.added === 0
      && this.diff.removed === 0;
    this.syncPrimary();
  }

  private syncPrimary(): void {
    const buttonEl = this.primaryButtonEl;
    if (!buttonEl) {
      return;
    }
    buttonEl.setText(this.executing ? "正在写入…" : this.getPrimaryLabel());
    buttonEl.disabled = this.executing
      || !this.resolveTargetPath()
      || !this.contentDraft.trim()
      || !this.targetChecked
      || this.targetInvalid
      || this.noChanges;
    if (this.manualButtonEl) {
      this.manualButtonEl.disabled = this.executing;
    }
    if (this.pathInputEl) {
      this.pathInputEl.disabled = this.executing;
    }
  }

  private getPrimaryLabel(): string {
    switch (this.preview.kind) {
      case "create-note":
        return "同意创建";
      case "append-note":
        return "同意追加";
      case "replace-note":
        return "同意覆写";
      case "replace-selection":
        return "同意替换";
      case "replace-section":
        return "同意替换";
      default:
        return "同意";
    }
  }

  private async submit(): Promise<void> {
    if (this.executing) {
      return;
    }
    if (this.editing && this.contentTextareaEl) {
      this.contentDraft = this.contentTextareaEl.value;
    }
    const path = this.resolveTargetPath();
    const content = this.contentDraft.trim();
    if (!path || !content || this.targetInvalid || this.noChanges) {
      this.syncPrimary();
      return;
    }

    this.executing = true;
    this.errorHandle?.clear();
    this.syncPrimary();
    this.renderMode();
    try {
      const result = await this.executor.execute(this.preview, {
        targetPath: path,
        content,
        expectedExistingContent: this.preview.kind === "create-note"
          ? undefined
          : this.existingContent ?? undefined
      });
      this.executing = false;
      let writtenContent = "";
      try {
        const file = this.app.vault.getAbstractFileByPath(result.targetPath);
        if (file instanceof TFile) {
          writtenContent = await this.app.vault.read(file);
        }
      } catch (error) {
        console.error("Sidet：读取写入结果失败", error);
      }
      const details: AgentActionExecutedDetails = {
        previousContent: this.preview.kind === "create-note" ? null : this.existingContent,
        writtenContent,
        content
      };
      if (this.options.onExecuted) {
        try {
          this.options.onExecuted(result, details);
        } catch (error) {
          console.error("Sidet：回写写入状态失败", error);
        }
      } else {
        new Notice(result.message, 3600);
      }
      this.closeGuard.allowNextClose();
      this.closeNow();
    } catch (error) {
      this.executing = false;
      this.syncPrimary();
      this.renderMode();
      if (error instanceof AgentActionStaleTargetError) {
        this.editing = false;
        this.errorHandle?.show("目标笔记在预览后有改动，差异已刷新，请再看一次。");
        await this.refreshTarget();
        return;
      }
      const message = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "执行失败，请稍后重试。";
      this.errorHandle?.show(message);
    }
  }

  private async renderMarkdown(parentEl: HTMLElement, markdown: string): Promise<void> {
    try {
      await MarkdownRenderer.render(
        this.app,
        markdown,
        parentEl,
        this.app.workspace.getActiveFile()?.path ?? "",
        this.renderComponent
      );
    } catch (error) {
      console.error("Sidet：渲染写入内容失败", error);
      parentEl.setText(markdown);
    }
  }
}
