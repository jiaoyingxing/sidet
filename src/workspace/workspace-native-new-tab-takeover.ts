import { App, WorkspaceLeaf } from "obsidian";
import { CHAT_VIEW_TYPE } from "../constants";
import {
  getCommandRegistry,
  getRegistryCommand
} from "../commands/command-registry";
import {
  isLeafInSideDock,
  WorkspaceLeafNavigation
} from "./workspace-leaf-navigation";

const EMPTY_VIEW_TYPE = "empty";

export class WorkspaceNativeNewTabTakeover {
  private readonly patchedCommandRestorers: Array<() => void> = [];
  private readonly suppressedNativeEmptyLeaves = new WeakSet<WorkspaceLeaf>();
  private pendingNativeEmptyLeaf: WorkspaceLeaf | null = null;
  private nativeNewTabRecoveryTask: Promise<void> | null = null;
  private nativeNewTabArbitrationTask: Promise<void> = Promise.resolve();
  private lastObservedActiveLeaf: WorkspaceLeaf | null = null;
  private pendingRecoveryOriginLeaf: WorkspaceLeaf | null = null;

  constructor(
    private readonly app: App,
    private readonly leafNavigation: WorkspaceLeafNavigation
  ) {}

  async openNativeNewTab(): Promise<WorkspaceLeaf> {
    const leaf = this.app.workspace.getLeaf("tab");
    if (!leaf) {
      throw new Error("无法创建原生标签页。");
    }

    this.pendingNativeEmptyLeaf = leaf;
    try {
      await leaf.setViewState({
        ...leaf.getViewState(),
        type: EMPTY_VIEW_TYPE,
        state: {},
        active: true
      });
      this.suppressedNativeEmptyLeaves.add(leaf);
    } finally {
      if (this.pendingNativeEmptyLeaf === leaf) {
        this.pendingNativeEmptyLeaf = null;
      }
    }

    await leaf.loadIfDeferred();
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return leaf;
  }

  install(): () => void {
    this.lastObservedActiveLeaf = this.app.workspace.activeLeaf;
    this.patchEmptyRootLeafTakeover();

    const candidateIds = [
      "workspace:new-tab",
      "app:new-tab"
    ];
    for (const commandId of candidateIds) {
      this.patchNativeNewTabCommand(commandId);
    }

    return () => {
      this.destroy();
    };
  }

  scheduleRecovery(): void {
    this.captureActiveLeafTransition();
    if (this.nativeNewTabRecoveryTask) {
      return;
    }

    let task: Promise<void> | null = null;
    task = Promise.resolve()
      .then(() => {
        const originLeaf = this.pendingRecoveryOriginLeaf;
        this.pendingRecoveryOriginLeaf = null;
        return Promise.resolve().then(() => this.recoverNativeNewTabLeaf(originLeaf));
      })
      .catch((error) => {
        console.error("Sidet：原生新标签兜底挂载失败", error);
      })
      .finally(() => {
        if (this.nativeNewTabRecoveryTask === task) {
          this.nativeNewTabRecoveryTask = null;
        }
      });
    this.nativeNewTabRecoveryTask = task;
  }

  destroy(): void {
    while (this.patchedCommandRestorers.length > 0) {
      const restore = this.patchedCommandRestorers.pop();
      restore?.();
    }
  }

  private async openArbitratedNativeNewTab(): Promise<WorkspaceLeaf> {
    const homepageLeaf = this.leafNavigation.getHomepageLeaf();
    if (homepageLeaf && this.leafNavigation.getActiveChatLeaf() === homepageLeaf) {
      return this.openNativeNewTab();
    }
    return this.leafNavigation.openNewChatTab();
  }

  private queueArbitratedNativeNewTab(): void {
    this.nativeNewTabArbitrationTask = this.nativeNewTabArbitrationTask
      .then(() => this.openArbitratedNativeNewTab())
      .then(() => undefined)
      .catch((error) => {
        console.error("Sidet：原生新标签仲裁失败", error);
      });
  }

  private async recoverNativeNewTabLeaf(originLeaf: WorkspaceLeaf | null): Promise<void> {
    const candidateLeaf = this.getRecoverableEmptyRootLeaf();
    if (!candidateLeaf) {
      return;
    }

    const homepageLeaf = this.leafNavigation.getHomepageLeaf();
    if (homepageLeaf) {
      if (!originLeaf || originLeaf === homepageLeaf) {
        return;
      }
      await this.leafNavigation.openNewChatTab();
      if (this.isRecoverableEmptyRootLeaf(candidateLeaf)) {
        candidateLeaf.detach();
      }
      return;
    }

    await this.leafNavigation.mountFreshChatLeaf(candidateLeaf, {
      activate: true,
      focusComposer: true
    });
  }

  private captureActiveLeafTransition(): void {
    const currentActiveLeaf = this.app.workspace.activeLeaf;
    if (!currentActiveLeaf || currentActiveLeaf === this.lastObservedActiveLeaf) {
      return;
    }
    this.pendingRecoveryOriginLeaf = this.lastObservedActiveLeaf;
    this.lastObservedActiveLeaf = currentActiveLeaf;
  }

  private getRecoverableEmptyRootLeaf(): WorkspaceLeaf | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (this.isRecoverableEmptyRootLeaf(activeLeaf)) {
      return activeLeaf;
    }

    const mostRecentRootLeaf = this.leafNavigation.getMostRecentRootLeaf();
    if (this.isRecoverableEmptyRootLeaf(mostRecentRootLeaf)) {
      return mostRecentRootLeaf;
    }

    return null;
  }

  private isRecoverableEmptyRootLeaf(leaf: WorkspaceLeaf | null): leaf is WorkspaceLeaf {
    if (!leaf) {
      return false;
    }
    return this.shouldInterceptEmptyRootLeaf(leaf, leaf.getViewState());
  }

  private patchEmptyRootLeafTakeover(): void {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- 刻意提取原型方法用于包装与恢复，调用时显式 .call(this) 传入 leaf
    const originalSetViewState = WorkspaceLeaf.prototype.setViewState;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 原型补丁需要同时保留动态 this（leaf）并捕获插件实例
    const takeover = this;

    const patchedSetViewState: WorkspaceLeaf["setViewState"] = function(
      this: WorkspaceLeaf,
      viewState,
      eState
    ) {
      const intercepted = takeover.interceptEmptyRootLeafSetViewState(this, viewState);
      if (intercepted) {
        return intercepted;
      }
      return originalSetViewState.call(this, viewState, eState);
    };

    WorkspaceLeaf.prototype.setViewState = patchedSetViewState;
    this.patchedCommandRestorers.push(() => {
      if (WorkspaceLeaf.prototype.setViewState === patchedSetViewState) {
        WorkspaceLeaf.prototype.setViewState = originalSetViewState;
      }
    });
  }

  private interceptEmptyRootLeafSetViewState(
    leaf: WorkspaceLeaf,
    viewState: ReturnType<WorkspaceLeaf["getViewState"]>
  ): Promise<void> | null {
    if (!this.shouldInterceptEmptyRootLeaf(leaf, viewState)) {
      return null;
    }

    if (this.leafNavigation.getHomepageLeaf()) {
      return null;
    }

    return this.leafNavigation.mountFreshChatLeaf(leaf, {
      activate: true,
      focusComposer: true
    });
  }

  private shouldInterceptEmptyRootLeaf(
    leaf: WorkspaceLeaf,
    viewState: ReturnType<WorkspaceLeaf["getViewState"]>
  ): boolean {
    if (leaf === this.pendingNativeEmptyLeaf) {
      return false;
    }
    if (viewState.type !== EMPTY_VIEW_TYPE) {
      this.suppressedNativeEmptyLeaves.delete(leaf);
      return false;
    }
    if (this.suppressedNativeEmptyLeaves.has(leaf)) {
      return false;
    }
    if (leaf.getViewState().type === CHAT_VIEW_TYPE) {
      // Opening a file may temporarily navigate the current Sidet leaf through
      // `empty`; do not let the new-tab fallback steal that file-open flow.
      this.suppressedNativeEmptyLeaves.add(leaf);
      return false;
    }
    if (isLeafInSideDock(leaf) || leaf.getContainer() !== this.app.workspace.rootSplit) {
      return false;
    }

    const state = viewState.state;
    return !state || Object.keys(state).length === 0;
  }

  private patchNativeNewTabCommand(commandId: string): void {
    const registry = getCommandRegistry(this.app);
    const command = getRegistryCommand(registry, commandId);
    if (!command) {
      return;
    }

    const originalCallback = command.callback;
    const originalCheckCallback = command.checkCallback;
    command.callback = () => {
      this.queueArbitratedNativeNewTab();
    };
    command.checkCallback = (checking: boolean) => {
      if (checking) {
        return true;
      }
      this.queueArbitratedNativeNewTab();
      return true;
    };

    this.patchedCommandRestorers.push(() => {
      command.callback = originalCallback;
      command.checkCallback = originalCheckCallback;
    });
  }
}
