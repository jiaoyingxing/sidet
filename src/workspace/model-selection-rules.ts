import type {
  ChatLeafState,
  DialogPluginSettings,
  ResolvedModelConfig
} from "../types";

type ModelConfigMap = Map<string, ResolvedModelConfig>;

export function resolveDefaultModelConfigId(
  settings: Pick<DialogPluginSettings, "defaultModelConfigId" | "modelConfigs">,
  modelConfigs: ModelConfigMap
): string | null {
  const configuredId = settings.defaultModelConfigId;
  if (typeof configuredId === "string" && modelConfigs.has(configuredId)) {
    return configuredId;
  }
  return settings.modelConfigs[0]?.id ?? null;
}

export function resolveLeafModelConfigId(
  stateModelConfigId: string | null,
  conversationModelConfigId: string | null,
  modelConfigs: ModelConfigMap,
  defaultModelConfigId: string | null
): string | null {
  if (stateModelConfigId && modelConfigs.has(stateModelConfigId)) {
    return stateModelConfigId;
  }
  if (conversationModelConfigId && modelConfigs.has(conversationModelConfigId)) {
    return conversationModelConfigId;
  }
  return defaultModelConfigId;
}

export function resolveConversationModelDisplayName(
  conversationModelConfigId: string | null,
  defaultModelConfigId: string | null,
  modelConfigs: ModelConfigMap
): string {
  const preferredId = conversationModelConfigId ?? defaultModelConfigId;
  const resolved = preferredId ? modelConfigs.get(preferredId) : null;
  return resolved?.name ?? "未命名模型";
}

export function resolveReconciledConversationModelConfigId(
  conversationModelConfigId: string | null,
  modelConfigs: ModelConfigMap,
  defaultModelConfigId: string | null
): string | null {
  if (conversationModelConfigId && modelConfigs.has(conversationModelConfigId)) {
    return conversationModelConfigId;
  }
  return defaultModelConfigId;
}

export function resolveReconciledLeafModelConfigId(
  state: Pick<ChatLeafState, "conversationId" | "modelConfigId">,
  conversationModelConfigId: string | null,
  modelConfigs: ModelConfigMap,
  defaultModelConfigId: string | null
): string | null {
  if (state.conversationId) {
    return conversationModelConfigId && modelConfigs.has(conversationModelConfigId)
      ? conversationModelConfigId
      : defaultModelConfigId;
  }
  return state.modelConfigId && modelConfigs.has(state.modelConfigId)
    ? state.modelConfigId
    : defaultModelConfigId;
}
