import { App, Notice } from "obsidian";
import { SILICONFLOW_SECRET_ID } from "../constants";
import type { ModelProviderId } from "../types";

function buildProviderSecretId(providerId: ModelProviderId): string {
  return providerId === "siliconflow" ? SILICONFLOW_SECRET_ID : `sidet-${providerId}-api-key`;
}

function buildModelSecretId(modelConfigId: string): string {
  return `sidet-model-${modelConfigId}-api-key`;
}

interface SecretStorageLike {
  getSecret(key: string): string | null | undefined;
  setSecret(key: string, value: string): void;
}

export class SecretStorageService {
  private unavailableNoticeShown = false;

  constructor(private readonly app: App) {}

  getLegacyProviderApiKey(providerId: ModelProviderId = "siliconflow"): string | null {
    return this.readSecret(buildProviderSecretId(providerId));
  }

  setLegacyProviderApiKey(providerId: ModelProviderId, value: string): void {
    this.writeSecret(buildProviderSecretId(providerId), value);
  }

  getModelApiKey(modelConfigId: string): string | null {
    return this.readSecret(buildModelSecretId(modelConfigId));
  }

  /** 返回 false 表示密钥没有写入（设备不支持或写入抛错），调用方不得宣告保存成功。 */
  setModelApiKey(modelConfigId: string, value: string): boolean {
    return this.writeSecret(buildModelSecretId(modelConfigId), value);
  }

  clearModelApiKey(modelConfigId: string): void {
    this.writeSecret(buildModelSecretId(modelConfigId), "", { showUnavailableNotice: false });
  }

  migrateLegacyProviderApiKey(providerId: ModelProviderId, modelConfigId: string): void {
    if (this.getModelApiKey(modelConfigId)) {
      return;
    }

    const legacyValue = this.getLegacyProviderApiKey(providerId);
    if (!legacyValue) {
      return;
    }

    this.writeSecret(buildModelSecretId(modelConfigId), legacyValue, { showUnavailableNotice: false });
  }

  private resolveStorage(): SecretStorageLike | null {
    const candidate = (this.app as App & { secretStorage?: unknown }).secretStorage;
    if (!candidate) {
      return null;
    }

    const storage = candidate as Partial<SecretStorageLike>;
    if (typeof storage.getSecret !== "function" || typeof storage.setSecret !== "function") {
      return null;
    }

    return storage as SecretStorageLike;
  }

  private readSecret(secretId: string): string | null {
    const storage = this.resolveStorage();
    if (!storage) {
      return null;
    }

    try {
      const value = storage.getSecret(secretId);
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    } catch (error) {
      console.warn(`Sidet: failed to read secret "${secretId}"`, error);
      return null;
    }
  }

  private writeSecret(
    secretId: string,
    value: string,
    options: { showUnavailableNotice?: boolean } = {}
  ): boolean {
    const storage = this.resolveStorage();
    if (!storage) {
      if (options.showUnavailableNotice !== false) {
        this.showUnavailableNotice();
      }
      return false;
    }

    try {
      storage.setSecret(secretId, value.trim());
      return true;
    } catch (error) {
      console.warn(`Sidet: failed to write secret "${secretId}"`, error);
      if (options.showUnavailableNotice !== false) {
        this.showUnavailableNotice();
      }
      return false;
    }
  }

  private showUnavailableNotice(): void {
    if (this.unavailableNoticeShown) {
      return;
    }

    this.unavailableNoticeShown = true;
    new Notice("当前设备暂不支持安全存储，API Key 未保存。", 4200);
  }
}
