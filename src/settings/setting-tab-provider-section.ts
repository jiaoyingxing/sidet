import {
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  SettingGroup,
  setIcon,
  setTooltip,
  type App
} from "obsidian";
import type SidetPlugin from "../main";
import type { ModelConfigRecord } from "../types";
import { getProviderLabel } from "./model-configs";
import { ModelConfigSetupModal } from "./model-config-setup-modal";
import type { SecretStorageService } from "./secret-storage";

const NON_DEFAULT_MODEL_ICON_ID = "sidet-star-outline";
const DEFAULT_MODEL_ICON_ID = "sidet-star-filled";

function createIconActionButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void,
  extraClass = ""
): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: `clickable-icon sidet-settings-model-config-action${extraClass ? ` ${extraClass}` : ""}`,
    attr: {
      type: "button",
      "aria-label": label
    }
  });
  setIcon(button, icon);
  setTooltip(button, label);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

class DeleteModelConfigConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly modelName: string,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("删除模型项");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `确定删除“${this.modelName}”吗？`
    });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "正在使用这条模型的对话会回退到当前默认模型。"
    });

    const actions = new Setting(this.contentEl);
    actions.setClass("sidet-model-config-actions-setting");
    actions.infoEl.remove();

    new ButtonComponent(actions.controlEl)
      .setButtonText("取消")
      .onClick(() => {
        this.close();
      });

    new ButtonComponent(actions.controlEl)
      .setWarning()
      .setButtonText("删除")
      .onClick(() => {
        void this.confirm();
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async confirm(): Promise<void> {
    await this.onConfirm();
    this.close();
  }
}

export function renderProviderSettingsSection(
  containerEl: HTMLElement,
  plugin: SidetPlugin,
  secrets: SecretStorageService,
  rerender: () => void
): void {
  const group = new SettingGroup(containerEl).setHeading("模型服务");
  group.addSetting((setting) => {
    configureProviderModelRow(setting, plugin, secrets, rerender);
  });
}

/**
 * 模型列表行配置：display() 组路径与声明式子页「模型服务」页 render 回调共用
 * （方案单 §四）。返回列表挂载元素——声明式轨道据此做行内列表重建（不整节重建）；
 * display() 轨道沿用传入的整节重建 rerender。
 */
export function configureProviderModelRow(
  setting: Setting,
  plugin: SidetPlugin,
  secrets: SecretStorageService,
  refresh: () => void
): HTMLElement {
  setting
    .setName("模型列表")
    .setClass("sidet-settings-model-config-setting")
    .addButton((button) => {
      button
        .setCta()
        .setButtonText("新增模型")
        .onClick(() => {
          new ModelConfigSetupModal(plugin.app, {
            title: "新增模型",
            onSave: async ({ config, apiKey }) => {
              plugin.settings.modelConfigs = [...plugin.settings.modelConfigs, config];
              if (!plugin.settings.defaultModelConfigId) {
                plugin.settings.defaultModelConfigId = config.id;
              }
              secrets.setModelApiKey(config.id, apiKey);
              await plugin.savePluginSettings();
              refresh();
            }
          }).open();
        });
      });

  const listEl = setting.settingEl.createDiv({ cls: "sidet-settings-model-config-list" });
  renderModelConfigList(listEl, plugin, secrets, refresh);
  return listEl;
}

/** 声明式轨道的模型列表行内重建入口（由 setting-tab 以持元素方式调用）。 */
export function renderModelConfigList(
  listEl: HTMLElement,
  plugin: SidetPlugin,
  secrets: SecretStorageService,
  rerender: () => void
): void {
  listEl.empty();
  const modelConfigs = plugin.settings.modelConfigs;
  if (modelConfigs.length === 0) {
    listEl.createDiv({
      cls: "sidet-settings-model-config-empty",
      text: "还没有模型。"
    });
    return;
  }

  const rowsEl = listEl.createDiv({ cls: "sidet-settings-model-config-rows" });
  for (const config of modelConfigs) {
    renderModelConfigRow(rowsEl, config, plugin, secrets, rerender);
  }
}

function renderModelConfigRow(
  parent: HTMLElement,
  config: ModelConfigRecord,
  plugin: SidetPlugin,
  secrets: SecretStorageService,
  rerender: () => void
): void {
  const isDefault = plugin.settings.defaultModelConfigId === config.id;
  const rowEl = parent.createDiv({ cls: "sidet-settings-model-config-row" });
  const identityEl = rowEl.createDiv({ cls: "sidet-settings-model-config-identity" });
  const textEl = identityEl.createDiv({ cls: "sidet-settings-model-config-text" });
  textEl.createDiv({
    cls: "sidet-settings-model-config-name",
    text: getProviderLabel(config.providerId, config.providerLabel)
  });

  textEl.createDiv({
    cls: "sidet-settings-model-config-meta",
    text: config.model
  });

  const actionsEl = rowEl.createDiv({ cls: "sidet-settings-model-config-actions" });
  createIconActionButton(
    actionsEl,
    isDefault ? DEFAULT_MODEL_ICON_ID : NON_DEFAULT_MODEL_ICON_ID,
    isDefault ? "当前默认模型" : "设为默认",
    () => {
      if (isDefault) {
        return;
      }
      void (async () => {
        plugin.settings.defaultModelConfigId = config.id;
        await plugin.savePluginSettings();
        rerender();
      })();
    },
    isDefault ? "is-default" : ""
  );
  createIconActionButton(actionsEl, "pencil", "编辑", () => {
    new ModelConfigSetupModal(plugin.app, {
      title: "编辑模型",
      initialConfig: config,
      initialApiKey: secrets.getModelApiKey(config.id),
      onSave: async ({ config: nextConfig, apiKey }) => {
        plugin.settings.modelConfigs = plugin.settings.modelConfigs.map((item) => item.id === nextConfig.id ? nextConfig : item);
        secrets.setModelApiKey(nextConfig.id, apiKey);
        await plugin.savePluginSettings();
        rerender();
      }
    }).open();
  });
  createIconActionButton(actionsEl, "trash-2", "删除", () => {
    void (async () => {
      if (plugin.settings.modelConfigs.length <= 1) {
        new Notice("至少保留一个模型。", 2800);
        return;
      }
      new DeleteModelConfigConfirmModal(plugin.app, config.model, async () => {
        plugin.settings.modelConfigs = plugin.settings.modelConfigs.filter((item) => item.id !== config.id);
        secrets.clearModelApiKey(config.id);
        if (plugin.settings.defaultModelConfigId === config.id) {
          plugin.settings.defaultModelConfigId = plugin.settings.modelConfigs[0]?.id ?? null;
        }
        await plugin.savePluginSettings();
        rerender();
      }).open();
    })();
  }, "is-danger");
}
