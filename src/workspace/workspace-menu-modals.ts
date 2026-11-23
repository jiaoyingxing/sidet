import { Modal, setIcon } from "obsidian";
import { UNTITLED_CONVERSATION_TITLE } from "../constants";
import type { ConversationFolderSummary, ConversationSummary } from "../types";
import type { WorkspaceController } from "./workspace-controller";

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

  constructor(
    private readonly controller: WorkspaceController,
    private readonly summary: ConversationSummary
  ) {
    super(controller.getApp());
  }

  override onOpen(): void {
    this.containerEl.addClass("sidet-rename-modal-container");
    this.modalEl.addClass("sidet-rename-modal");
    this.contentEl.empty();

    this.contentEl.createEl("h2", {
      cls: "sidet-rename-modal-title",
      text: "重命名对话"
    });

    const bodyEl = this.contentEl.createDiv({ cls: "sidet-rename-modal-body" });
    this.inputEl = bodyEl.createEl("input", {
      cls: "sidet-rename-modal-input",
      type: "text"
    });
    this.inputEl.value = this.summary.title || UNTITLED_CONVERSATION_TITLE;
    this.inputEl.setAttr("aria-label", "新的对话标题");

    const actionsEl = this.contentEl.createDiv({ cls: "sidet-rename-modal-actions" });
    const cancelButtonEl = actionsEl.createEl("button", {
      cls: "mod-muted",
      text: "取消"
    });
    cancelButtonEl.type = "button";
    cancelButtonEl.addEventListener("click", () => {
      this.close();
    });

    this.saveButtonEl = actionsEl.createEl("button", {
      cls: "mod-cta",
      text: "保存"
    });
    this.saveButtonEl.type = "button";
    this.saveButtonEl.addEventListener("click", () => {
      void this.submit();
    });

    this.inputEl.addEventListener("input", () => {
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
  }

  private syncSaveButton(): void {
    if (!this.inputEl || !this.saveButtonEl) {
      return;
    }
    this.saveButtonEl.disabled = this.inputEl.value.trim().length === 0;
  }

  private async submit(): Promise<void> {
    if (!this.inputEl) {
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
    await this.controller.renameConversation(this.summary.id, nextTitle);
    this.close();
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

  constructor(
    controller: WorkspaceController,
    private readonly options: FolderNameModalOptions
  ) {
    super(controller.getApp());
  }

  override onOpen(): void {
    this.containerEl.addClass("sidet-rename-modal-container");
    this.modalEl.addClass("sidet-rename-modal");
    this.contentEl.empty();

    this.contentEl.createEl("h2", {
      cls: "sidet-rename-modal-title",
      text: this.options.title
    });

    const bodyEl = this.contentEl.createDiv({ cls: "sidet-rename-modal-body" });
    this.inputEl = bodyEl.createEl("input", {
      cls: "sidet-rename-modal-input",
      type: "text"
    });
    this.inputEl.value = this.options.initialValue ?? "";
    this.inputEl.setAttr("aria-label", this.options.inputLabel);

    const actionsEl = this.contentEl.createDiv({ cls: "sidet-rename-modal-actions" });
    const cancelButtonEl = actionsEl.createEl("button", {
      cls: "mod-muted",
      text: "取消"
    });
    cancelButtonEl.type = "button";
    cancelButtonEl.addEventListener("click", () => {
      this.close();
    });

    this.saveButtonEl = actionsEl.createEl("button", {
      cls: "mod-cta",
      text: this.options.submitLabel
    });
    this.saveButtonEl.type = "button";
    this.saveButtonEl.addEventListener("click", () => {
      void this.submit();
    });

    this.inputEl.addEventListener("input", () => {
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
  }

  private syncSaveButton(): void {
    if (!this.inputEl || !this.saveButtonEl) {
      return;
    }
    this.saveButtonEl.disabled = this.inputEl.value.trim().length === 0;
  }

  private async submit(): Promise<void> {
    if (!this.inputEl) {
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
    await this.options.onSubmit(nextName);
    this.close();
  }
}

class MoveConversationModal extends Modal {
  constructor(
    private readonly controller: WorkspaceController,
    private readonly summary: ConversationSummary
  ) {
    super(controller.getApp());
  }

  override onOpen(): void {
    this.containerEl.addClass("sidet-rename-modal-container");
    this.modalEl.addClass("sidet-rename-modal");
    this.contentEl.empty();

    this.contentEl.createEl("h2", {
      cls: "sidet-rename-modal-title",
      text: "移动到文件夹"
    });

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
        void this.controller.moveConversationToFolder(this.summary.id, folder.id);
        this.close();
      });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
