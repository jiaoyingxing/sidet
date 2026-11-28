import { App, ButtonComponent, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { PLUGIN_ID } from "../constants";
import { getAssistantDisplayText } from "../conversations/assistant-visible-text";
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
import { AgentActionCard } from "./agent-action-card";
import { installSmoothDetailsToggle, openSmoothDetails } from "./details-smooth-toggle";
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
  onCardToggle?: (expanded: boolean) => void;
  onDetailsToggle?: (open: boolean) => void;
  /** 用户主动切换回答版本前调用：在内容变化前记录「是否在底部」。 */
  onBeforeUserContentChange?: () => void;
}

export class ChatViewAssistantActions {
  private readonly agentActionCard: AgentActionCard;

  constructor(private readonly options: ChatViewAssistantActionsOptions) {
    this.agentActionCard = new AgentActionCard({
      controller: options.controller,
      renderMarkdown: options.renderMarkdown,
      onToggle: options.onCardToggle
    });
  }

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
    const wasOpen = existingEl?.open === true;
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
    installSmoothDetailsToggle(detailsEl, {
      bodyEl: listEl,
      onToggle: this.options.onDetailsToggle
    });
    if (wasOpen) {
      // 来源在自动联网过程中会继续增长；重建时保留用户已展开的状态。
      detailsEl.open = true;
      renderBody();
    }
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
      this.options.onBeforeUserContentChange?.();
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
    let text = getAssistantDisplayText(message).trim();
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
          if (!openSmoothDetails(detailsEl)) {
            detailsEl.open = true;
          }
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
    // 错误卡动作统一走宿主 ButtonComponent：尺寸、内边距、边框与阴影由宿主按钮规则负责。
    if (latest && actions.includes("open-settings")) {
      const settingsButton = new ButtonComponent(actionsEl)
        .setButtonText("检查模型设置")
        .setCta()
        .onClick(() => this.openModelSettings());
      settingsButton.buttonEl.type = "button";
    }
    if (latest && actions.includes("retry")) {
      const retryButton = new ButtonComponent(actionsEl)
        .setButtonText("重试")
        .onClick(() => {
          retryButton.setDisabled(true);
          void this.regenerateLatestAnswer().finally(() => {
            retryButton.setDisabled(false);
          });
        });
      if (!actions.includes("open-settings")) {
        retryButton.setCta();
      }
      retryButton.buttonEl.type = "button";
    }
    if (actions.includes("copy-error")) {
      const copyButton = new ButtonComponent(actionsEl)
        .setButtonText("复制错误信息")
        .onClick(() => {
          void this.options.copyText((message.errorText ?? message.text).trim());
        });
      copyButton.buttonEl.type = "button";
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
    this.agentActionCard.render(parentEl, conversation, message);
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

}
