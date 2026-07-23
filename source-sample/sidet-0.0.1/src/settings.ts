import { PluginSettingTab, Setting, type App } from "obsidian";
import type SidetPlaceholderPlugin from "./main";

export interface SidetPlaceholderSettings {
  showNoticeOnLoad: boolean;
}

export const DEFAULT_SETTINGS: SidetPlaceholderSettings = {
  showNoticeOnLoad: false
};

export class SidetPlaceholderSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SidetPlaceholderPlugin
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show source sample notice on load")
      .setDesc(
        "Displays a notice that this frozen sample excludes Sidet product features."
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showNoticeOnLoad)
          .onChange(async value => {
            await this.plugin.updateSettings({ showNoticeOnLoad: value });
          })
      );
  }
}
