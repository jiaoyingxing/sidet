import {
  CUSTOM_MODEL_PRESET_ID,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_MODEL_CONFIG_ID,
  DEFAULT_MODEL_PROVIDER_ID,
  DEFAULT_MODEL_PRESET_ID,
  MODEL_PRESETS,
  MODEL_PROVIDER_PRESETS
} from "../constants";
import type {
  ModelConfigRecord,
  ModelPreset,
  ModelProviderId,
  ModelProviderPreset,
  ReasoningCompatibilityMode,
  ResolvedModelConfig
} from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeModelProviderId(value: unknown): ModelProviderId {
  return typeof value === "string" && MODEL_PROVIDER_PRESETS.some((provider) => provider.id === value)
    ? value as ModelProviderId
    : DEFAULT_MODEL_PROVIDER_ID;
}

function normalizeReasoningCompatibilityMode(value: unknown): ReasoningCompatibilityMode {
  return value === "mimo" ? "mimo" : "none";
}

function resolveProviderPreset(providerId: ModelProviderId): ModelProviderPreset | null {
  return MODEL_PROVIDER_PRESETS.find((provider) => provider.id === providerId) ?? null;
}

function resolveModelPreset(presetId: string | null | undefined): ModelPreset | null {
  if (!presetId) {
    return null;
  }
  return MODEL_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

function resolveModelPresetId(value: unknown, model: string, baseUrl: string, providerId: ModelProviderId): string | null {
  if (
    typeof value === "string"
    && value.trim().length > 0
    && value !== CUSTOM_MODEL_PRESET_ID
    && MODEL_PRESETS.some((preset) => preset.id === value)
  ) {
    return value;
  }

  const matchedPreset = MODEL_PRESETS.find(
    (preset) => preset.providerId === providerId
      && preset.model === model
      && preset.baseUrl.replace(/\/+$/g, "") === baseUrl.replace(/\/+$/g, "")
  );
  return matchedPreset?.id ?? null;
}

function normalizeModelConfigRecord(
  value: unknown,
  fallbackIndex: number
): ModelConfigRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const providerId = normalizeModelProviderId(value.providerId);
  const providerPreset = resolveProviderPreset(providerId);
  const model = typeof value.model === "string" && value.model.trim().length > 0
    ? value.model.trim()
    : providerPreset?.defaultModel ?? DEFAULT_MODEL;
  const baseUrl = typeof value.baseUrl === "string" && value.baseUrl.trim().length > 0
    ? value.baseUrl.trim().replace(/\/+$/g, "")
    : providerPreset?.baseUrl ?? DEFAULT_BASE_URL;
  const presetId = resolveModelPresetId(value.presetId, model, baseUrl, providerId);
  const preset = resolveModelPreset(presetId);
  const providerLabel = providerId === "custom"
    ? (typeof value.providerLabel === "string" && value.providerLabel.trim().length > 0
      ? value.providerLabel.trim()
      : "自定义服务商")
    : providerPreset?.label;
  const reasoningCompatibilityMode = providerId === "mimo"
    ? "mimo"
    : normalizeReasoningCompatibilityMode(value.reasoningCompatibilityMode);
  const reasoningEnabled = reasoningCompatibilityMode === "mimo" && value.reasoningEnabled === true;
  const name = model;
  const id = typeof value.id === "string" && value.id.trim().length > 0
    ? value.id.trim()
    : `${DEFAULT_MODEL_CONFIG_ID}-${fallbackIndex + 1}`;

  return {
    id,
    name,
    providerId,
    providerLabel,
    presetId,
    model,
    baseUrl,
    reasoningEnabled,
    reasoningCompatibilityMode,
    supportsImageInput: preset?.supportsImageInput === true
  };
}

export function createLegacyModelConfig(source: Record<string, unknown>): ModelConfigRecord {
  const legacyModel = typeof source.model === "string" && source.model.trim().length > 0
    ? source.model.trim()
    : DEFAULT_MODEL;
  const legacyBaseUrl = typeof source.baseUrl === "string" && source.baseUrl.trim().length > 0
    ? source.baseUrl.trim().replace(/\/+$/g, "")
    : DEFAULT_BASE_URL;
  const legacyProviderId = normalizeModelProviderId(source.modelProviderId);
  const legacyPresetId = resolveModelPresetId(source.modelPresetId, legacyModel, legacyBaseUrl, legacyProviderId)
    ?? DEFAULT_MODEL_PRESET_ID;
  const legacyPreset = resolveModelPreset(legacyPresetId);
  const reasoningCompatibilityMode = legacyProviderId === "mimo" ? "mimo" : "none";

  return {
    id: DEFAULT_MODEL_CONFIG_ID,
    name: legacyModel,
    providerId: legacyProviderId,
    providerLabel: resolveProviderPreset(legacyProviderId)?.label,
    presetId: legacyPresetId,
    model: legacyModel,
    baseUrl: legacyBaseUrl,
    reasoningEnabled: reasoningCompatibilityMode === "mimo" && source.reasoningMode !== "off",
    reasoningCompatibilityMode,
    supportsImageInput: legacyPreset?.supportsImageInput === true
  };
}

export function normalizeModelConfigs(data: unknown, legacySource?: Record<string, unknown>): {
  modelConfigs: ModelConfigRecord[];
  defaultModelConfigId: string;
} {
  const source = Array.isArray(data) ? data : [];
  const normalizedConfigs = source
    .map((item, index) => normalizeModelConfigRecord(item, index))
    .filter((item): item is ModelConfigRecord => Boolean(item));

  const modelConfigs = normalizedConfigs.length > 0
    ? normalizedConfigs
    : [
        legacySource
          ? createLegacyModelConfig(legacySource)
          : { ...DEFAULT_MODEL_CONFIG }
      ];

  const defaultModelConfigId = typeof legacySource?.defaultModelConfigId === "string" && legacySource.defaultModelConfigId.trim().length > 0
    ? legacySource.defaultModelConfigId.trim()
    : DEFAULT_MODEL_CONFIG_ID;
  const resolvedDefaultModelConfigId = modelConfigs.some((config) => config.id === defaultModelConfigId)
    ? defaultModelConfigId
    : modelConfigs[0].id;

  return {
    modelConfigs,
    defaultModelConfigId: resolvedDefaultModelConfigId
  };
}

export function getProviderLabel(providerId: ModelProviderId, fallbackLabel?: string | null): string {
  if (providerId === "custom") {
    return fallbackLabel?.trim() || "自定义服务商";
  }
  return resolveProviderPreset(providerId)?.label ?? (fallbackLabel?.trim() || "当前服务商");
}

export function providerSupportsNativeReasoning(providerId: ModelProviderId): boolean {
  return resolveProviderPreset(providerId)?.supportsReasoning === true;
}

export function getModelPresetById(presetId: string | null | undefined): ModelPreset | null {
  return resolveModelPreset(presetId);
}

export function getModelPresetsForProvider(providerId: ModelProviderId): ModelPreset[] {
  return MODEL_PRESETS.filter((preset) => preset.providerId === providerId);
}

export function buildResolvedModelConfigMap(modelConfigs: ModelConfigRecord[]): Map<string, ResolvedModelConfig> {
  return new Map(modelConfigs.map((config) => [
    config.id,
    {
      ...config,
      providerLabel: getProviderLabel(config.providerId, config.providerLabel)
    }
  ]));
}
