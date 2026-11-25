import { Modal, type App } from "obsidian";
import type { MessageSource } from "../types";

export interface AnswerSourceTarget {
  source: MessageSource;
  index: number;
}

interface ChatViewSourceModalOptions {
  app: App;
  copyText: (text: string) => Promise<void>;
}

/**
 * 来源详情使用宿主 Modal，不再自绘浮层或底部抽屉。
 *
 * 只保留宿主弹窗里真正有用的内容：标题、来源序号与站点、摘要、打开原文。
 * 已读全文 / 仅摘要不再做成徽章；摘要型来源在 footer 末尾统一说明未逐页核对。
 */
export class ChatViewSourceModal extends Modal {
  constructor(
    private readonly options: ChatViewSourceModalOptions,
    private readonly target: AnswerSourceTarget
  ) {
    super(options.app);
  }

  override onOpen(): void {
    const { source, index } = this.target;
    this.titleEl.setText(source.title || "来源");

    const metaParts = [`来源 ${index}`];
    if (source.host) {
      metaParts.push(source.host);
    }
    this.contentEl.createDiv({
      cls: "sidet-source-modal-meta",
      text: metaParts.join(" · ")
    });

    if (source.note?.trim()) {
      this.contentEl.createEl("p", {
        cls: "sidet-source-modal-snippet",
        text: source.note.trim()
      });
    }

    const actionsEl = this.contentEl.createDiv({ cls: "modal-button-container" });
    if (source.url) {
      const url = source.url;
      const openButton = actionsEl.createEl("button", {
        cls: "mod-cta",
        text: "打开原文"
      });
      openButton.type = "button";
      openButton.addEventListener("click", () => {
        window.open(url, "_blank", "noopener,noreferrer");
        this.close();
      });

      const copyButton = actionsEl.createEl("button", {
        text: "复制链接"
      });
      copyButton.type = "button";
      copyButton.addEventListener("click", () => {
        void this.options.copyText(url);
      });
    } else {
      const closeButton = actionsEl.createEl("button", {
        text: "关闭"
      });
      closeButton.type = "button";
      closeButton.addEventListener("click", () => this.close());
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
