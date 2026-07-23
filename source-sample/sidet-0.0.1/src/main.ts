import { Notice, Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  SidetPlaceholderSettingTab,
  type SidetPlaceholderSettings
} from "./settings";

const SOURCE_SAMPLE_NOTICE =
  "This frozen source sample does not include Sidet product features.";

export default class SidetPlaceholderPlugin extends Plugin {
  settings: SidetPlaceholderSettings = { ...DEFAULT_SETTINGS };

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.addRibbonIcon("message-circle", "Show source sample notice", () => {
      this.showSourceSampleNotice();
    });

    this.addCommand({
      id: "show-source-sample-notice",
      name: "Show source sample notice",
      callback: () => {
        this.showSourceSampleNotice();
      }
    });

    this.addSettingTab(new SidetPlaceholderSettingTab(this.app, this));

    if (this.settings.showNoticeOnLoad) {
      this.app.workspace.onLayoutReady(() => {
        this.showSourceSampleNotice();
      });
    }
  }

  async loadSettings(): Promise<void> {
    const stored =
      (await this.loadData()) as Partial<SidetPlaceholderSettings> | null;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      showNoticeOnLoad: Boolean(stored?.showNoticeOnLoad)
    };
  }

  async updateSettings(
    patch: Partial<SidetPlaceholderSettings>
  ): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await this.saveData(this.settings);
  }

  private showSourceSampleNotice(): void {
    new Notice(SOURCE_SAMPLE_NOTICE);
  }
}
