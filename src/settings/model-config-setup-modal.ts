import {
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  type App,
  type TextComponent
} from "obsidian";
import { MODEL_PROVIDER_PRESETS } from "../constants";
import { makeId } from "../shared/paths";
import type { ModelConfigRecord, ModelProviderId } from "../types";
import { ModalCloseGuard } from "../shared/modal/modal-close-guard";
import { confirmSidetModalDiscard } from "../shared/modal/modal-discard-guard";
import { bindMobileModalKeyboardDismissal } from "../shared/modal/mobile-modal-keyboard";
import {
  createSidetModalFooter,
  createSidetModalShell,
  keepModalFocusOnBody
} from "../shared/modal/sidet-modal-shell";
import {
  getProviderLabel,
  providerSupportsNativeReasoning,
  resolveProviderFormDefaults
} from "./model-configs";
import { disableTextAssistance, hardenSensitiveField } from "./setting-input-utils";
import {
  ModelConnectivityError,
  testModelConnectivity
} from "../provider/model-connectivity";

interface ModelConfigSetupDraft {
  id: string;
  providerId: ModelProviderId;
  providerLabel: string;
  presetId: string | null;
  model: string;
  baseUrl: string;
  apiKey: string;
  reasoningEnabled: boolean;
  supportsImageInput: boolean;
}

interface ModelConfigSetupResult {
  config: ModelConfigRecord;
  apiKey: string;
}

type FieldKey = "model" | "baseUrl" | "apiKey";

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
    reasoningEnabled: config?.reasoningEnabled === true,
    supportsImageInput: config?.supportsImageInput === true
  };
}

function formatSaveError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "请稍后重试。";
}

/**
 * 服务商条目编辑弹窗（新增 / 编辑共用）。
 *
 * 形态按 Resojot《弹框标准与核心约束》（2026-11-27 移植）：
 * - 宿主默认宽度、圆角、标题带与关闭按钮，不写自定义宽度；
 * - 长表单保留布局高度上限 + 表单区内滚动 + 固定底栏，滚动区四边留 3px
 *   焦点环内衬；
 * - 底栏用共享 `.modal-button-container` + `ButtonComponent`，取消挂
 *   `mod-cancel`，手机端两键并排归 CSS；
 * - 校验错误落在字段下方 / 底栏上方，不弹 Notice；保存按钮走宿主加载态；
 * - 探测通过并落库成功后补一条「验证通过，已保存。」，随后自动关闭；
 * - 未保存关闭走 `ModalCloseGuard`：探测中关闭＝放弃本次保存，落库中关闭直接忽略；
 * - 手机端点空白收键盘，长表单在有键盘时按可见区避让。
 */
export class ModelConfigSetupModal extends Modal {
  private formSectionEl: HTMLElement | null = null;
  private actionSectionEl: HTMLElement | null = null;
  private modalErrorEl: HTMLElement | null = null;
  private fieldErrorEls = new Map<FieldKey, HTMLElement>();
  private saveButton: ButtonComponent | null = null;
  private keyboardInsetDispose: (() => void) | null = null;
  private unbindMobileKeyboardDismissal: (() => void) | null = null;
  private readonly draft: ModelConfigSetupDraft;
  private initialDraftSignature = "";
  private testing = false;
  private saving = false;
  private activeProbeGuard: { aborted: boolean } | null = null;
  private readonly closeGuard = new ModalCloseGuard({
    isDirty: () => this.draftSignature() !== this.initialDraftSignature,
    // 探测在途：关闭＝放弃本次保存，直接放行、不再问「未保存」。
    isBusy: () => this.testing,
    confirmDiscard: () => confirmSidetModalDiscard(this.app),
    close: () => this.closeNow()
  });

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
    // 新增时只带服务商名称与接口地址，模型 ID 留空；编辑保留已保存的值。
    if (!options.initialConfig) {
      this.applyProviderDefaults(this.draft.providerId);
    }
  }

  override onOpen(): void {
    this.render();
    this.unbindMobileKeyboardDismissal = bindMobileModalKeyboardDismissal(this);
    keepModalFocusOnBody(this);
    // 基准取在渲染之后：字段渲染可能把值归一化，取早了会「没改也弹提示」。
    this.initialDraftSignature = this.draftSignature();
  }

  override close(): void {
    // 探测在途允许关闭（＝放弃本次保存，见 onClose 的 guard）；
    // 落库瞬间没有可中止点，保存中直接忽略关闭，避免「弹框关了却仍落库」。
    if (this.saving) {
      return;
    }
    void this.closeGuard.requestClose();
  }

  private closeNow(): void {
    super.close();
  }

  override onClose(): void {
    if (this.activeProbeGuard) {
      this.activeProbeGuard.aborted = true;
    }
    this.unbindMobileKeyboardDismissal?.();
    this.unbindMobileKeyboardDismissal = null;
    this.keyboardInsetDispose?.();
    this.keyboardInsetDispose = null;
    this.modalEl.removeClass("sidet-model-config-modal");
    this.contentEl.removeClass("sidet-model-config-modal-layout");
    this.contentEl.empty();
    this.formSectionEl = null;
    this.actionSectionEl = null;
    this.modalErrorEl = null;
    this.saveButton = null;
    this.fieldErrorEls.clear();
  }

  /** 用户可改内容签名：草稿；不含校验状态。 */
  private draftSignature(): string {
    return JSON.stringify(this.draft);
  }

  private render(): void {
    // 同实例重渲染（切换服务商会再次 render）前先卸掉旧键盘锚：
    // 只覆盖字段会让旧 document 级监听与 rAF 泄漏，onClose 也只能卸最新一份。
    this.keyboardInsetDispose?.();
    this.keyboardInsetDispose = null;

    const { formSectionEl, actionSectionEl, keyboardInsetDispose } = createSidetModalShell(this, {
      rootClassName: "sidet-model-config-modal",
      title: this.options.title,
      layoutClassName: "sidet-model-config-modal-layout",
      sectionClassName: "sidet-model-config-modal-section",
      keyboardInset: true
    });
    this.formSectionEl = formSectionEl;
    this.actionSectionEl = actionSectionEl;
    this.keyboardInsetDispose = keyboardInsetDispose;
    this.fieldErrorEls.clear();

    this.renderForm();
    this.renderActions();
  }

  private renderForm(): void {
    const formSectionEl = this.formSectionEl;
    if (!formSectionEl) {
      return;
    }
    formSectionEl.empty();
    this.fieldErrorEls.clear();

    const formDefaults = resolveProviderFormDefaults(this.draft.providerId);
    const isCustomProvider = this.draft.providerId === "custom";

    const providerSetting = new Setting(formSectionEl).setName("服务商");
    if (!isCustomProvider) {
      providerSetting.setDesc("列表里没有的，选「自定义 OpenAI 兼容」。");
    }
    providerSetting.addDropdown((dropdown) => {
      for (const provider of MODEL_PROVIDER_PRESETS) {
        dropdown.addOption(provider.id, provider.label);
      }
      dropdown.setValue(this.draft.providerId);
      dropdown.onChange((value) => {
        this.changeProvider(value as ModelProviderId);
      });
    });

    if (isCustomProvider) {
      new Setting(formSectionEl)
        .setName("服务商名称")
        .addText((text) => {
          this.bindText(text, this.draft.providerLabel, "例如：公司网关", (value) => {
            this.draft.providerLabel = value;
          });
        });
    }

    new Setting(formSectionEl)
      .setName("模型 ID")
      .setDesc("在服务商控制台或文档里复制模型 ID。")
      .addText((text) => {
        this.bindText(text, this.draft.model, formDefaults.modelPlaceholder, (value) => {
          this.draft.model = value;
          this.draft.presetId = null;
          this.clearFieldError("model");
        });
      });
    this.appendFieldError("model");

    new Setting(formSectionEl)
      .setName("接口地址")
      .setDesc("服务商文档里的 API 基础地址，通常以 /v1 结尾。")
      .addText((text) => {
        const placeholder = isCustomProvider
          ? "https://api.example.com/v1"
          : "输入接口地址";
        this.bindText(text, this.draft.baseUrl, placeholder, (value) => {
          this.draft.baseUrl = value.replace(/\/+$/g, "");
          this.draft.presetId = null;
          this.clearFieldError("baseUrl");
        });
      });
    this.appendFieldError("baseUrl");

    new Setting(formSectionEl)
      .setName("API Key")
      .setDesc("在服务商控制台创建；只保存在本机，不会写进对话或配置文件。")
      .addText((text) => {
        this.bindText(text, this.draft.apiKey, "输入 API Key", (value) => {
          this.draft.apiKey = value;
          this.clearFieldError("apiKey");
        }, {
          secret: true
        });
      });
    this.appendFieldError("apiKey");

    new Setting(formSectionEl)
      .setName("支持图片输入")
      .setDesc("开启后可以在对话里发送图片，模型本身也需要支持识别。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.supportsImageInput)
          .onChange((value) => {
            this.draft.supportsImageInput = value;
          });
      });

    const supportsNativeReasoning = providerSupportsNativeReasoning(this.draft.providerId);
    new Setting(formSectionEl)
      .setName("启用深度思考")
      .setDesc(supportsNativeReasoning
        ? "开启后会让模型先思考再回答，当前使用最高强度。"
        : "开启后会让模型先思考再回答，当前使用最高强度；未确认支持的服务商会按兼容方式尝试。")
      .addToggle((toggle) => {
        toggle.setValue(this.draft.reasoningEnabled);
        toggle.onChange((value) => {
          this.draft.reasoningEnabled = value;
        });
      });
  }

  private renderActions(): void {
    const actionSectionEl = this.actionSectionEl;
    if (!actionSectionEl) {
      return;
    }
    actionSectionEl.empty();

    // 弹框级错误只放底栏上方一条（Resojot 错误通道规则），不叠加 Notice。
    this.modalErrorEl = actionSectionEl.createDiv({
      cls: "sidet-modal-error",
      attr: {
        role: "alert",
        "aria-live": "polite"
      }
    });

    const footerEl = createSidetModalFooter(actionSectionEl);
    new ButtonComponent(footerEl)
      .setButtonText("取消")
      .setClass("mod-cancel")
      .onClick(() => {
        this.close();
      });

    this.saveButton = new ButtonComponent(footerEl)
      .setButtonText(this.options.initialConfig ? "保存" : "新增")
      .setCta()
      // onClick 必须返回在途 Promise：宿主 ButtonComponent 的加载态等到该
      // Promise 落定才移除；void 化会让它同一 tick 被摘除，只剩裸置灰。
      .onClick(() => this.submit());
  }

  private changeProvider(providerId: ModelProviderId): void {
    if (providerId === this.draft.providerId) {
      return;
    }
    this.applyProviderDefaults(providerId);
    // 切换服务商＝整体换草稿：模型 ID、API Key、图片开关、presetId 都回到
    // 新服务商默认值，避免把上一家的模型或密钥顺手存到新服务商。
    this.draft.apiKey = "";
    this.draft.supportsImageInput = false;
    // 整壳重渲染：旧表单区上的键盘避让监听必须随旧外壳一起卸掉再重绑。
    this.render();
    // 切换本身不当作「用户改过」：基准跟着重取，否则只切换没输入也会弹放弃提示。
    this.initialDraftSignature = this.draftSignature();
  }

  /**
   * 套用服务商级默认值：名称与接口地址来自预设，模型 ID 一律留空。
   * `presetId` 同时清掉——它属于旧模型，不能再跟着新服务商存下去。
   */
  private applyProviderDefaults(providerId: ModelProviderId): void {
    const defaults = resolveProviderFormDefaults(providerId);
    this.draft.providerId = providerId;
    this.draft.providerLabel = defaults.providerLabel;
    this.draft.baseUrl = defaults.baseUrl;
    this.draft.model = defaults.model;
    this.draft.presetId = null;
  }

  private appendFieldError(key: FieldKey): void {
    const formSectionEl = this.formSectionEl;
    if (!formSectionEl) {
      return;
    }
    const errorEl = formSectionEl.createDiv({
      cls: "sidet-field-error",
      attr: {
        role: "alert",
        "aria-live": "polite"
      }
    });
    this.fieldErrorEls.set(key, errorEl);
  }

  private showFieldError(key: FieldKey, message: string): void {
    const errorEl = this.fieldErrorEls.get(key);
    if (!errorEl) {
      return;
    }
    errorEl.setText(message);
    errorEl.addClass("is-visible");
  }

  private clearFieldError(key: FieldKey): void {
    const errorEl = this.fieldErrorEls.get(key);
    if (!errorEl) {
      return;
    }
    errorEl.setText("");
    errorEl.removeClass("is-visible");
  }

  private clearAllFieldErrors(): void {
    for (const key of this.fieldErrorEls.keys()) {
      this.clearFieldError(key);
    }
  }

  private showModalError(message: string): void {
    if (!this.modalErrorEl) {
      return;
    }
    this.modalErrorEl.setText(message);
    this.modalErrorEl.addClass("is-visible");
  }

  private clearModalError(): void {
    if (!this.modalErrorEl) {
      return;
    }
    this.modalErrorEl.setText("");
    this.modalErrorEl.removeClass("is-visible");
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

  private async submit(): Promise<boolean> {
    if (this.testing || this.saving) {
      return false;
    }
    this.clearModalError();
    this.clearAllFieldErrors();

    const model = this.draft.model.trim();
    const baseUrl = this.draft.baseUrl.trim().replace(/\/+$/g, "");
    const apiKey = this.draft.apiKey.trim();
    let firstInvalid: FieldKey | null = null;
    if (!model) {
      this.showFieldError("model", "请填写模型 ID。");
      firstInvalid ??= "model";
    }
    if (!baseUrl) {
      this.showFieldError("baseUrl", "请填写接口地址。");
      firstInvalid ??= "baseUrl";
    }
    if (!apiKey) {
      this.showFieldError("apiKey", "请填写 API Key。");
      firstInvalid ??= "apiKey";
    }
    if (firstInvalid) {
      // 错误在滚动区内可能位于视口外：把第一条错误带回可见范围。
      this.fieldErrorEls.get(firstInvalid)?.scrollIntoView({ block: "nearest" });
      return false;
    }

    // 先探测连通性：验证地址 / 密钥 / 模型 ID，通过后才落库。
    // 探测期间关闭弹窗＝放弃本次保存（onClose 置 aborted），返回后不再写任何状态。
    const probeGuard: { aborted: boolean } = { aborted: false };
    this.activeProbeGuard = probeGuard;
    this.testing = true;
    this.saveButton?.setDisabled(true);
    let progressTimer: number | null = null;
    // 用对象持有：回调里的赋值不受外层 let 的窄化影响。
    const progress: { notice: Notice | null } = { notice: null };
    let probeFailure = "";
    try {
      progressTimer = window.setTimeout(() => {
        if (!probeGuard.aborted) {
          progress.notice = new Notice("正在测试模型连接…", 6000);
        }
      }, 600);
      try {
        await testModelConnectivity({ baseUrl, model, apiKey });
      } catch (error) {
        probeFailure = error instanceof ModelConnectivityError
          ? error.message
          : "连接测试失败，请稍后重试。";
      }
    } finally {
      if (progressTimer !== null) {
        window.clearTimeout(progressTimer);
      }
      // 探测已结束：进度 Notice 不留在结果之后（成功 / 失败都一样）。
      progress.notice?.hide();
      this.testing = false;
      this.activeProbeGuard = null;
    }

    if (probeGuard.aborted) {
      return false;
    }
    if (probeFailure) {
      this.showModalError(`连接失败：${probeFailure}`);
      this.saveButton?.setDisabled(false);
      return false;
    }

    this.saving = true;
    this.saveButton?.setDisabled(true);
    try {
      const providerLabel = getProviderLabel(this.draft.providerId, this.draft.providerLabel);
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
          supportsImageInput: this.draft.supportsImageInput === true
        },
        apiKey
      });
    } catch (error) {
      // 保存失败留在弹窗里：弹框级错误一条，不另弹 Notice。
      this.showModalError(`保存失败：${formatSaveError(error)}`);
      return false;
    } finally {
      this.saving = false;
      this.saveButton?.setDisabled(false);
    }

    // 自关必须在解除 saving 之后：close() 在 saving 期间会被忽略（见 close()），
    // 在锁内调只会被吞掉，落库成功却把弹窗留在原地。
    new Notice("验证通过，已保存。", 2600);
    this.closeGuard.allowNextClose();
    this.close();
    return true;
  }
}
