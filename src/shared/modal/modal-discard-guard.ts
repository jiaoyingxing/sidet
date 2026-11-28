/**
 * 通用确认弹窗与「未保存改动」提示（2026-11-27 按 Resojot 弹框标准移植）。
 *
 * 固定文案与语气：放弃＝警告态主按钮，继续编辑＝次按钮；弹窗本身也用共享底栏，
 * 保证与其余弹框同形。调用方只关心 Promise<boolean>。
 */
import { ButtonComponent, Modal, type App } from "obsidian";
import { createSidetModalFooter } from "./sidet-modal-shell";

export interface SidetConfirmModalOptions {
  title: string;
  message: string;
  description?: string;
  confirmText: string;
  cancelText: string;
  /** 确认按钮使用警告态（删除 / 放弃等不可逆动作）。 */
  warning?: boolean;
}

class SidetConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly options: SidetConfirmModalOptions,
    private readonly onResolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.options.title);
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.options.message });
    if (this.options.description) {
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text: this.options.description
      });
    }

    const footerEl = createSidetModalFooter(this.contentEl);
    new ButtonComponent(footerEl)
      .setButtonText(this.options.cancelText)
      .setClass("mod-cancel")
      .onClick(() => {
        this.close();
      });

    const confirmButton = new ButtonComponent(footerEl)
      .setButtonText(this.options.confirmText)
      .onClick(() => {
        this.finish(true);
        this.close();
      });
    if (this.options.warning) {
      confirmButton.setWarning();
    } else {
      confirmButton.setCta();
    }
  }

  override onClose(): void {
    this.contentEl.empty();
    // 取消 / Esc / 右上角 X 都走这里：只要没置过结果，就按「未确认」结束。
    this.finish(false);
  }

  /** 结果只结算一次；确认路径先置位，`onClose` 不再覆盖。 */
  private finish(confirmed: boolean): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.onResolve(confirmed);
  }
}

export function confirmSidetModal(
  app: App,
  options: SidetConfirmModalOptions
): Promise<boolean> {
  return new Promise((resolve) => {
    new SidetConfirmModal(app, options, resolve).open();
  });
}

export function confirmSidetModalDiscard(app: App): Promise<boolean> {
  return confirmSidetModal(app, {
    title: "放弃未保存的更改？",
    message: "这个弹窗里还有没保存的内容，关闭后会丢失。",
    confirmText: "放弃",
    cancelText: "继续编辑",
    warning: true
  });
}
