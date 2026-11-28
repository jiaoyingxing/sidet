import { ButtonComponent, Notice, TFile, setIcon, setTooltip, type App } from "obsidian";
import {
  AgentActionExecutor,
  AgentActionStaleTargetError,
  type AgentActionPreview,
  type AgentActionResult
} from "../agent/actions/agent-action";
import {
  buildAgentActionAppendDiff,
  buildAgentActionSignature,
  computeAgentActionDiff,
  countAgentActionLines,
  formatAgentActionPath,
  toAgentActionChangeStats,
  type AgentActionChangeStats,
  type AgentActionDiff
} from "../agent/actions/agent-action-diff";
import { parseSidetToolActionPreview } from "../agent/actions/agent-tool-protocol";
import { formatFileDatePrefix } from "../shared/time";
import type { ConversationRecord, MessageRecord } from "../types";
import {
  AgentActionPreviewModal,
  type AgentActionExecutedDetails
} from "./agent-action-preview-modal";
import { renderAgentActionDiff, renderAgentActionNewContent } from "./agent-action-render";
import type { WorkspaceController } from "./workspace-controller";

type AgentActionCardStatus =
  | "pending"
  | "executing"
  | "written"
  | "undoing"
  | "stale"
  | "error"
  | "conflict";

type AgentActionChipTone = "warning" | "success" | "danger";

interface AgentActionUndoSnapshot {
  previousContent: string | null;
  writtenContent: string;
}

interface AgentActionCardElements {
  rootEl: HTMLElement;
  pathButtonEl: HTMLButtonElement;
  chipEl: HTMLElement;
  chevronButtonEl: HTMLButtonElement;
  deltaEl: HTMLElement;
  primaryButtonEl: HTMLButtonElement;
  secondaryButtonEl: HTMLButtonElement;
  contentEl: HTMLElement;
  contentBodyEl: HTMLElement;
}

interface AgentActionCardState {
  key: string;
  preview: AgentActionPreview;
  signature: string;
  expanded: boolean;
  lastExpanded: boolean;
  status: AgentActionCardStatus;
  message: string;
  conflictLabel: string;
  executedAt: number | null;
  targetPath: string;
  targetExists: boolean;
  targetChecked: boolean;
  hydrating: boolean;
  existingContent: string | null;
  diff: AgentActionDiff | null;
  stats: AgentActionChangeStats | null;
  noChanges: boolean;
  previewRendered: boolean;
  renderedDiff: AgentActionDiff | null;
  undoSnapshot: AgentActionUndoSnapshot | null;
  contentShown: boolean;
  contentAnimating: boolean;
  contentAnimationTarget: boolean;
  contentAnimationTimer: number | null;
  els: AgentActionCardElements;
}

interface AgentActionCardOptions {
  controller: WorkspaceController;
  renderMarkdown: (parentEl: HTMLElement, markdown: string) => void;
  onToggle?: (expanded: boolean) => void;
}

const MAX_TRACKED_CARDS = 120;
const CONTENT_ANIMATION_MS = 160;

export class AgentActionCard {
  private readonly app: App;
  private readonly executor: AgentActionExecutor;
  private readonly states = new Map<string, AgentActionCardState>();

  constructor(private readonly options: AgentActionCardOptions) {
    this.app = options.controller.getApp();
    this.executor = new AgentActionExecutor(this.app);
  }

  render(parentEl: HTMLElement, conversation: ConversationRecord, message: MessageRecord): void {
    const preview = parseSidetToolActionPreview(
      message.text,
      `AI 请求的文件动作 · ${conversation.title || "未命名对话"}`,
      { updatedAt: formatFileDatePrefix(message.createdAt) }
    );
    if (!preview) {
      return;
    }

    const signature = buildAgentActionSignature({
      kind: preview.kind,
      targetPath: preview.targetPath,
      content: preview.content
    });
    const key = `${conversation.id}:${message.id}:${signature}`;
    const state = this.getOrCreateState(key, preview, signature);

    if (message.agentAction?.signature === signature && state.status !== "written") {
      state.status = "written";
      state.targetPath = message.agentAction.targetPath || preview.targetPath;
      state.executedAt = message.agentAction.executedAt;
      state.expanded = false;
      state.message = "";
      state.conflictLabel = "";
      state.targetChecked = true;
      state.targetExists = this.resolveTargetFile(state.targetPath) instanceof TFile;
      state.undoSnapshot = null;
    }

    this.cancelContentAnimation(state);
    state.lastExpanded = state.expanded;
    state.contentShown = false;
    state.contentAnimationTarget = false;
    state.els = this.buildDom(parentEl, conversation, message, state);
    this.sync(state);
    if (state.status !== "written" && !state.targetChecked) {
      void this.hydrate(state);
    }
  }

  private getOrCreateState(
    key: string,
    preview: AgentActionPreview,
    signature: string
  ): AgentActionCardState {
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }
    if (this.states.size >= MAX_TRACKED_CARDS) {
      const oldestKey = this.states.keys().next().value;
      if (oldestKey) {
        this.states.delete(oldestKey);
      }
    }
    const state: AgentActionCardState = {
      key,
      preview,
      signature,
      expanded: true,
      lastExpanded: true,
      status: "pending",
      message: "",
      conflictLabel: "",
      executedAt: null,
      targetPath: preview.targetPath,
      targetExists: false,
      targetChecked: false,
      hydrating: false,
      existingContent: null,
      diff: null,
      stats: preview.kind === "create-note"
        ? { added: countAgentActionLines(preview.content), removed: 0, truncated: false }
        : null,
      noChanges: false,
      previewRendered: false,
      renderedDiff: null,
      undoSnapshot: null,
      contentShown: false,
      contentAnimating: false,
      contentAnimationTarget: false,
      contentAnimationTimer: null,
      els: null as unknown as AgentActionCardElements
    };
    this.states.set(key, state);
    return state;
  }

  private buildDom(
    parentEl: HTMLElement,
    conversation: ConversationRecord,
    message: MessageRecord,
    state: AgentActionCardState
  ): AgentActionCardElements {
    const rootEl = parentEl.createDiv({ cls: "sidet-agent-inline-action" });
    const headEl = rootEl.createDiv({ cls: "sidet-agent-action-head" });
    const headRowEl = headEl.createDiv({ cls: "sidet-agent-action-head-row" });
    headRowEl.createSpan({
      cls: "sidet-agent-action-title",
      text: this.getActionTitle(state.preview.kind)
    });

    const targetEl = headRowEl.createSpan({ cls: "sidet-agent-action-target" });
    const pathButtonEl = targetEl.createEl("button", {
      cls: "sidet-agent-action-path",
      type: "button"
    });
    setTooltip(pathButtonEl, "打开笔记");
    pathButtonEl.addEventListener("click", () => {
      void this.openTarget(state);
    });
    const chipEl = targetEl.createSpan({ cls: "sidet-agent-action-chip" });

    const chevronButtonEl = headRowEl.createEl("button", {
      cls: "clickable-icon sidet-agent-action-chevron",
      type: "button"
    });
    const chevronIconEl = chevronButtonEl.createSpan({
      cls: "sidet-agent-action-chevron-icon"
    });
    setIcon(chevronIconEl, "chevron-down");
    chevronButtonEl.addEventListener("click", () => {
      state.expanded = !state.expanded;
      this.sync(state);
    });
    headEl.addEventListener("click", (event) => {
      if (!this.canToggle(state)) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, input, textarea, select")) {
        return;
      }
      const selection = headEl.ownerDocument.getSelection();
      if (
        selection
        && !selection.isCollapsed
        && selection.anchorNode
        && headEl.contains(selection.anchorNode)
      ) {
        return;
      }
      state.expanded = !state.expanded;
      this.sync(state);
    });

    const actionRowEl = headEl.createDiv({ cls: "sidet-agent-action-action-row" });
    const deltaEl = actionRowEl.createSpan({ cls: "sidet-agent-action-delta" });
    const spacerEl = actionRowEl.createSpan({ cls: "sidet-agent-action-spacer" });
    spacerEl.setAttr("aria-hidden", "true");
    const primaryButtonEl = new ButtonComponent(actionRowEl)
      .setButtonText("")
      .buttonEl;
    primaryButtonEl.addClass("sidet-agent-action-primary");
    const secondaryButtonEl = new ButtonComponent(actionRowEl)
      .setButtonText("")
      .buttonEl;
    secondaryButtonEl.addClass("sidet-agent-action-secondary");
    primaryButtonEl.addEventListener("click", () => {
      void this.handlePrimary(state, conversation, message);
    });
    secondaryButtonEl.addEventListener("click", () => {
      void this.handleSecondary(state, conversation, message);
    });

    const contentEl = rootEl.createDiv({ cls: "sidet-agent-action-content" });
    contentEl.hidden = true;
    const contentBodyEl = contentEl.createDiv({ cls: "sidet-agent-action-content-body" });
    state.previewRendered = false;
    state.renderedDiff = null;

    return {
      rootEl,
      pathButtonEl,
      chipEl,
      chevronButtonEl,
      deltaEl,
      primaryButtonEl,
      secondaryButtonEl,
      contentEl,
      contentBodyEl
    };
  }

  private sync(state: AgentActionCardState): void {
    const els = state.els;
    if (!els) {
      return;
    }
    this.syncPath(state);
    this.syncChip(state);
    this.syncChevron(state);
    this.syncDelta(state);
    this.syncButtons(state);
    this.syncContent(state);
  }

  private syncPath(state: AgentActionCardState): void {
    const els = state.els;
    const pathParts = formatAgentActionPath(state.targetPath);
    els.pathButtonEl.empty();
    els.pathButtonEl.createSpan({
      cls: "sidet-agent-action-path-folder",
      text: pathParts.folder
    });
    els.pathButtonEl.createSpan({
      cls: "sidet-agent-action-path-file",
      text: pathParts.fileName
    });
    els.pathButtonEl.disabled = !state.targetExists;
    els.pathButtonEl.setAttr(
      "aria-label",
      state.targetExists
        ? `打开笔记：${pathParts.fullPath}`
        : `目标路径：${pathParts.fullPath}`
    );
  }

  private syncChip(state: AgentActionCardState): void {
    const els = state.els;
    const chip = this.getChip(state);
    els.chipEl.setText(chip.label);
    els.chipEl.hidden = !chip.label;
    els.chipEl.classList.toggle("is-warning", chip.tone === "warning");
    els.chipEl.classList.toggle("is-success", chip.tone === "success");
    els.chipEl.classList.toggle("is-danger", chip.tone === "danger");
  }

  private getChip(state: AgentActionCardState): { label: string; tone: AgentActionChipTone } {
    switch (state.status) {
      case "written":
        return { label: "已写入", tone: "success" };
      case "executing":
        return { label: "写入中", tone: "warning" };
      case "undoing":
        return { label: "正在撤销", tone: "warning" };
      case "stale":
        return { label: "文件有改动", tone: "warning" };
      case "error":
        return {
          label: state.message.startsWith("读取目标笔记失败") ? "读取失败" : "写入失败",
          tone: "danger"
        };
      case "conflict":
        return { label: state.conflictLabel, tone: "danger" };
      case "pending":
      default:
        return { label: "待写入", tone: "warning" };
    }
  }

  private syncChevron(state: AgentActionCardState): void {
    const els = state.els;
    const show = this.canToggle(state);
    els.chevronButtonEl.hidden = !show;
    els.rootEl.classList.toggle("is-collapsible", show);
    if (!show) {
      return;
    }
    els.chevronButtonEl.setAttr("aria-expanded", state.expanded ? "true" : "false");
    els.chevronButtonEl.setAttr(
      "aria-label",
      state.expanded ? "收起改动" : "展开改动"
    );
  }

  private syncDelta(state: AgentActionCardState): void {
    const els = state.els;
    els.deltaEl.empty();
    els.deltaEl.classList.remove("is-error");

    if (state.status === "written" && state.message) {
      els.deltaEl.setText(state.message);
      els.deltaEl.classList.add("is-error");
      els.deltaEl.hidden = false;
      return;
    }
    if (state.status === "error" || state.status === "undoing") {
      els.deltaEl.setText(state.message);
      els.deltaEl.classList.add("is-error");
      els.deltaEl.hidden = !state.message;
      return;
    }
    if (state.status === "written") {
      els.deltaEl.hidden = true;
      return;
    }
    if (state.status === "conflict" && !state.stats) {
      els.deltaEl.hidden = true;
      return;
    }
    if (!state.stats) {
      els.deltaEl.setText(state.hydrating ? "读取中…" : "");
      els.deltaEl.hidden = !state.hydrating;
      return;
    }
    if (state.stats.truncated) {
      els.deltaEl.setText("改动较多");
      els.deltaEl.hidden = false;
      return;
    }
    const added = state.stats.added;
    const removed = state.stats.removed;
    if (added === 0 && removed === 0) {
      els.deltaEl.setText("±0");
      els.deltaEl.hidden = false;
      return;
    }
    if (added > 0) {
      els.deltaEl.createSpan({
        cls: "sidet-agent-action-delta-add",
        text: `+${added}`
      });
    }
    if (removed > 0) {
      if (added > 0) {
        els.deltaEl.appendText(" ");
      }
      els.deltaEl.createSpan({
        cls: "sidet-agent-action-delta-del",
        text: `−${removed}`
      });
    }
    els.deltaEl.hidden = false;
  }

  private syncButtons(state: AgentActionCardState): void {
    const els = state.els;
    const primary = this.resolvePrimaryButton(state);
    const secondary = this.resolveSecondaryButton(state);

    els.primaryButtonEl.hidden = primary.hidden;
    els.primaryButtonEl.disabled = primary.disabled;
    els.primaryButtonEl.setText(primary.label);
    els.primaryButtonEl.classList.toggle("mod-cta", primary.style === "accent");
    els.primaryButtonEl.classList.toggle("mod-warning", primary.style === "warning");

    els.secondaryButtonEl.hidden = secondary.hidden;
    els.secondaryButtonEl.disabled = secondary.disabled;
    els.secondaryButtonEl.setText(secondary.label);
  }

  private resolvePrimaryButton(state: AgentActionCardState): {
    label: string;
    hidden: boolean;
    disabled: boolean;
    style: "accent" | "warning" | "neutral";
  } {
    switch (state.status) {
      case "written":
        if (!state.undoSnapshot) {
          return { label: "", hidden: true, disabled: true, style: "neutral" };
        }
        return {
          label: "撤销写入",
          hidden: false,
          disabled: false,
          style: "warning"
        };
      case "undoing":
        return {
          label: "正在撤销…",
          hidden: false,
          disabled: true,
          style: "warning"
        };
      case "executing":
        return {
          label: "正在写入…",
          hidden: false,
          disabled: true,
          style: "accent"
        };
      case "conflict":
        return { label: "", hidden: true, disabled: true, style: "neutral" };
      case "stale":
        return {
          label: this.getAgreeLabel(state.preview.kind, true),
          hidden: false,
          disabled: state.noChanges,
          style: "accent"
        };
      case "error":
        return {
          label: "重试",
          hidden: false,
          disabled: false,
          style: "accent"
        };
      case "pending":
      default:
        return {
          label: this.getAgreeLabel(state.preview.kind, false),
          hidden: false,
          disabled: !state.targetChecked
            || (state.preview.kind === "create-note" ? state.targetExists : !state.targetExists)
            || state.noChanges
            || !state.preview.content.trim(),
          style: "accent"
        };
    }
  }

  private resolveSecondaryButton(state: AgentActionCardState): {
    label: string;
    hidden: boolean;
    disabled: boolean;
  } {
    switch (state.status) {
      case "written":
        return { label: "打开笔记", hidden: false, disabled: !state.targetExists };
      case "undoing":
      case "executing":
        return { label: "", hidden: true, disabled: true };
      case "conflict":
        // 目标临时缺失 / 已存在时仍保留手动修改入口：用户可以改路径或内容，
        // 不必重载整条消息才能从这个状态里出来。
        return { label: "手动修改", hidden: false, disabled: false };
      case "pending":
      case "stale":
      case "error":
      default:
        return { label: "手动修改", hidden: false, disabled: false };
    }
  }

  private async handlePrimary(
    state: AgentActionCardState,
    conversation: ConversationRecord,
    message: MessageRecord
  ): Promise<void> {
    if (conversation.isArchived) {
      new Notice("归档对话为只读，不能执行文件写入。", 3200);
      return;
    }
    switch (state.status) {
      case "written":
        await this.undo(state, conversation, message);
        return;
      case "pending":
      case "stale":
      case "error":
        await this.execute(state, conversation, message);
        return;
      default:
        return;
    }
  }

  private async handleSecondary(
    state: AgentActionCardState,
    conversation: ConversationRecord,
    message: MessageRecord
  ): Promise<void> {
    if (conversation.isArchived && state.status !== "written") {
      new Notice("归档对话为只读，不能修改写入提案。", 3200);
      return;
    }
    switch (state.status) {
      case "written":
        await this.openTarget(state);
        return;
      case "pending":
      case "stale":
      case "error":
      case "conflict":
        this.openAdjustModal(state, conversation, message);
        return;
      default:
        return;
    }
  }

  private hasContent(state: AgentActionCardState): boolean {
    return state.preview.kind === "create-note"
      || Boolean(state.diff)
      || state.hydrating;
  }

  private canToggle(state: AgentActionCardState): boolean {
    return this.hasContent(state)
      && state.status !== "written"
      && state.status !== "undoing";
  }

  private syncContent(state: AgentActionCardState): void {
    const show = state.expanded && this.canToggle(state);
    const userToggled = state.expanded !== state.lastExpanded;
    state.lastExpanded = state.expanded;

    if (state.contentAnimating) {
      if (state.contentAnimationTarget === show) {
        return;
      }
      this.cancelContentAnimation(state);
      this.applyContentState(state, show);
      return;
    }

    if (!userToggled || show === state.contentShown) {
      this.applyContentState(state, show);
      return;
    }

    this.animateContent(state, show);
  }

  private applyContentState(state: AgentActionCardState, show: boolean): void {
    const els = state.els;
    state.contentShown = show;
    state.contentAnimating = false;
    state.contentAnimationTarget = show;
    els.rootEl.classList.toggle("is-expanded", show);
    els.contentEl.classList.remove("is-collapsing");
    els.contentEl.hidden = !show;
    if (show) {
      this.renderContent(state);
    }
  }

  private animateContent(state: AgentActionCardState, show: boolean): void {
    const els = state.els;
    this.options.onToggle?.(show);

    state.contentAnimating = true;
    state.contentAnimationTarget = show;
    if (state.contentAnimationTimer !== null) {
      window.clearTimeout(state.contentAnimationTimer);
      state.contentAnimationTimer = null;
    }

    if (show) {
      els.rootEl.classList.add("is-expanded");
      els.contentEl.hidden = false;
      this.renderContent(state);
      els.contentEl.classList.add("is-collapsing");
      void els.contentEl.offsetHeight;
      els.contentEl.classList.remove("is-collapsing");
    } else {
      els.contentEl.classList.add("is-collapsing");
    }

    const finish = (): void => {
      if (state.contentAnimationTimer !== null) {
        window.clearTimeout(state.contentAnimationTimer);
        state.contentAnimationTimer = null;
      }
      if (!state.contentAnimating || state.contentAnimationTarget !== show) {
        return;
      }
      state.contentAnimating = false;
      state.contentShown = show;
      els.contentEl.classList.remove("is-collapsing");
      els.contentEl.hidden = !show;
      els.rootEl.classList.toggle("is-expanded", show);
    };
    state.contentAnimationTimer = window.setTimeout(finish, CONTENT_ANIMATION_MS + 40);
  }

  private cancelContentAnimation(state: AgentActionCardState): void {
    if (state.contentAnimationTimer !== null) {
      window.clearTimeout(state.contentAnimationTimer);
      state.contentAnimationTimer = null;
    }
    state.contentAnimating = false;
    state.contentAnimationTarget = state.contentShown;
    state.els?.contentEl.classList.remove("is-collapsing");
  }

  private renderContent(state: AgentActionCardState): void {
    const els = state.els;
    const bodyEl = els.contentBodyEl;
    els.contentEl.setAttr(
      "aria-label",
      state.preview.kind === "create-note" ? "新内容预览" : "写入差异"
    );

    if (state.preview.kind === "create-note") {
      if (!state.previewRendered || bodyEl.childElementCount === 0) {
        bodyEl.empty();
        renderAgentActionNewContent(bodyEl, state.preview.content, this.options.renderMarkdown);
        state.previewRendered = true;
      }
      return;
    }

    if (!state.diff) {
      bodyEl.empty();
      state.renderedDiff = null;
      if (state.hydrating) {
        bodyEl.createDiv({
          cls: "sidet-agent-action-empty",
          text: "正在读取目标笔记…"
        });
      }
      return;
    }
    if (state.diff.truncated) {
      if (state.renderedDiff === state.diff && bodyEl.childElementCount > 0) {
        return;
      }
      bodyEl.empty();
      bodyEl.createDiv({
        cls: "sidet-agent-action-empty",
        text: "笔记内容较长，无法在卡片里显示完整差异。可以打开笔记查看，或在「手动修改」里检查新内容。"
      });
      state.renderedDiff = state.diff;
      return;
    }
    if (state.diff.entries.length === 0) {
      if (state.renderedDiff === state.diff && bodyEl.childElementCount > 0) {
        return;
      }
      bodyEl.empty();
      bodyEl.createDiv({
        cls: "sidet-agent-action-empty",
        text: "新内容和现有笔记一样，没有需要写入的改动。"
      });
      state.renderedDiff = state.diff;
      return;
    }
    if (state.renderedDiff === state.diff && bodyEl.childElementCount > 0) {
      return;
    }
    bodyEl.empty();
    renderAgentActionDiff(bodyEl, state.diff);
    state.renderedDiff = state.diff;
  }

  private async hydrate(
    state: AgentActionCardState,
    options: { force?: boolean } = {}
  ): Promise<boolean> {
    if (state.hydrating) {
      return false;
    }
    if (state.targetChecked && !options.force) {
      return true;
    }
    state.hydrating = true;
    this.sync(state);
    try {
      if (state.preview.kind === "create-note") {
        const existingFile = this.resolveTargetFile(state.targetPath);
        state.targetChecked = true;
        state.targetExists = existingFile instanceof TFile;
        state.noChanges = false;
        if (state.targetExists) {
          state.status = "conflict";
          state.conflictLabel = "目标已存在";
          state.message = "";
          // 冲突不是终态：文件被删/改名后下一次重绘应能重新检查并恢复。
          state.targetChecked = false;
          return false;
        }
        if (state.status === "conflict") {
          state.status = "pending";
          state.conflictLabel = "";
          state.message = "";
        }
        state.stats = {
          added: countAgentActionLines(state.preview.content),
          removed: 0,
          truncated: false
        };
        return true;
      }

      const file = this.resolveTargetFile(state.targetPath);
      state.targetChecked = true;
      if (!(file instanceof TFile) || file.extension !== "md") {
        state.targetExists = false;
        state.status = "conflict";
        state.conflictLabel = "目标不存在";
        state.message = "";
        state.stats = null;
        state.diff = null;
        state.targetChecked = false;
        return false;
      }

      const existingContent = await this.app.vault.cachedRead(file);
      if (state.status === "written") {
        return true;
      }
      state.targetExists = true;
      state.existingContent = existingContent;
      state.diff = state.preview.kind === "append-note"
        ? buildAgentActionAppendDiff(existingContent, state.preview.content)
        : computeAgentActionDiff(existingContent, state.preview.content);
      state.stats = toAgentActionChangeStats(state.diff);
      state.noChanges = !state.diff.truncated
        && state.preview.kind === "replace-note"
        && state.diff.added === 0
        && state.diff.removed === 0;
      if (state.status === "conflict") {
        state.status = "pending";
        state.conflictLabel = "";
        state.message = "";
      }
      return true;
    } catch (error) {
      state.status = "error";
      state.message = error instanceof Error && error.message.trim()
        ? `读取目标笔记失败：${error.message.trim()}`
        : "读取目标笔记失败，请稍后重试。";
      state.stats = null;
      state.diff = null;
      return false;
    } finally {
      state.hydrating = false;
      this.sync(state);
    }
  }

  private async execute(
    state: AgentActionCardState,
    conversation: ConversationRecord,
    message: MessageRecord
  ): Promise<void> {
    if (state.status === "executing" || state.status === "written" || state.status === "undoing") {
      return;
    }
    state.status = "executing";
    state.message = "";
    this.sync(state);
    if (
      !state.targetChecked
      || (state.preview.kind !== "create-note" && state.existingContent === null)
    ) {
      const targetValid = await this.hydrate(state, { force: true });
      if (!targetValid) {
        this.sync(state);
        return;
      }
    }
    try {
      const result = await this.executor.execute(state.preview, {
        targetPath: state.targetPath,
        content: state.preview.content,
        expectedExistingContent: state.preview.kind === "create-note"
          ? undefined
          : state.existingContent ?? undefined
      });
      const writtenContent = await this.readFileContent(result.targetPath);
      const details: AgentActionExecutedDetails = {
        previousContent: state.preview.kind === "create-note" ? null : state.existingContent,
        writtenContent,
        content: state.preview.content
      };
      this.markWritten(state, result, details);
      try {
        this.persistWritten(state, conversation, message);
      } catch (error) {
        console.error("Sidet：记录写入状态失败", error);
      }
    } catch (error) {
      if (error instanceof AgentActionStaleTargetError) {
        state.expanded = true;
        const targetValid = await this.hydrate(state, { force: true });
        if (targetValid) {
          state.status = "stale";
          state.message = "";
        }
        this.sync(state);
        return;
      }
      state.status = "error";
      state.message = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "写入失败，请稍后重试。";
      if (state.message.includes("目标路径已存在")) {
        state.status = "conflict";
        state.conflictLabel = "目标已存在";
        state.message = "";
        state.targetChecked = false;
      }
      if (state.message.includes("不是可覆盖的") || state.message.includes("不是可追加的")) {
        state.status = "conflict";
        state.conflictLabel = this.resolveTargetFile(state.targetPath)
          ? "目标不可写"
          : "目标不存在";
        state.message = "";
        state.targetChecked = false;
      }
      if (state.message.includes("目标路径无效")) {
        state.status = "conflict";
        state.conflictLabel = "路径无效";
        state.message = "";
        state.targetChecked = false;
      }
      this.sync(state);
    }
  }

  private async undo(
    state: AgentActionCardState,
    conversation: ConversationRecord,
    message: MessageRecord
  ): Promise<void> {
    const snapshot = state.undoSnapshot;
    if (state.status !== "written" || !snapshot) {
      return;
    }
    if (state.preview.kind !== "create-note" && snapshot.previousContent === null) {
      state.message = "没有可恢复的旧内容，无法撤销。";
      this.sync(state);
      return;
    }
    state.status = "undoing";
    state.message = "";
    this.sync(state);

    const file = this.resolveTargetFile(state.targetPath);
    if (!file) {
      state.status = "written";
      state.message = "目标笔记不存在，无法撤销。";
      this.sync(state);
      return;
    }

    try {
      // 撤销也要先落盘：编辑器里未保存的新输入不能被回收站 / 覆写吞掉。
      await this.executor.flushOpenEditors(state.targetPath);
      const current = await this.app.vault.read(file);
      if (current !== snapshot.writtenContent) {
        state.status = "written";
        state.message = "文件在写入后又有改动，未撤销。";
        this.sync(state);
        return;
      }

      if (state.preview.kind === "create-note") {
        await this.app.fileManager.trashFile(file);
      } else {
        const previousContent = snapshot.previousContent ?? "";
        await this.app.vault.process(file, (existing) => {
          if (existing !== snapshot.writtenContent) {
            throw new Error("文件在写入后又有改动，未撤销。");
          }
          return previousContent;
        });
      }

      state.status = "pending";
      state.undoSnapshot = null;
      state.executedAt = null;
      state.message = "";
      state.conflictLabel = "";
      state.expanded = false;
      try {
        this.options.controller.store.updateMessageAgentAction(conversation.id, message.id, undefined);
      } catch (error) {
        console.error("Sidet：清除写入状态失败", error);
      }
      await this.hydrate(state, { force: true });
      this.sync(state);
      new Notice("已撤销写入", 2600);
    } catch (error) {
      state.status = "written";
      state.message = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "撤销失败，请稍后重试。";
      this.sync(state);
    }
  }

  private markWritten(
    state: AgentActionCardState,
    result: AgentActionResult,
    details?: AgentActionExecutedDetails
  ): void {
    state.status = "written";
    state.executedAt = Date.now();
    state.targetPath = result.targetPath || state.targetPath;
    if (details?.content.trim()) {
      state.preview = {
        ...state.preview,
        targetPath: state.targetPath,
        content: details.content
      };
    }
    state.targetExists = true;
    state.expanded = false;
    state.message = "";
    state.conflictLabel = "";
    const needsPrevious = state.preview.kind !== "create-note";
    state.undoSnapshot = details && details.writtenContent
      && (!needsPrevious || details.previousContent !== null)
      ? {
          previousContent: details.previousContent,
          writtenContent: details.writtenContent
        }
      : null;
    this.sync(state);
  }

  private getActionTitle(kind: AgentActionPreview["kind"]): string {
    switch (kind) {
      case "create-note":
        return "新建笔记";
      case "append-note":
        return "追加到笔记";
      case "replace-note":
        return "覆写笔记";
      case "replace-selection":
        return "替换选区";
      case "replace-section":
        return "替换小节";
      default:
        return "文件动作";
    }
  }

  private getAgreeLabel(kind: AgentActionPreview["kind"], retry: boolean): string {
    switch (kind) {
      case "create-note":
        return retry ? "重新确认创建" : "同意创建";
      case "append-note":
        return retry ? "重新确认追加" : "同意追加";
      case "replace-note":
        return retry ? "重新确认覆写" : "同意覆写";
      default:
        return "同意";
    }
  }

  private resolveTargetFile(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  private async readFileContent(path: string): Promise<string> {
    const file = this.resolveTargetFile(path);
    if (!file) {
      return "";
    }
    try {
      return await this.app.vault.read(file);
    } catch {
      return "";
    }
  }

  private async openTarget(state: AgentActionCardState): Promise<void> {
    const file = this.resolveTargetFile(state.targetPath);
    if (!file) {
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  private openAdjustModal(
    state: AgentActionCardState,
    conversation: ConversationRecord,
    message: MessageRecord
  ): void {
    new AgentActionPreviewModal(this.options.controller, state.preview, {
      title: this.getActionTitle(state.preview.kind),
      onExecuted: (result, details) => {
        this.markWritten(state, result, details);
        try {
          this.persistWritten(state, conversation, message);
        } catch (error) {
          console.error("Sidet：记录写入状态失败", error);
        }
      }
    }).open();
  }

  private persistWritten(
    state: AgentActionCardState,
    conversation: ConversationRecord,
    message: MessageRecord
  ): void {
    this.options.controller.store.updateMessageAgentAction(conversation.id, message.id, {
      signature: state.signature,
      targetPath: state.targetPath,
      executedAt: state.executedAt ?? Date.now()
    });
  }
}
