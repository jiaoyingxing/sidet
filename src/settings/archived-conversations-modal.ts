import { App, ButtonComponent, Modal, SearchComponent, Setting, setIcon, setTooltip } from "obsidian";
import { UNTITLED_CONVERSATION_TITLE } from "../constants";
import { createSidetModalFooter } from "../shared/modal/sidet-modal-shell";
import type { ConversationSummary } from "../types";
import { WorkspaceController } from "../workspace/workspace-controller";

function createIconActionButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void,
  extraClass = ""
): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: `clickable-icon sidet-settings-model-config-action${extraClass ? ` ${extraClass}` : ""}`,
    attr: {
      type: "button",
      "aria-label": label
    }
  });
  setIcon(button, icon);
  setTooltip(button, label);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

class DeleteArchivedConversationConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly summary: ConversationSummary,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("删除已归档对话");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `确定删除“${this.summary.title || UNTITLED_CONVERSATION_TITLE}”吗？`
    });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "删除后将无法恢复。"
    });

    const actions = createSidetModalFooter(this.contentEl);

    new ButtonComponent(actions)
      .setButtonText("取消")
      .setClass("mod-cancel")
      .onClick(() => {
        this.close();
      });

    new ButtonComponent(actions)
      .setWarning()
      .setButtonText("删除")
      .onClick(() => {
        void this.confirm();
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async confirm(): Promise<void> {
    await this.onConfirm();
    this.close();
  }
}

export class ArchivedConversationsModal extends Modal {
  private unsubscribeStore: (() => void) | null = null;
  private summaryEl: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private searchQuery = "";

  constructor(
    app: App,
    private readonly controller: WorkspaceController
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("sidet-archived-conversations-modal");
    this.titleEl.setText("已归档对话");
    this.contentEl.empty();
    this.contentEl.addClass("sidet-archived-conversations-layout");
    this.summaryEl = this.contentEl.createDiv({ cls: "sidet-archived-conversations-summary" });
    this.listEl = this.contentEl.createDiv({ cls: "sidet-archived-conversations-list" });
    this.unsubscribeStore = this.controller.store.subscribe(() => this.renderList());
    this.renderSearch();
    this.renderList();
  }

  override onClose(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.summaryEl = null;
    this.listEl = null;
    this.searchQuery = "";
    this.contentEl.removeClass("sidet-archived-conversations-layout");
    this.contentEl.empty();
  }

  private renderSearch(): void {
    if (!this.summaryEl) {
      return;
    }

    this.summaryEl.empty();
    const searchWrapEl = this.summaryEl.createDiv({ cls: "sidet-archived-conversations-search" });
    const searchComponent = new SearchComponent(searchWrapEl);
    searchComponent
      .setPlaceholder("搜索标题")
      .setValue(this.searchQuery)
      .onChange((value) => {
        this.searchQuery = value;
        this.renderList();
      });
    searchComponent.inputEl.setAttribute("aria-label", "搜索归档对话标题");
  }

  private renderList(): void {
    if (!this.listEl) {
      return;
    }

    const summaries = this.controller.getArchivedConversationSummaries();
    const query = this.searchQuery.trim().toLocaleLowerCase();
    const visibleSummaries = query.length > 0
      ? summaries.filter((summary) => {
        const title = (summary.title || UNTITLED_CONVERSATION_TITLE).trim().toLocaleLowerCase();
        return title.includes(query);
      })
      : summaries;

    this.listEl.empty();

    if (summaries.length === 0) {
      this.listEl.createDiv({
        cls: "sidet-settings-model-config-empty sidet-archived-conversations-empty",
        text: "还没有归档对话。"
      });
      return;
    }

    if (visibleSummaries.length === 0) {
      this.listEl.createDiv({
        cls: "sidet-settings-model-config-empty sidet-archived-conversations-empty",
        text: "没有匹配的归档对话。"
      });
      return;
    }

    const rowsEl = this.listEl.createDiv({ cls: "sidet-settings-model-config-rows" });
    for (const summary of visibleSummaries) {
      const rowEl = rowsEl.createDiv({
        cls: "sidet-settings-model-config-row sidet-archived-conversations-row"
      });
      const textEl = rowEl.createDiv({ cls: "sidet-settings-model-config-text" });
      textEl.createDiv({
        cls: "sidet-settings-model-config-name",
        text: summary.title || UNTITLED_CONVERSATION_TITLE
      });
      textEl.createDiv({
        cls: "sidet-settings-model-config-meta",
        text: this.buildSummaryMeta(summary)
      });

      const actionsEl = rowEl.createDiv({ cls: "sidet-settings-model-config-actions" });
      createIconActionButton(actionsEl, "rotate-ccw", "恢复", () => {
        void this.controller.restoreConversation(summary.id);
      });
      createIconActionButton(actionsEl, "trash-2", "删除", () => {
        new DeleteArchivedConversationConfirmModal(this.app, summary, async () => {
          await this.controller.deleteConversation(summary.id);
        }).open();
      }, "is-danger");
    }
  }

  private buildSummaryMeta(summary: ConversationSummary): string {
    const parts = [];
    if (summary.archivedAt) {
      parts.push(formatTimestamp(summary.archivedAt));
    }
    parts.push(`${summary.messageCount} 条消息`);
    if (summary.folderId) {
      const folder = this.controller.store.getFolder(summary.folderId);
      if (folder?.name) {
        parts.push(`文件夹：${folder.name}`);
      }
    }
    return parts.join(" · ");
  }
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}
