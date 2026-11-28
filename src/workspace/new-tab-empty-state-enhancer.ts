import { Notice, Platform, setIcon, WorkspaceLeaf } from "obsidian";
import type { App } from "obsidian";
import type { WorkspaceLeafNavigation } from "./workspace-leaf-navigation";

const EMPTY_VIEW_TYPE = "empty";
const ACTION_MARKER_ATTR = "data-sidet-empty-tab-action";
const ACTION_LABEL = "打开 Sidet";
const ACTION_ICON_ID = "bot-message-square";
const RETRY_DELAY_MS = 48;

/**
 * 桌面原生空白页动作列表里的「打开 Sidet」入口（2026-11-27 按 Resojot 同件移植）。
 *
 * 只做追加：不接管 empty 视图、不改三态仲裁、不注册公共命令。点击后在当前
 * 空白叶子挂一个新的 Sidet 对话，原 Sidet 页保留，用来支持并行多对话。
 *
 * 宿主边界：1.14+ 的空白页动作是「图标壳 + 文字」结构，旧宿主可能没有
 * `.empty-state-action-list`；没有列表时静默不显示，不另做自绘空白视图。
 * 移动端空白页没有同款动作列表，先只在桌面启用，真机确认后再决定。
 */
export class WorkspaceNewTabEmptyStateEnhancer {
  private refreshFrameId: number | null = null;
  private refreshRetryTimerId: number | null = null;
  private pendingRetryCount = 0;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly leafNavigation: WorkspaceLeafNavigation
  ) {}

  scheduleRefresh(retryCount = 0): void {
    if (this.disposed || !Platform.isDesktopApp || !this.hasEmptyLeaves()) {
      return;
    }
    this.pendingRetryCount = Math.max(this.pendingRetryCount, retryCount);
    if (this.refreshFrameId !== null || this.refreshRetryTimerId !== null) {
      return;
    }

    const runRefresh = (): void => {
      this.refreshFrameId = null;
      const needsRetry = this.refresh();
      if (!needsRetry || this.pendingRetryCount <= 0) {
        this.pendingRetryCount = 0;
        return;
      }

      this.pendingRetryCount -= 1;
      this.refreshRetryTimerId = window.setTimeout(() => {
        this.refreshRetryTimerId = null;
        this.scheduleRefresh(0);
      }, RETRY_DELAY_MS);
    };

    if (typeof window.requestAnimationFrame === "function") {
      this.refreshFrameId = window.requestAnimationFrame(runRefresh);
      return;
    }

    runRefresh();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelScheduledRefresh();
    this.pendingRetryCount = 0;
    // 卸载时清掉自己注入的按钮，避免禁用 / 重载后残留无响应的死按钮。
    for (const leaf of this.getEmptyLeaves()) {
      leaf.view.containerEl
        .querySelectorAll(`[${ACTION_MARKER_ATTR}]`)
        .forEach((element) => element.remove());
    }
  }

  private cancelScheduledRefresh(): void {
    if (this.refreshFrameId !== null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(this.refreshFrameId);
    }
    if (this.refreshRetryTimerId !== null) {
      window.clearTimeout(this.refreshRetryTimerId);
    }
    this.refreshFrameId = null;
    this.refreshRetryTimerId = null;
  }

  private refresh(): boolean {
    if (this.disposed || !Platform.isDesktopApp) {
      return false;
    }
    let needsRetry = false;

    for (const leaf of this.getEmptyLeaves()) {
      const actionList = leaf.view.containerEl.querySelector(".empty-state-action-list");
      if (!(actionList instanceof HTMLElement)) {
        needsRetry = true;
        continue;
      }

      const template = actionList.querySelector(
        `.empty-state-action:not([${ACTION_MARKER_ATTR}])`
      );
      const existing = actionList.querySelector(`[${ACTION_MARKER_ATTR}]`);
      if (existing instanceof HTMLElement) {
        const existingHasIcon = existing.querySelector(".text-button-icon") !== null;
        const templateHasIcon = template?.querySelector(".text-button-icon") != null;
        const stale =
          existing.textContent !== ACTION_LABEL || existingHasIcon !== templateHasIcon;
        if (!stale) {
          continue;
        }
        existing.remove();
      }

      actionList.appendChild(this.createActionElement(template, leaf));
    }

    return needsRetry;
  }

  private getEmptyLeaves(): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(EMPTY_VIEW_TYPE);
  }

  private hasEmptyLeaves(): boolean {
    return this.getEmptyLeaves().length > 0;
  }

  private createActionElement(template: Element | null, leaf: WorkspaceLeaf): HTMLElement {
    const action = template instanceof HTMLElement
      ? (template.cloneNode(false) as HTMLElement)
      : createDiv();

    action.className = template instanceof HTMLElement
      ? template.className
      : "empty-state-action";
    action.removeAttribute("href");
    action.removeAttribute("target");
    action.removeAttribute("rel");
    action.setAttribute(ACTION_MARKER_ATTR, "true");
    action.setAttribute("aria-label", ACTION_LABEL);

    // 1.14+ 官方动作是 text-button-icon（图标）+ text-button-label（文字）结构；
    // 旧宿主模板没有图标壳，保持纯文字。
    if (template?.querySelector(".text-button-icon")) {
      const iconHost = createSpan("text-button-icon");
      setIcon(iconHost, ACTION_ICON_ID);
      action.appendChild(iconHost);
      const labelHost = createSpan("text-button-label");
      labelHost.textContent = ACTION_LABEL;
      action.appendChild(labelHost);
    } else {
      action.textContent = ACTION_LABEL;
    }

    action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openChatInLeaf(leaf);
    });

    return action;
  }

  private async openChatInLeaf(leaf: WorkspaceLeaf): Promise<void> {
    try {
      await this.leafNavigation.mountFreshChatLeaf(leaf, {
        activate: true,
        focusComposer: true
      });
    } catch (error) {
      console.error("Sidet：从空白页打开对话失败", error);
      new Notice("打开对话失败，请重试。", 3600);
    }
  }
}
