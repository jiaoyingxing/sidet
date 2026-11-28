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
import { createSidetModalFooter } from "../shared/modal/sidet-modal-shell";
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
  private resolved = false;

  constructor(
    app: App,
    private readonly modelName: string,
    private readonly onConfirm: () => Promise<void>,
    private readonly onResolve: (confirmed: boolean) => void
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

    const footerEl = createSidetModalFooter(this.contentEl);
    new ButtonComponent(footerEl)
      .setButtonText("取消")
      .setClass("mod-cancel")
      .onClick(() => {
        this.close();
      });

    const deleteButton = new ButtonComponent(footerEl)
      .setWarning()
      .setButtonText("删除")
      .onClick(async () => {
        deleteButton.setDisabled(true);
        try {
          await this.onConfirm();
          this.finish(true);
          this.close();
        } catch (error) {
          // 删除失败时不让确认框悬空：关闭并把 false 交还调用方，由列表行保持原状。
          const message = error instanceof Error ? error.message.trim() : "";
          new Notice(message ? `删除失败：${message}` : "删除失败，请稍后重试。", 3600);
          this.finish(false);
          this.close();
        } finally {
          deleteButton.setDisabled(false);
        }
      });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.finish(false);
  }

  private finish(confirmed: boolean): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.onResolve(confirmed);
  }
}

/**
 * 删除模型项：列表行与编辑弹窗共用。至少保留一个模型；确认后落库并刷新列表。
 * 返回是否真的删除，供弹窗内的删除行决定要不要关闭自身。
 */
function requestDeleteModelConfig(
  plugin: SidetPlugin,
  secrets: SecretStorageService,
  config: ModelConfigRecord,
  refresh: () => void
): Promise<boolean> {
  if (plugin.settings.modelConfigs.length <= 1) {
    new Notice("至少保留一个模型。", 2800);
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    new DeleteModelConfigConfirmModal(plugin.app, config.model, async () => {
      plugin.settings.modelConfigs = plugin.settings.modelConfigs.filter((item) => item.id !== config.id);
      secrets.clearModelApiKey(config.id);
      if (plugin.settings.defaultModelConfigId === config.id) {
        plugin.settings.defaultModelConfigId = plugin.settings.modelConfigs[0]?.id ?? null;
      }
      await plugin.savePluginSettings();
      refresh();
    }, resolve).open();
  });
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
  group.addSetting((setting) => {
    configureAutoWebSearchRow(setting, plugin);
  });
}

/**
 * 自动联网总开关：只控制普通对话的工具表里是否带联网工具。
 * 手动「联网搜索」是叶子级显式模式，关闭这里也不影响它。
 */
export function configureAutoWebSearchRow(setting: Setting, plugin: SidetPlugin): void {
  setting
    .setName("允许模型自动联网")
    .setDesc("需要最新或外部信息时，让模型自己联网搜索。关闭后仍可在对话里手动开启联网搜索。")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.webSearchMode === "auto")
        .onChange(async (value) => {
          plugin.settings.webSearchMode = value ? "auto" : "off";
          await plugin.savePluginSettings();
        });
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
              const previousApiKey = secrets.getModelApiKey(config.id);
              if (!secrets.setModelApiKey(config.id, apiKey)) {
                throw new Error("API Key 未能写入安全存储，请检查设备支持后重试。");
              }
              const previousConfigs = plugin.settings.modelConfigs;
              const previousDefault = plugin.settings.defaultModelConfigId;
              plugin.settings.modelConfigs = previousConfigs.some((item) => item.id === config.id)
                ? previousConfigs.map((item) => item.id === config.id ? config : item)
                : [...previousConfigs, config];
              if (!plugin.settings.defaultModelConfigId) {
                plugin.settings.defaultModelConfigId = config.id;
              }
              try {
                await plugin.savePluginSettings();
              } catch (error) {
                // 落库失败时恢复内存快照，避免“弹窗说失败、设置里其实已经多了
                // 一条”，重试时又追加成两条同 id 记录。
                plugin.settings.modelConfigs = previousConfigs;
                plugin.settings.defaultModelConfigId = previousDefault;
                secrets.setModelApiKey(config.id, previousApiKey ?? "");
                throw error;
              }
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
        const previousApiKey = secrets.getModelApiKey(nextConfig.id);
        if (!secrets.setModelApiKey(nextConfig.id, apiKey)) {
          throw new Error("API Key 未能写入安全存储，请检查设备支持后重试。");
        }
        const previousConfigs = plugin.settings.modelConfigs;
        plugin.settings.modelConfigs = previousConfigs.map((item) => (
          item.id === nextConfig.id ? nextConfig : item
        ));
        try {
          await plugin.savePluginSettings();
        } catch (error) {
          plugin.settings.modelConfigs = previousConfigs;
          secrets.setModelApiKey(nextConfig.id, previousApiKey ?? "");
          throw error;
        }
        rerender();
      }
    }).open();
  });
  createIconActionButton(actionsEl, "trash-2", "删除", () => {
    void requestDeleteModelConfig(plugin, secrets, config, rerender);
  }, "is-danger");
}
