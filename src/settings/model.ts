import {
  DEFAULT_HOME_ACTION_COMMAND_ID,
  DEFAULT_HOME_PINNED_COMMANDS,
  DEFAULT_RUNTIME_STATE,
  DEFAULT_SETTINGS,
  HOME_PINNED_COMMAND_LIMIT,
  URL_LAUNCHER_LIMIT
} from "../constants";
import type {
  DialogPluginData,
  DialogPluginSettings,
  DialogRuntimeState,
  HomePinnedCommandSetting,
  UrlLauncherSetting,
  WebSearchMode
} from "../types";
import {
  isHomeLauncherCommandId,
  migrateHomeLauncherCommandId
} from "./home-command-rules";
import { normalizeModelConfigs } from "./model-configs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePinnedCommandItem(value: unknown): HomePinnedCommandSetting | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawCommandId = typeof value.commandId === "string" ? value.commandId.trim() : "";
  const commandId = migrateHomeLauncherCommandId(rawCommandId);
  if (!commandId) {
    return null;
  }

  return {
    commandId,
    labelOverride: typeof value.labelOverride === "string" ? value.labelOverride.trim() : "",
    iconOverride: typeof value.iconOverride === "string" ? value.iconOverride.trim() : ""
  };
}

export function normalizeHomePinnedCommands(data: unknown): HomePinnedCommandSetting[] {
  const result: HomePinnedCommandSetting[] = [];
  const seen = new Set<string>();
  const source = Array.isArray(data) ? data : DEFAULT_HOME_PINNED_COMMANDS;

  for (const item of source) {
    const normalized = normalizePinnedCommandItem(item);
    if (
      !normalized
      || seen.has(normalized.commandId)
      || !isHomeLauncherCommandId(normalized.commandId)
    ) {
      continue;
    }
    seen.add(normalized.commandId);
    result.push(normalized);
    if (result.length >= HOME_PINNED_COMMAND_LIMIT) {
      break;
    }
  }

  return result;
}

function normalizeUrlLauncherItem(value: unknown): UrlLauncherSetting | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawSlot = typeof value.slot === "number"
    ? value.slot
    : typeof value.slot === "string"
      ? Number.parseInt(value.slot, 10)
      : Number.NaN;
  const slot = Number.isInteger(rawSlot) ? rawSlot : Number.NaN;
  const rawCommandId = typeof value.commandId === "string" ? value.commandId.trim() : "";
  const commandId = migrateHomeLauncherCommandId(rawCommandId);
  if (
    !Number.isInteger(slot)
    || slot < 1
    || slot > URL_LAUNCHER_LIMIT
    || !commandId
  ) {
    return null;
  }

  return {
    slot,
    commandId
  };
}

export function normalizeUrlLaunchers(data: unknown): UrlLauncherSetting[] {
  const result: UrlLauncherSetting[] = [];
  const seenSlots = new Set<number>();
  const seenCommandIds = new Set<string>();
  const source = Array.isArray(data) ? data : DEFAULT_SETTINGS.urlLaunchers;

  for (const item of source) {
    const normalized = normalizeUrlLauncherItem(item);
    if (
      !normalized
      || seenSlots.has(normalized.slot)
      || seenCommandIds.has(normalized.commandId)
      || !isHomeLauncherCommandId(normalized.commandId)
    ) {
      continue;
    }
    seenSlots.add(normalized.slot);
    seenCommandIds.add(normalized.commandId);
    result.push(normalized);
    if (result.length >= URL_LAUNCHER_LIMIT) {
      break;
    }
  }

  return result.sort((left, right) => left.slot - right.slot);
}

function normalizeWebSearchMode(value: unknown): WebSearchMode {
  return value === "on" || value === "off" || value === "auto"
    ? value
    : DEFAULT_SETTINGS.webSearchMode;
}

export function normalizeSettings(data: unknown): DialogPluginSettings {
  const source = isRecord(data) ? data : {};
  const legacyHomeActionCommandId =
    typeof source.homeActionCommandId === "string" && source.homeActionCommandId.trim().length > 0
      ? source.homeActionCommandId.trim()
      : DEFAULT_HOME_ACTION_COMMAND_ID;
  const homePinnedCommandsSource = Array.isArray(source.homePinnedCommands)
    ? source.homePinnedCommands
    : [
        {
          commandId: legacyHomeActionCommandId,
          labelOverride: "",
          iconOverride: ""
        }
      ];

  const { modelConfigs, defaultModelConfigId } = normalizeModelConfigs(source.modelConfigs, source);

  return {
    modelConfigs,
    defaultModelConfigId,
    webSearchMode: normalizeWebSearchMode(source.webSearchMode),
    exportFolder: typeof source.exportFolder === "string" && source.exportFolder.trim().length > 0
      ? source.exportFolder.trim()
      : DEFAULT_SETTINGS.exportFolder,
    homePinnedCommands: normalizeHomePinnedCommands(homePinnedCommandsSource),
    urlLaunchers: normalizeUrlLaunchers(source.urlLaunchers)
  };
}

export function normalizeRuntimeState(data: unknown): DialogRuntimeState {
  void data;
  return DEFAULT_RUNTIME_STATE;
}

export function normalizePluginData(data: unknown): DialogPluginData {
  const source = isRecord(data) ? data : {};
  const settingsSource = isRecord(source.settings) ? source.settings : source;
  const runtimeSource = isRecord(source.runtimeState) ? source.runtimeState : {};

  return {
    settings: normalizeSettings(settingsSource),
    runtimeState: normalizeRuntimeState(runtimeSource)
  };
}
