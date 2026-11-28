import {
  addIcon,
  MarkdownView,
  Notice,
  ObsidianProtocolData,
  Platform,
  Plugin,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import {
  BROWSER_VIEW_TYPE,
  CHAT_VIEW_TYPE,
  DEFAULT_RUNTIME_STATE,
  DEFAULT_SETTINGS,
  PLUGIN_NAME,
  SIDET_OPEN_CHAT_ACTION,
  SIDET_URL_LAUNCH_ACTION
} from "./constants";
import { ConversationSession } from "./conversations/conversation-session";
import { ConversationFiles } from "./conversations/conversation-files";
import { ConversationStore } from "./conversations/conversation-store";
import { VaultAgentService } from "./agent/vault-agent";
import { ActiveContextService } from "./context/active-context";
import { WebSearchService } from "./context/web-search-service";
import { MarkdownExportService } from "./export/markdown-export";
import { SiliconFlowProvider } from "./provider/siliconflow-provider";
import { normalizePluginData } from "./settings/model";
import { DialogSettingTab } from "./settings/setting-tab";
import { SecretStorageService } from "./settings/secret-storage";
import { ArchivedConversationsModal } from "./settings/archived-conversations-modal";
import type { DialogPluginSettings, DialogRuntimeState } from "./types";
import { BrowserView } from "./workspace/browser-view";
import { ChatView } from "./workspace/chat-view";
import { WorkspaceController } from "./workspace/workspace-controller";
import {
  IOS_KEYBOARD_PHASE_DIAGNOSTIC_BUILD,
  serializeIosKeyboardPhaseDiagnostics
} from "./workspace/chat-view-mobile-keyboard-phase-diagnostics";
import {
  MOBILE_HOME_LIFECYCLE_DIAGNOSTIC_BUILD,
  serializeMobileHomeLifecycleDiagnostics
} from "./workspace/chat-view-mobile-home-lifecycle-diagnostics";
import {
  MOBILE_INPUT_PROBE_BUILD,
  serializeMobileInputProbe
} from "./workspace/chat-view-mobile-input-probe";

const SIDET_STAR_OUTLINE_ICON_ID = "sidet-star-outline";
const SIDET_STAR_FILLED_ICON_ID = "sidet-star-filled";
const SIDET_IOS_INPUT_DIAGNOSTIC_ACTION =
  "sidet-ios-input-diagnostic";
const SIDET_STAR_OUTLINE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;
const SIDET_STAR_FILLED_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;

/** Android-only body class for the host 1.15 mobile button-token fix (styles.css). */
const SIDET_ANDROID_CLASS = "sidet-android";
/** iOS-only body class for the same host 1.15 mobile button-token fix (styles.css). */
const SIDET_IOS_CLASS = "sidet-ios";

export default class SidetPlugin extends Plugin {
  override settings: DialogPluginSettings = DEFAULT_SETTINGS;
  runtimeState: DialogRuntimeState = DEFAULT_RUNTIME_STATE;
  private secrets!: SecretStorageService;
  private store!: ConversationStore;
  private session!: ConversationSession;
  private controller!: WorkspaceController;
  private startupBrowserBootstrapTimer: number | null = null;
  private disposeNativeNewTabTakeover: (() => void) | null = null;

  private handleOpenChatUri = (params: ObsidianProtocolData): void => {
    const focusComposer = params.focus !== "false" && params.focus !== "0";
    const text = typeof params.text === "string" ? params.text : "";
    const append = params.append === "true" || params.append === "1";
    const clipboard = params.clipboard === "true" || params.clipboard === "1";
    void this.controller.openChatFromUri({
      focusComposer,
      text,
      append,
      clipboard
    });
  };

  private handleUrlLaunchUri = (params: ObsidianProtocolData): void => {
    const rawSlot = typeof params.slot === "string" ? Number.parseInt(params.slot, 10) : Number.NaN;
    if (!Number.isInteger(rawSlot) || rawSlot < 1) {
      new Notice("URL 启动入口参数无效。", 2800);
      return;
    }

    const launcher = this.settings.urlLaunchers.find((item) => item.slot === rawSlot);
    if (!launcher) {
      new Notice(`URL 启动入口 ${rawSlot} 未设置。`, 2800);
      return;
    }

    void this.controller.executeHomePinnedCommand(launcher.commandId);
  };

  private handleIosInputDiagnosticUri = (): void => {
    void this.copyIosKeyboardPhaseDiagnostic();
  };

  private registerSidetIcons(): void {
    addIcon(SIDET_STAR_OUTLINE_ICON_ID, SIDET_STAR_OUTLINE_ICON_SVG);
    addIcon(SIDET_STAR_FILLED_ICON_ID, SIDET_STAR_FILLED_ICON_SVG);
  }

  override async onload(): Promise<void> {
    if (Platform.isAndroidApp && typeof document !== "undefined") {
      document.body.classList.add(SIDET_ANDROID_CLASS);
    }
    if (Platform.isIosApp && typeof document !== "undefined") {
      document.body.classList.add(SIDET_IOS_CLASS);
    }
    this.registerSidetIcons();
    const rawData: unknown = await this.loadData();
    const data = normalizePluginData(rawData);
    this.settings = data.settings;
    this.runtimeState = data.runtimeState;
    this.secrets = new SecretStorageService(this.app);
    const rawSettings = rawData && typeof rawData === "object"
      ? ("settings" in (rawData as Record<string, unknown>) && typeof (rawData as Record<string, unknown>).settings === "object"
        ? (rawData as { settings?: Record<string, unknown> }).settings ?? {}
        : rawData as Record<string, unknown>)
      : {};
    const usedLegacyModelConfigs = !Array.isArray(rawSettings.modelConfigs);
    if (usedLegacyModelConfigs) {
      const defaultModelConfig = this.settings.modelConfigs.find(
        (config) => config.id === this.settings.defaultModelConfigId
      ) ?? this.settings.modelConfigs[0];
      if (defaultModelConfig) {
        this.secrets.migrateLegacyProviderApiKey(defaultModelConfig.providerId, defaultModelConfig.id);
      }
    }

    const files = new ConversationFiles(this.app);
    this.store = new ConversationStore(files);
    const storeLoadTask = this.store.startBackgroundLoad();

    const provider = new SiliconFlowProvider();
    this.session = new ConversationSession(
      this.store,
      provider,
      (modelConfigId) => this.secrets.getModelApiKey(modelConfigId)
    );

    this.controller = new WorkspaceController(
      this.app,
      this.store,
      this.session,
      new MarkdownExportService(this.app),
      new ActiveContextService(this.app),
      new WebSearchService(),
      new VaultAgentService(this.app),
      () => this.settings,
      () => this.savePluginSettings()
    );

    this.registerView(
      BROWSER_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new BrowserView(leaf, this.controller)
    );
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new ChatView(leaf, this.controller)
    );

    this.addRibbonIcon("messages-square", `打开 ${PLUGIN_NAME}`, () => {
      void this.controller.openWorkspace();
    });

    this.addCommand({
      id: "open-sidet-workspace",
      name: "打开 Sidet",
      icon: "messages-square",
      callback: () => {
        void this.controller.openWorkspace();
      }
    });

    this.addCommand({
      id: "open-sidet-conversation-list",
      name: "打开对话列表",
      icon: "panel-right-open",
      callback: () => {
        void this.controller.openBrowserView();
      }
    });

    this.addCommand({
      id: "new-sidet-conversation",
      name: "新建对话",
      icon: "message-circle-plus",
      callback: () => {
        void this.controller.openNewChatTab();
      }
    });

    this.addCommand({
      id: "export-current-sidet-conversation",
      name: "导出当前对话",
      icon: "download",
      checkCallback: (checking) => {
        const leaf = this.getActiveConversationLeaf();
        if (!leaf) {
          return false;
        }
        if (!checking) {
          void this.controller.exportConversationForLeaf(leaf).catch((error) => {
            this.controller.showSendError(error);
          });
        }
        return true;
      }
    });

    this.addCommand({
      id: "insert-active-note-into-sidet-draft",
      name: "插入当前笔记到对话草稿",
      icon: "file-text",
      checkCallback: (checking) => {
        if (!this.getActiveMarkdownFile()) {
          return false;
        }
        if (!checking) {
          void this.controller.insertCurrentNoteIntoDraft();
        }
        return true;
      }
    });

    this.addCommand({
      id: "insert-active-selection-into-sidet-draft",
      name: "插入当前选区到对话草稿",
      icon: "text-cursor-input",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || view.editor.getSelection().trim().length === 0) {
          return false;
        }
        if (!checking) {
          void this.controller.insertCurrentSelectionIntoDraft();
        }
        return true;
      }
    });

    // 排障命令：不属于 8 条公共产品命令，仅用于移动输入真机取证。
    this.addCommand({
      id: "export-mobile-input-diagnostic",
      name: "导出移动输入诊断（排障）",
      callback: () => {
        void this.exportMobileInputDiagnostic();
      }
    });

    this.addSettingTab(new DialogSettingTab(this.app, this, this.secrets));

    this.registerObsidianProtocolHandler(SIDET_OPEN_CHAT_ACTION, this.handleOpenChatUri);
    this.registerObsidianProtocolHandler(SIDET_URL_LAUNCH_ACTION, this.handleUrlLaunchUri);
    this.registerObsidianProtocolHandler(
      SIDET_IOS_INPUT_DIAGNOSTIC_ACTION,
      this.handleIosInputDiagnosticUri
    );

    this.disposeNativeNewTabTakeover = this.controller.installNativeNewTabTakeover();
    this.register(() => {
      this.disposeNativeNewTabTakeover?.();
      this.disposeNativeNewTabTakeover = null;
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.controller.handleActiveLeafChange();
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.controller.handleLayoutChange();
      })
    );
    this.app.workspace.onLayoutReady(() => {
      this.controller.handleLayoutReady();
      this.scheduleDeferredBrowserBootstrap();
    });

    void storeLoadTask
      .then(() => {
        this.controller.handleConversationStoreReady();
      })
      .catch((error) => {
        console.error("Sidet：启动时恢复会话索引失败", error);
      });
  }

  override onunload(): void {
    if (typeof document !== "undefined") {
      document.body.classList.remove(SIDET_ANDROID_CLASS);
      document.body.classList.remove(SIDET_IOS_CLASS);
    }
    void this.runUnloadTasks().catch((error) => {
      console.error("Sidet：卸载时清理失败", error);
    });
  }

  private async runUnloadTasks(): Promise<void> {
    await this.persistPluginData();
    if (this.startupBrowserBootstrapTimer !== null) {
      window.clearTimeout(this.startupBrowserBootstrapTimer);
      this.startupBrowserBootstrapTimer = null;
    }
    this.disposeNativeNewTabTakeover?.();
    this.disposeNativeNewTabTakeover = null;
    this.controller?.destroy();
    this.session?.stop();
    await this.controller?.flush();
    await this.store?.flush();
  }

  async savePluginSettings(): Promise<void> {
    await this.persistPluginData();
    await this.controller?.handleSettingsChanged();
    this.controller?.refreshHomeViews();
  }

  async openArchivedConversationsManager(): Promise<void> {
    await this.store.ensureLoaded();
    new ArchivedConversationsModal(this.app, this.controller).open();
  }



  private getActiveConversationLeaf(): WorkspaceLeaf | null {
    const leaf = this.app.workspace.activeLeaf;
    if (leaf?.getViewState().type !== CHAT_VIEW_TYPE) {
      return null;
    }
    return this.controller.getConversationForLeaf(leaf) ? leaf : null;
  }

  private getActiveMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    return file instanceof TFile && file.extension === "md" ? file : null;
  }

  private async copyIosKeyboardPhaseDiagnostic(): Promise<void> {
    const report = [
      serializeIosKeyboardPhaseDiagnostics(),
      "",
      serializeMobileHomeLifecycleDiagnostics()
    ].join("\n");
    await this.copyDiagnosticText(
      report,
      `已复制 iPhone 输入诊断（${MOBILE_HOME_LIFECYCLE_DIAGNOSTIC_BUILD} / ${IOS_KEYBOARD_PHASE_DIAGNOSTIC_BUILD}）。`,
      "复制 iPhone 键盘相位诊断失败。"
    );
  }

  private async exportMobileInputDiagnostic(): Promise<void> {
    const traceHost = window as typeof window & {
      __SIDET_SCROLL_TRACE__?: Array<Record<string, unknown>>;
    };
    const trace = Array.isArray(traceHost.__SIDET_SCROLL_TRACE__)
      ? traceHost.__SIDET_SCROLL_TRACE__.slice(-40)
      : [];
    // 排障命令必须带主页输入生命周期（点按 → 换层 → focus → blur 及新焦点
    // 持有者）；只导出探针样本无法区分「宿主提前聚焦」与「换层后丢焦点」。
    const report = [
      serializeMobileInputProbe({ final: null, scrollTrace: trace }),
      "",
      serializeMobileHomeLifecycleDiagnostics()
    ].join("\n");
    // 手机剪贴板会把长文本截断（安卓实测 5000 字符），排障报告直接落库文件；
    // 写入失败才回退剪贴板（桌面环境）。
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    try {
      const file = await this.app.vault.create(
        `Sidet 移动输入诊断 ${stamp}.json`,
        report
      );
      new Notice(`已生成移动输入诊断：${file.path}`, 6000);
      return;
    } catch (error) {
      console.warn("Sidet：写入移动输入诊断文件失败，回退到剪贴板。", error);
    }
    await this.copyDiagnosticText(
      report,
      `已复制移动输入诊断（${MOBILE_INPUT_PROBE_BUILD}）。`,
      "复制移动输入诊断失败。"
    );
  }

  private async copyDiagnosticText(
    report: string,
    successNotice: string,
    failureNotice: string
  ): Promise<void> {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        new Notice(successNotice, 3200);
        return;
      }
    } catch (error) {
      console.warn("Sidet：原生诊断复制失败，尝试降级。", error);
    }

    const textareaEl = createEl("textarea");
    textareaEl.value = report;
    textareaEl.setAttribute("readonly", "true");
    textareaEl.setCssProps({
      position: "fixed",
      left: "-9999px",
      top: "0",
      opacity: "0"
    });
    document.body.appendChild(textareaEl);
    textareaEl.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      textareaEl.remove();
    }

    if (!copied) {
      new Notice(failureNotice, 3200);
      return;
    }
    new Notice(successNotice, 3200);
  }

  private async persistPluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      runtimeState: this.runtimeState
    });
  }

  private scheduleDeferredBrowserBootstrap(): void {
    if (this.startupBrowserBootstrapTimer !== null) {
      window.clearTimeout(this.startupBrowserBootstrapTimer);
    }

    this.startupBrowserBootstrapTimer = window.setTimeout(() => {
      this.startupBrowserBootstrapTimer = null;
      void this.controller.ensureBrowserViewOpen().catch((error) => {
        console.error("Sidet：启动时恢复对话列表失败", error);
      });
    }, 1200);
  }

}
