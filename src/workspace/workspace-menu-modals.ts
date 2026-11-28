import { ButtonComponent, Modal, setIcon } from "obsidian";
import { UNTITLED_CONVERSATION_TITLE } from "../constants";
import {
  createSidetModalError,
  createSidetModalFooter,
  type SidetModalErrorHandle
} from "../shared/modal/sidet-modal-shell";
import type { ConversationFolderSummary, ConversationSummary } from "../types";
import type { WorkspaceController } from "./workspace-controller";

function formatModalActionError(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail ? `${prefix}${detail}` : `${prefix}请稍后重试。`;
}

export function openCreateFolderModal(controller: WorkspaceController): void {
  window.setTimeout(() => {
    new FolderNameModal(controller, {
      title: "新建文件夹",
      inputLabel: "文件夹名称",
      submitLabel: "创建",
      onSubmit: (name) => controller.createFolder(name)
    }).open();
  }, 0);
}

export function openRenameConversationModal(
  controller: WorkspaceController,
  summary: ConversationSummary
): void {
  window.setTimeout(() => {
    new RenameConversationModal(controller, summary).open();
  }, 0);
}

export function openRenameFolderModal(
  controller: WorkspaceController,
  folder: ConversationFolderSummary
): void {
  window.setTimeout(() => {
    new FolderNameModal(controller, {
      title: "重命名文件夹",
      inputLabel: "新的文件夹名称",
      submitLabel: "保存",
      initialValue: folder.name,
      onSubmit: (name) => controller.renameFolder(folder.id, name)
    }).open();
  }, 0);
}

export function openMoveConversationModal(
  controller: WorkspaceController,
  summary: ConversationSummary
): void {
  window.setTimeout(() => {
    new MoveConversationModal(controller, summary).open();
  }, 0);
}

class RenameConversationModal extends Modal {
  private inputEl: HTMLInputElement | null = null;
  private saveButtonEl: HTMLButtonElement | null = null;
  private errorHandle: SidetModalErrorHandle | null = null;
  private submitting = false;

  constructor(
    private readonly controller: WorkspaceController,
    private readonly summary: ConversationSummary
  ) {
    super(controller.getApp());
  }

  override onOpen(): void {
    this.modalEl.addClass("sidet-rename-modal");
    this.titleEl.setText("重命名对话");
    this.contentEl.empty();

    const bodyEl = this.contentEl.createDiv({ cls: "sidet-rename-modal-body" });
    this.inputEl = bodyEl.createEl("input", {
      cls: "sidet-rename-modal-input",
      type: "text"
    });
    this.inputEl.value = this.summary.title || UNTITLED_CONVERSATION_TITLE;
    this.inputEl.setAttr("aria-label", "新的对话标题");

    const errorHandle = createSidetModalError(this.contentEl);
    this.errorHandle = errorHandle;
    const actionsEl = createSidetModalFooter(this.contentEl);
    new ButtonComponent(actionsEl)
      .setButtonText("取消")
      .setClass("mod-cancel")
      .onClick(() => {
        this.close();
      });

    this.saveButtonEl = new ButtonComponent(actionsEl)
      .setButtonText("保存")
      .setCta()
      .onClick(() => {
        void this.submit();
      })
      .buttonEl;

    this.inputEl.addEventListener("input", () => {
      this.errorHandle?.clear();
      this.syncSaveButton();
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void this.submit();
    });

    this.syncSaveButton();
    window.setTimeout(() => {
      if (!this.inputEl) {
        return;
      }
      this.inputEl.focus();
      this.inputEl.select();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.inputEl = null;
    this.saveButtonEl = null;
    this.errorHandle = null;
    this.submitting = false;
  }

  private syncSaveButton(): void {
    if (!this.inputEl || !this.saveButtonEl) {
      return;
    }
    this.saveButtonEl.disabled = this.submitting || this.inputEl.value.trim().length === 0;
  }

  private async submit(): Promise<void> {
    if (!this.inputEl || this.submitting) {
      return;
    }
    const nextTitle = this.inputEl.value.trim();
    if (!nextTitle) {
      this.inputEl.focus();
      return;
    }
    const currentTitle = this.summary.title || UNTITLED_CONVERSATION_TITLE;
    if (nextTitle === currentTitle) {
      this.close();
      return;
    }
    this.errorHandle?.clear();
    this.submitting = true;
    this.syncSaveButton();
    try {
      await this.controller.renameConversation(this.summary.id, nextTitle);
      this.close();
    } catch (error) {
      this.errorHandle?.show(formatModalActionError("重命名失败：", error));
    } finally {
      this.submitting = false;
      this.syncSaveButton();
    }
  }
}

interface FolderNameModalOptions {
  title: string;
  inputLabel: string;
  submitLabel: string;
  initialValue?: string;
  onSubmit: (name: string) => Promise<void>;
}

class FolderNameModal extends Modal {
  private inputEl: HTMLInputElement | null = null;
  private saveButtonEl: HTMLButtonElement | null = null;
  private errorHandle: SidetModalErrorHandle | null = null;
  private submitting = false;

  constructor(
    controller: WorkspaceController,
    private readonly options: FolderNameModalOptions
  ) {
    super(controller.getApp());
  }

  override onOpen(): void {
    this.modalEl.addClass("sidet-rename-modal");
    this.titleEl.setText(this.options.title);
    this.contentEl.empty();

    const bodyEl = this.contentEl.createDiv({ cls: "sidet-rename-modal-body" });
    this.inputEl = bodyEl.createEl("input", {
      cls: "sidet-rename-modal-input",
      type: "text"
    });
    this.inputEl.value = this.options.initialValue ?? "";
    this.inputEl.setAttr("aria-label", this.options.inputLabel);

    const errorHandle = createSidetModalError(this.contentEl);
    this.errorHandle = errorHandle;
    const actionsEl = createSidetModalFooter(this.contentEl);
    new ButtonComponent(actionsEl)
      .setButtonText("取消")
      .setClass("mod-cancel")
      .onClick(() => {
        this.close();
      });

    this.saveButtonEl = new ButtonComponent(actionsEl)
      .setButtonText(this.options.submitLabel)
      .setCta()
      .onClick(() => {
        void this.submit();
      })
      .buttonEl;

    this.inputEl.addEventListener("input", () => {
      this.errorHandle?.clear();
      this.syncSaveButton();
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void this.submit();
    });

    this.syncSaveButton();
    window.setTimeout(() => {
      if (!this.inputEl) {
        return;
      }
      this.inputEl.focus();
      this.inputEl.select();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.inputEl = null;
    this.saveButtonEl = null;
    this.errorHandle = null;
    this.submitting = false;
  }

  private syncSaveButton(): void {
    if (!this.inputEl || !this.saveButtonEl) {
      return;
    }
    this.saveButtonEl.disabled = this.submitting || this.inputEl.value.trim().length === 0;
  }

  private async submit(): Promise<void> {
    if (!this.inputEl || this.submitting) {
      return;
    }
    const nextName = this.inputEl.value.trim();
    if (!nextName) {
      this.inputEl.focus();
      return;
    }
    if (nextName === this.options.initialValue) {
      this.close();
      return;
    }
    this.errorHandle?.clear();
    this.submitting = true;
    this.syncSaveButton();
    try {
      await this.options.onSubmit(nextName);
      this.close();
    } catch (error) {
      this.errorHandle?.show(formatModalActionError("保存失败：", error));
    } finally {
      this.submitting = false;
      this.syncSaveButton();
    }
  }
}

class MoveConversationModal extends Modal {
  private errorHandle: SidetModalErrorHandle | null = null;
  private submitting = false;

  constructor(
    private readonly controller: WorkspaceController,
    private readonly summary: ConversationSummary
  ) {
    super(controller.getApp());
  }

  override onOpen(): void {
    this.modalEl.addClass("sidet-rename-modal");
    this.titleEl.setText("移动到文件夹");
    this.contentEl.empty();

    const errorHandle = createSidetModalError(this.contentEl);
    this.errorHandle = errorHandle;
    const folders = this.controller.store
      .getFolderSummaries()
      .filter((folder) => folder.id !== this.summary.folderId);
    const bodyEl = this.contentEl.createDiv({ cls: "sidet-rename-modal-body" });

    if (folders.length === 0) {
      bodyEl.createDiv({
        cls: "sidet-empty",
        text: "还没有可移动的文件夹。"
      });
      return;
    }

    const listEl = bodyEl.createDiv({ cls: "sidet-folder-picker-list" });
    for (const folder of folders) {
      const buttonEl = listEl.createEl("button", { cls: "sidet-folder-picker-item" });
      buttonEl.type = "button";
      buttonEl.setAttr("aria-label", `移动到 ${folder.name}`);
      const iconEl = buttonEl.createSpan({ cls: "sidet-folder-picker-item-icon" });
      iconEl.setAttr("aria-hidden", "true");
      setIcon(iconEl, "folder");
      buttonEl.createSpan({ cls: "sidet-folder-picker-item-label", text: folder.name });
      buttonEl.addEventListener("click", () => {
        void this.moveToFolder(folder.id);
      });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
    this.errorHandle = null;
    this.submitting = false;
  }

  private async moveToFolder(folderId: string): Promise<void> {
    if (this.submitting) {
      return;
    }
    this.errorHandle?.clear();
    this.submitting = true;
    try {
      await this.controller.moveConversationToFolder(this.summary.id, folderId);
      this.close();
    } catch (error) {
      this.errorHandle?.show(formatModalActionError("移动失败：", error));
    } finally {
      this.submitting = false;
    }
  }
}
