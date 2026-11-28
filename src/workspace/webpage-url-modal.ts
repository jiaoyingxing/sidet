import { App, ButtonComponent, Modal } from "obsidian";
import {
  createSidetModalError,
  createSidetModalFooter,
  type SidetModalErrorHandle
} from "../shared/modal/sidet-modal-shell";

export class WebpageUrlModal extends Modal {
  private inputEl: HTMLInputElement | null = null;
  private submitButtonEl: HTMLButtonElement | null = null;
  private errorHandle: SidetModalErrorHandle | null = null;
  private didSubmit = false;
  private submitting = false;

  constructor(
    app: App,
    private readonly onSubmitUrl: (url: string) => Promise<void> | void,
    private readonly onCancel?: () => void
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("sidet-rename-modal");
    this.titleEl.setText("引用网页");
    this.contentEl.empty();

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

    const errorHandle = createSidetModalError(this.contentEl);
    this.errorHandle = errorHandle;
    const actionsEl = createSidetModalFooter(this.contentEl);
    new ButtonComponent(actionsEl)
      .setButtonText("取消")
      .setClass("mod-cancel")
      .onClick(() => {
        this.close();
      });

    this.submitButtonEl = new ButtonComponent(actionsEl)
      .setButtonText("引用网页")
      .setCta()
      .onClick(() => {
        void this.submit();
      })
      .buttonEl;

    this.inputEl.addEventListener("input", () => {
      this.errorHandle?.clear();
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
    this.errorHandle = null;
    this.submitting = false;
    if (!this.didSubmit) {
      this.onCancel?.();
    }
  }

  private syncSubmitButton(): void {
    if (!this.submitButtonEl) {
      return;
    }
    this.submitButtonEl.disabled = this.submitting
      || (this.inputEl?.value.trim().length ?? 0) === 0;
  }

  private async submit(): Promise<void> {
    if (this.submitting) {
      return;
    }
    const url = this.inputEl?.value.trim() ?? "";
    if (!url) {
      this.inputEl?.focus();
      return;
    }

    this.errorHandle?.clear();
    this.submitting = true;
    this.syncSubmitButton();
    try {
      await this.onSubmitUrl(url);
      this.didSubmit = true;
      this.close();
    } catch (error) {
      const detail = error instanceof Error ? error.message.trim() : "";
      this.errorHandle?.show(detail ? `引用失败：${detail}` : "引用失败，请稍后重试。");
    } finally {
      this.submitting = false;
      this.syncSubmitButton();
    }
  }
}
