import { App, Modal } from "obsidian";

export class WebpageUrlModal extends Modal {
  private inputEl: HTMLInputElement | null = null;
  private submitButtonEl: HTMLButtonElement | null = null;
  private didSubmit = false;

  constructor(
    app: App,
    private readonly onSubmitUrl: (url: string) => Promise<void> | void,
    private readonly onCancel?: () => void
  ) {
    super(app);
  }

  override onOpen(): void {
    this.containerEl.addClass("sidet-rename-modal-container");
    this.modalEl.addClass("sidet-rename-modal");
    this.contentEl.empty();

    this.contentEl.createEl("h2", {
      cls: "sidet-rename-modal-title",
      text: "引用网页"
    });

    const bodyEl = this.contentEl.createDiv({ cls: "sidet-rename-modal-body" });
    bodyEl.createDiv({
      cls: "sidet-empty",
      text: "粘贴 http 或 https 网页链接，Sidet 会提取可读正文并作为当前对话附件。"
    });

    this.inputEl = bodyEl.createEl("input", {
      cls: "sidet-rename-modal-input",
      type: "url"
    });
    this.inputEl.placeholder = "https://example.com/article";
    this.inputEl.setAttr("aria-label", "网页链接");

    const actionsEl = this.contentEl.createDiv({ cls: "sidet-rename-modal-actions" });
    const cancelButtonEl = actionsEl.createEl("button", {
      cls: "mod-muted",
      text: "取消"
    });
    cancelButtonEl.type = "button";
    cancelButtonEl.addEventListener("click", () => {
      this.close();
    });

    this.submitButtonEl = actionsEl.createEl("button", {
      cls: "mod-cta",
      text: "引用网页"
    });
    this.submitButtonEl.type = "button";
    this.submitButtonEl.addEventListener("click", () => {
      void this.submit();
    });

    this.inputEl.addEventListener("input", () => {
      this.syncSubmitButton();
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

    this.syncSubmitButton();
    window.setTimeout(() => {
      this.inputEl?.focus();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.inputEl = null;
    this.submitButtonEl = null;
    if (!this.didSubmit) {
      this.onCancel?.();
    }
  }

  private syncSubmitButton(): void {
    if (!this.submitButtonEl) {
      return;
    }
    this.submitButtonEl.disabled = (this.inputEl?.value.trim().length ?? 0) === 0;
  }

  private async submit(): Promise<void> {
    const url = this.inputEl?.value.trim() ?? "";
    if (!url) {
      this.inputEl?.focus();
      return;
    }

    this.didSubmit = true;
    await this.onSubmitUrl(url);
    this.close();
  }
}
