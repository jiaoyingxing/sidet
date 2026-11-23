import { Notice, type WorkspaceLeaf } from "obsidian";
import { AgentActionExecutor, type AgentActionPreview } from "../agent/actions/agent-action";
import { parseSidetToolActionPreview } from "../agent/actions/agent-tool-protocol";
import type { ConversationRecord, MessageRecord } from "../types";
import type { WorkspaceController } from "./workspace-controller";

interface ChatViewAssistantActionsOptions {
  controller: WorkspaceController;
  leaf: WorkspaceLeaf;
}

export class ChatViewAssistantActions {
  private readonly executedInlineActionKeys = new Set<string>();

  constructor(private readonly options: ChatViewAssistantActionsOptions) {}

  renderInlineToolAction(
    parentEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ): void {
    if (message.role !== "assistant" || message.status !== "done") {
      return;
    }

    const preview = parseSidetToolActionPreview(
      message.text,
      `AI 请求的文件动作 · ${conversation.title || "未命名对话"}`
    );
    if (!preview) {
      return;
    }

    const actionKey = `${message.id}:${preview.kind}:${preview.targetPath}:${preview.content}`;
    const cardEl = parentEl.createDiv({ cls: "sidet-agent-inline-action" });
    const headerEl = cardEl.createDiv({ cls: "sidet-agent-inline-action-header" });
    headerEl.createSpan({
      cls: "sidet-agent-inline-action-title",
      text: this.getInlineActionLabel(preview.kind)
    });
    headerEl.createSpan({
      cls: "sidet-agent-inline-action-status",
      text: this.executedInlineActionKeys.has(actionKey) ? "已执行" : "待确认"
    });

    cardEl.createDiv({
      cls: "sidet-agent-inline-action-path",
      text: preview.targetPath
    });
    const previewLabelEl = cardEl.createDiv({
      cls: "sidet-agent-inline-action-preview-label",
      text: preview.contentLabel ?? "写入内容预览"
    });
    previewLabelEl.setAttr("aria-hidden", "true");
    const previewEl = cardEl.createEl("pre", {
      cls: "sidet-agent-inline-action-preview"
    });
    previewEl.setAttr("tabindex", "0");
    previewEl.setAttr("aria-label", "写入内容预览");
    previewEl.createEl("code", {
      text: preview.content
    });
    cardEl.createDiv({
      cls: "sidet-agent-inline-action-note",
      text: "确认后由 Sidet 写入 vault；目标路径和内容来自上方 AI 回复。"
    });

    const actionsEl = cardEl.createDiv({ cls: "sidet-agent-inline-action-actions" });
    const confirmButtonEl = actionsEl.createEl("button", {
      cls: "mod-cta",
      text: this.executedInlineActionKeys.has(actionKey) ? "已执行" : preview.confirmLabel
    });
    confirmButtonEl.type = "button";
    confirmButtonEl.disabled = this.executedInlineActionKeys.has(actionKey);
    confirmButtonEl.addEventListener("click", () => {
      void this.executeInlineToolAction(preview, actionKey, cardEl, confirmButtonEl);
    });
  }

  renderWikiMaintenancePlanAction(
    parentEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ): void {
    if (
      message.role !== "assistant"
      || message.status !== "done"
      || conversation.messages[conversation.messages.length - 1]?.id !== message.id
      || !/^#\s*Wiki\s*维护计划\s*$/m.test(message.text.replace(/\r\n/g, "\n"))
    ) {
      return;
    }

    const cardEl = parentEl.createDiv({ cls: "sidet-wiki-plan-followup" });
    const headerEl = cardEl.createDiv({ cls: "sidet-wiki-plan-followup-header" });
    headerEl.createSpan({
      cls: "sidet-wiki-plan-followup-title",
      text: "继续执行"
    });
    headerEl.createSpan({
      cls: "sidet-wiki-plan-followup-status",
      text: "先生成草稿"
    });

    cardEl.createDiv({
      cls: "sidet-wiki-plan-followup-note",
      text: "基于上方维护计划，只推进最值得先落的一项，并生成可确认的单条写入草稿。"
    });

    const actionsEl = cardEl.createDiv({ cls: "sidet-wiki-plan-followup-actions" });
    const continueButtonEl = actionsEl.createEl("button", {
      cls: "mod-cta",
      text: "生成写入草稿"
    });
    continueButtonEl.type = "button";
    continueButtonEl.disabled = this.options.controller.isLeafStreaming(this.options.leaf);
    continueButtonEl.addEventListener("click", () => {
      if (continueButtonEl.disabled) {
        return;
      }
      continueButtonEl.disabled = true;
      continueButtonEl.setText("生成中…");
      void this.options.controller.continueLatestWikiMaintenancePlan(this.options.leaf).then((didStart) => {
        if (didStart) {
          return;
        }
        continueButtonEl.disabled = false;
        continueButtonEl.setText("生成写入草稿");
      });
    });
  }

  private async executeInlineToolAction(
    preview: AgentActionPreview,
    actionKey: string,
    cardEl: HTMLElement,
    confirmButtonEl: HTMLButtonElement
  ): Promise<void> {
    confirmButtonEl.disabled = true;
    confirmButtonEl.setText("执行中…");
    try {
      const executor = new AgentActionExecutor(this.options.controller.getApp());
      const result = await executor.execute(preview, {
        targetPath: preview.targetPath,
        content: preview.content
      });
      this.executedInlineActionKeys.add(actionKey);
      cardEl.addClass("is-executed");
      const statusEl = cardEl.querySelector(".sidet-agent-inline-action-status");
      if (statusEl) {
        statusEl.textContent = "已执行";
      }
      confirmButtonEl.setText("已执行");
      new Notice(result.message, 3600);
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行文件动作失败。";
      confirmButtonEl.disabled = false;
      confirmButtonEl.setText(preview.confirmLabel);
      new Notice(message, 4200);
    }
  }

  private getInlineActionLabel(kind: AgentActionPreview["kind"]): string {
    switch (kind) {
      case "create-note":
        return "创建 Markdown 笔记";
      case "append-note":
        return "追加到 Markdown 笔记";
      case "replace-note":
        return "覆盖现有 Markdown 笔记";
      case "replace-selection":
        return "替换当前选区";
      case "replace-section":
        return "替换当前小节";
      default:
        return "文件动作";
    }
  }
}
