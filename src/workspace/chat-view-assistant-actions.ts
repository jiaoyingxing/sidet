import { App, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { AgentActionExecutor, type AgentActionPreview } from "../agent/actions/agent-action";
import { parseSidetToolActionPreview, stripSidetToolActionBlock } from "../agent/actions/agent-tool-protocol";
import { stripSidetProtocolBlocks } from "../agent/web-search/sidet-protocol";
import { PLUGIN_ID } from "../constants";
import type { ConversationRecord, MessageRecord } from "../types";
import {
  classifyAssistantError,
  getAnswerActionPlan,
  getAnswerVersionInfo,
  getSourceSummary,
  isLatestAssistantMessage,
  type AnswerActionKind,
  type AnswerVersionInfo
} from "./chat-view-answer-presentation";
import { findAssistantAnswerSources } from "./assistant-message-dom";
import { createIconButton } from "./icon-button";
import type { WorkspaceController } from "./workspace-controller";

interface AppWithSettings extends App {
  commands?: {
    executeCommandById?: (id: string) => boolean;
  };
  setting?: {
    openTabById?: (id: string) => void;
  };
}

interface ChatViewAssistantActionsOptions {
  controller: WorkspaceController;
  leaf: WorkspaceLeaf;
  copyText: (text: string) => Promise<void>;
  renderMarkdown: (parentEl: HTMLElement, markdown: string) => void;
}

export class ChatViewAssistantActions {
  private readonly executedInlineActionKeys = new Set<string>();

  constructor(private readonly options: ChatViewAssistantActionsOptions) {}

  renderAnswerSources(parentEl: HTMLElement, message: MessageRecord): void {
    const sources = message.sources ?? [];
    const existingEl = findAssistantAnswerSources(parentEl)
      .find((element): element is HTMLDetailsElement => element.instanceOf(HTMLDetailsElement)) ?? null;
    if (sources.length === 0) {
      existingEl?.remove();
      return;
    }

    const signature = sources
      .map((source) => [
        source.title,
        source.url ?? "",
        source.host ?? "",
        source.note ?? "",
        source.readDepth ?? ""
      ].join("~"))
      .join("|");
    if (existingEl?.getAttribute("data-sources-signature") === signature) {
      return;
    }
    existingEl?.remove();

    const summary = getSourceSummary(sources);
    const detailsEl = parentEl.createEl("details", { cls: "sidet-answer-sources" });
    detailsEl.setAttribute("data-sources-signature", signature);
    const summaryEl = detailsEl.createEl("summary", { cls: "sidet-answer-sources-summary" });
    summaryEl.createSpan({
      cls: "sidet-answer-sources-label",
      text: `来源 ${summary.total}`
    });
    const summaryChevronEl = summaryEl.createSpan({ cls: "sidet-answer-sources-chevron" });
    setIcon(summaryChevronEl, "chevron-down");

    const listEl = detailsEl.createDiv({
      cls: "sidet-answer-sources-body markdown-rendered"
    });
    const lines = sources.map((source, sourceIndex) => {
      const title = (source.title || source.url || "来源")
        .replace(/\[/g, "［")
        .replace(/\]/g, "］");
      const link = source.url ? `[${title}](${source.url})` : title;
      const host = source.host ? ` — ${source.host}` : "";
      return `${sourceIndex + 1}. ${link}${host}`;
    });
    if (summary.fullCount === 0) {
      lines.push("", "> 以上为本次检索到的结果，回答可能基于摘要，未逐页核对。");
    }
    const markdown = lines.join("\n");
    const renderBody = () => {
      if (listEl.getAttribute("data-rendered") === "true") {
        return;
      }
      listEl.setAttribute("data-rendered", "true");
      this.options.renderMarkdown(listEl, markdown);
    };
    detailsEl.addEventListener("toggle", () => {
      if (detailsEl.open) {
        renderBody();
      }
    });
  }

  renderAnswerActions(
    parentEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord
  ): void {
    if (message.role !== "assistant" || message.status === "streaming") {
      return;
    }

    const latest = isLatestAssistantMessage(conversation.messages, message);
    const plan = getAnswerActionPlan(message);
    if (plan.mode === "none") {
      return;
    }
    const versionInfo = getAnswerVersionInfo(message);
    const canSwitchVersions = versionInfo.hasMultiple && !conversation.isArchived;

    if (plan.mode === "error") {
      this.renderErrorCard(parentEl, message, latest, plan.actions, versionInfo, canSwitchVersions);
      return;
    }

    const previousUserMessage = this.findPreviousUserMessage(conversation, message);
    const isKnowledgeBaseAnswer = Boolean(previousUserMessage?.knowledgeBaseRouting);

    const actionsEl = parentEl.createDiv({ cls: "sidet-answer-actions" });
    this.createAnswerActionButton(actionsEl, "copy", "复制回答", (event) => {
      void this.copyAnswer(message, false, event.currentTarget as HTMLButtonElement);
    });
    if (latest && previousUserMessage && !isKnowledgeBaseAnswer) {
      this.createAnswerActionButton(actionsEl, "refresh-cw", "重新生成回答", () => {
        void this.regenerateLatestAnswer();
      });
    }
    this.createAnswerActionButton(actionsEl, "more-horizontal", "更多回答操作", (event) => {
      this.openAnswerMoreMenu(event, message, parentEl);
    });
    if (canSwitchVersions) {
      this.renderAnswerVersionSwitcher(actionsEl, message, versionInfo);
    }
  }

  private renderAnswerVersionSwitcher(
    actionRowEl: HTMLElement,
    message: MessageRecord,
    versionInfo: AnswerVersionInfo
  ): void {
    actionRowEl.addClass("has-versions");
    const rowEl = actionRowEl.createDiv({ cls: "sidet-answer-versions" });
    const previousButton = createIconButton(rowEl, {
      icon: "chevron-left",
      label: "上一个回答版本",
      className: "sidet-answer-version",
      preserveFocus: true,
      onClick: () => {
        void this.selectAnswerVariant(message, versionInfo.index - 1);
      }
    });
    previousButton.disabled = versionInfo.index <= 0;
    rowEl.createSpan({ cls: "sidet-answer-versions-label", text: versionInfo.label });
    const nextButton = createIconButton(rowEl, {
      icon: "chevron-right",
      label: "下一个回答版本",
      className: "sidet-answer-version",
      preserveFocus: true,
      onClick: () => {
        void this.selectAnswerVariant(message, versionInfo.index + 1);
      }
    });
    nextButton.disabled = versionInfo.index >= versionInfo.total - 1;
  }

  private async selectAnswerVariant(message: MessageRecord, index: number): Promise<void> {
    try {
      await this.options.controller.selectAnswerVariant(this.options.leaf, message.id, index);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "切换回答版本失败。", 3600);
    }
  }

  private findPreviousUserMessage(
    conversation: ConversationRecord,
    message: MessageRecord
  ): MessageRecord | null {
    const messageIndex = conversation.messages.findIndex((item) => item.id === message.id);
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const candidate = conversation.messages[index];
      if (candidate.role === "user") {
        return candidate;
      }
    }
    return null;
  }

  private createAnswerActionButton(
    parentEl: HTMLElement,
    icon: string,
    label: string,
    onClick: (event: MouseEvent) => void
  ): HTMLButtonElement {
    return createIconButton(parentEl, {
      icon,
      label,
      className: "sidet-answer-action",
      preserveFocus: true,
      onClick
    });
  }

  private async copyAnswer(
    message: MessageRecord,
    includeSources: boolean,
    buttonEl?: HTMLButtonElement
  ): Promise<void> {
    let text = stripSidetToolActionBlock(stripSidetProtocolBlocks(message.text)).trim();
    if (!text) {
      return;
    }
    if (includeSources && message.sources?.length) {
      const sourceLines = message.sources.map((source, index) => {
        const title = (source.title || source.url || "来源")
          .replace(/\[/g, "［")
          .replace(/\]/g, "］");
        const link = source.url ? `[${title}](${source.url})` : title;
        const host = source.host ? ` — ${source.host}` : "";
        const depth = source.readDepth === "full" ? "（已读全文）" : "（仅摘要）";
        return `${index + 1}. ${link}${host}${depth}`;
      });
      text = `${text}\n\n**来源**\n\n${sourceLines.join("\n")}`;
    }

    try {
      await this.options.copyText(text);
      if (buttonEl) {
        setIcon(buttonEl, "check");
        window.setTimeout(() => setIcon(buttonEl, "copy"), 1200);
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "复制失败。", 3600);
    }
  }

  private async regenerateLatestAnswer(): Promise<void> {
    try {
      await this.options.controller.regenerateLatestAnswer(this.options.leaf);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "重新生成失败。", 4000);
    }
  }

  private openAnswerMoreMenu(
    event: MouseEvent,
    message: MessageRecord,
    parentEl: HTMLElement
  ): void {
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("复制 Markdown 与来源")
        .setIcon("copy")
        .onClick(() => {
          void this.copyAnswer(message, true);
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("查看来源")
        .setIcon("list")
        .setDisabled((message.sources?.length ?? 0) === 0)
        .onClick(() => {
          const detailsEl = findAssistantAnswerSources(parentEl)
            .find((element): element is HTMLDetailsElement => element.instanceOf(HTMLDetailsElement)) ?? null;
          if (!detailsEl) {
            return;
          }
          detailsEl.open = true;
          detailsEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
    });
    menu.showAtMouseEvent(event);
  }

  private renderErrorCard(
    parentEl: HTMLElement,
    message: MessageRecord,
    latest: boolean,
    actions: AnswerActionKind[],
    versionInfo: AnswerVersionInfo,
    canSwitchVersions: boolean
  ): void {
    const error = classifyAssistantError(message.errorText ?? message.text);
    const cardEl = parentEl.createDiv({ cls: "sidet-answer-error" });
    const headerEl = cardEl.createDiv({ cls: "sidet-answer-error-head" });
    const iconEl = headerEl.createSpan({ cls: "sidet-answer-error-icon" });
    setIcon(iconEl, "alert-circle");
    headerEl.createSpan({
      cls: "sidet-answer-error-title",
      text: error.title
    });
    if (error.reason.trim()) {
      cardEl.createDiv({
        cls: "sidet-answer-error-reason",
        text: error.reason
      });
    }

    const actionsEl = cardEl.createDiv({ cls: "sidet-answer-error-actions" });
    if (latest && actions.includes("open-settings")) {
      const settingsButton = actionsEl.createEl("button", {
        cls: "sidet-answer-error-action is-primary",
        text: "检查模型设置"
      });
      settingsButton.type = "button";
      settingsButton.addEventListener("click", () => this.openModelSettings());
    }
    if (latest && actions.includes("retry")) {
      const retryButton = actionsEl.createEl("button", {
        cls: `sidet-answer-error-action${actions.includes("open-settings") ? "" : " is-primary"}`,
        text: "重试"
      });
      retryButton.type = "button";
      retryButton.addEventListener("click", () => {
        retryButton.disabled = true;
        void this.regenerateLatestAnswer().finally(() => {
          retryButton.disabled = false;
        });
      });
    }
    if (actions.includes("copy-error")) {
      const copyButton = actionsEl.createEl("button", {
        cls: "sidet-answer-error-action is-ghost",
        text: "复制错误信息"
      });
      copyButton.type = "button";
      copyButton.addEventListener("click", () => {
        void this.options.copyText((message.errorText ?? message.text).trim());
      });
    }
    if (canSwitchVersions) {
      this.renderAnswerVersionSwitcher(actionsEl, message, versionInfo);
    }
  }

  private openModelSettings(): void {
    const app = this.options.controller.getApp() as AppWithSettings;
    app.commands?.executeCommandById?.("app:open-settings");
    app.setting?.openTabById?.(PLUGIN_ID);
  }

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
