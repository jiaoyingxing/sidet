import {
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  SettingGroup,
  TextComponent,
  type App
} from "obsidian";
import { MODEL_PROVIDER_PRESETS } from "../constants";
import { makeId } from "../shared/paths";
import type { ModelConfigRecord, ModelProviderId } from "../types";
import {
  getModelPresetById,
  getModelPresetsForProvider,
  getProviderLabel,
  providerSupportsNativeReasoning
} from "./model-configs";
import { disableTextAssistance, hardenSensitiveField } from "./setting-input-utils";

interface ModelConfigSetupDraft {
  id: string;
  providerId: ModelProviderId;
  providerLabel: string;
  presetId: string | null;
  model: string;
  baseUrl: string;
  apiKey: string;
  reasoningEnabled: boolean;
}

interface ModelConfigSetupResult {
  config: ModelConfigRecord;
  apiKey: string;
}

function cloneInitialDraft(config?: ModelConfigRecord | null, apiKey?: string | null): ModelConfigSetupDraft {
  const initialProviderId = config?.providerId ?? "siliconflow";
  return {
    id: config?.id ?? makeId("model"),
    providerId: initialProviderId,
    providerLabel: config?.providerLabel ?? getProviderLabel(initialProviderId, config?.providerLabel),
    presetId: config?.presetId ?? null,
    model: config?.model ?? "",
    baseUrl: config?.baseUrl ?? "",
    apiKey: apiKey ?? "",
    reasoningEnabled: config?.reasoningEnabled === true
  };
}

export class ModelConfigSetupModal extends Modal {
  private formSectionEl: HTMLElement | null = null;
  private actionSectionEl: HTMLElement | null = null;
  private readonly draft: ModelConfigSetupDraft;
  private saving = false;

  constructor(
    app: App,
    private readonly options: {
      title: string;
      initialConfig?: ModelConfigRecord | null;
      initialApiKey?: string | null;
      onSave: (result: ModelConfigSetupResult) => Promise<void>;
    }
  ) {
    super(app);
    this.draft = cloneInitialDraft(options.initialConfig, options.initialApiKey);
    if (!this.draft.model || !this.draft.baseUrl) {
      this.applyProviderPreset(this.draft.providerId);
    }
  }

  override onOpen(): void {
    this.modalEl.addClass("sidet-model-config-modal");
    this.titleEl.setText(this.options.title);
    this.contentEl.empty();
    this.contentEl.addClass("sidet-model-config-modal-layout");

    this.formSectionEl = this.contentEl.createDiv({
      cls: "sidet-model-config-modal-section sidet-model-config-modal-section--form"
    });
    this.actionSectionEl = this.contentEl.createDiv({
      cls: "sidet-model-config-modal-section sidet-model-config-modal-section--actions"
    });

    this.renderForm();
    this.renderActions();
  }

  override onClose(): void {
    this.modalEl.removeClass("sidet-model-config-modal");
    this.contentEl.removeClass("sidet-model-config-modal-layout");
    this.contentEl.empty();
    this.formSectionEl = null;
    this.actionSectionEl = null;
  }

  private renderForm(): void {
    if (!this.formSectionEl) {
      return;
    }
    this.formSectionEl.empty();

    const group = new SettingGroup(this.formSectionEl);

    group.addSetting((setting) => {
      setting
        .setName("服务商")
        .setDesc("选择服务商后，会先带出一组默认模型和接口地址。")
        .addDropdown((dropdown) => {
          for (const provider of MODEL_PROVIDER_PRESETS) {
            dropdown.addOption(provider.id, provider.label);
          }
          dropdown.setValue(this.draft.providerId);
          dropdown.onChange((value) => {
            this.applyProviderPreset(value as ModelProviderId);
            this.renderForm();
          });
        });
    });

    if (this.draft.providerId === "custom") {
      group.addSetting((setting) => {
        setting
          .setName("服务商名称")
          .setDesc("显示在模型列表第一行。")
          .addText((text) => {
            this.bindText(text, this.draft.providerLabel, "例如：我的 OpenAI 兼容服务", (value) => {
              this.draft.providerLabel = value;
            });
          });
      });
    }

    group.addSetting((setting) => {
      setting
        .setName("模型")
        .setDesc("显示在模型列表第二行，也会作为聊天区里的模型显示名。")
        .addText((text) => {
          this.bindText(text, this.draft.model, "输入模型名", (value) => {
            this.draft.model = value;
            this.draft.presetId = null;
          });
        });
    });

    group.addSetting((setting) => {
      setting
        .setName("接口地址")
        .setDesc("当前请求链会按 OpenAI 兼容 `chat/completions` 发送。")
        .addText((text) => {
          this.bindText(text, this.draft.baseUrl, "输入接口地址", (value) => {
            this.draft.baseUrl = value.replace(/\/+$/g, "");
            this.draft.presetId = null;
          });
        });
    });

    group.addSetting((setting) => {
      setting
        .setName("API Key")
        .setDesc("每个模型单独绑定，保存在 Obsidian SecretStorage 中。")
        .addText((text) => {
          this.bindText(text, this.draft.apiKey, "输入 API Key", (value) => {
            this.draft.apiKey = value;
          }, {
            secret: true
          });
        });
    });

    const supportsNativeReasoning = providerSupportsNativeReasoning(this.draft.providerId);
    group.addSetting((setting) => {
      setting
        .setName("启用深度思考")
        .setDesc(supportsNativeReasoning
          ? "开启后会发送深度思考请求，当前默认使用最高强度。"
          : "开启后会发送深度思考请求，未确认支持的服务商会按兼容方式尝试，当前默认使用最高强度。")
        .addToggle((toggle) => {
          toggle.setValue(this.draft.reasoningEnabled);
          toggle.onChange((value) => {
            this.draft.reasoningEnabled = value;
          });
        });
    });
  }

  private renderActions(): void {
    if (!this.actionSectionEl) {
      return;
    }
    this.actionSectionEl.empty();

    const actionSetting = new Setting(this.actionSectionEl)
      .setClass("sidet-model-config-actions-setting");
    actionSetting.infoEl.remove();

    new ButtonComponent(actionSetting.controlEl)
      .setButtonText("取消")
      .onClick(() => {
        if (!this.saving) {
          this.close();
        }
      });

    new ButtonComponent(actionSetting.controlEl)
      .setButtonText(this.options.initialConfig ? "保存" : "新增")
      .setCta()
      .onClick(() => {
        void this.submit();
      });
  }

  private applyProviderPreset(providerId: ModelProviderId): void {
    const provider = MODEL_PROVIDER_PRESETS.find((item) => item.id === providerId) ?? MODEL_PROVIDER_PRESETS[0];
    this.draft.providerId = provider.id;
    this.draft.providerLabel = getProviderLabel(provider.id, provider.label);
    this.draft.baseUrl = provider.baseUrl;

    const presets = getModelPresetsForProvider(provider.id);
    if (presets.length > 0) {
      this.applyModelPreset(presets[0].id);
      return;
    }

    this.draft.presetId = null;
    this.draft.model = provider.defaultModel;
  }

  private applyModelPreset(presetId: string): void {
    const preset = getModelPresetById(presetId);
    if (!preset) {
      return;
    }
    this.draft.providerId = preset.providerId;
    this.draft.providerLabel = getProviderLabel(preset.providerId);
    this.draft.presetId = preset.id;
    this.draft.model = preset.model;
    this.draft.baseUrl = preset.baseUrl;
  }

  private bindText(
    text: TextComponent,
    value: string,
    placeholder: string,
    onChange: (value: string) => void,
    options: {
      secret?: boolean;
    } = {}
  ): void {
    text
      .setPlaceholder(placeholder)
      .setValue(value);
    disableTextAssistance(text.inputEl);
    if (options.secret) {
      hardenSensitiveField(text.inputEl);
    }
    text.onChange((nextValue) => {
      onChange(nextValue.trim());
    });
  }

  private async submit(): Promise<void> {
    if (this.saving) {
      return;
    }

    const model = this.draft.model.trim();
    const baseUrl = this.draft.baseUrl.trim().replace(/\/+$/g, "");
    const apiKey = this.draft.apiKey.trim();
    const providerLabel = getProviderLabel(this.draft.providerId, this.draft.providerLabel);
    if (!model) {
      new Notice("请先填写模型名。", 3200);
      return;
    }
    if (!baseUrl) {
      new Notice("请先填写接口地址。", 3200);
      return;
    }
    if (!apiKey) {
      new Notice("请先填写 API Key。", 3200);
      return;
    }

    this.saving = true;
    try {
      const preset = getModelPresetById(this.draft.presetId);
      const supportsNativeReasoning = providerSupportsNativeReasoning(this.draft.providerId);
      const reasoningCompatibilityMode = this.draft.providerId === "mimo"
        ? "mimo"
        : (!supportsNativeReasoning && this.draft.reasoningEnabled ? "mimo" : "none");
      await this.options.onSave({
        config: {
          id: this.draft.id,
          name: model,
          providerId: this.draft.providerId,
          providerLabel,
          presetId: this.draft.presetId,
          model,
          baseUrl,
          reasoningEnabled: reasoningCompatibilityMode === "mimo" && this.draft.reasoningEnabled,
          reasoningCompatibilityMode,
          supportsImageInput: preset?.supportsImageInput === true
        },
        apiKey
      });
      this.close();
    } finally {
      this.saving = false;
    }
  }
}
