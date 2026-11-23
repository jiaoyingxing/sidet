import type { App } from "obsidian";
import { PLUGIN_AUTHOR, PLUGIN_ID, PLUGIN_NAME } from "../constants";

export type CommandSourceType = "sidet" | "core" | "community";

export interface CommandSourceInfo {
  type: CommandSourceType;
  id: string | null;
  label: string;
  author?: string;
}

export interface RegistryCommand {
  id?: string;
  name?: string;
  icon?: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

export interface CommandRegistryLike {
  commands?: unknown;
  listCommands?: () => unknown;
  executeCommandById?: (commandId: string) => unknown;
}

export interface RegisteredCommandInfo {
  id: string;
  name: string;
  icon: string;
  source: CommandSourceInfo;
  searchText: string;
}

interface PluginManifestLike {
  id?: string;
  name?: string;
  author?: string;
}

interface PluginInstanceLike {
  manifest?: PluginManifestLike;
}

interface CommunityPluginsLike {
  manifests?: Record<string, PluginManifestLike>;
  plugins?: Record<string, PluginInstanceLike>;
}

interface InternalPluginLike {
  name?: string;
  manifest?: PluginManifestLike;
  instance?: PluginInstanceLike;
}

interface InternalPluginsLike {
  plugins?: Record<string, InternalPluginLike>;
}

const CORE_COMMAND_LABELS: Record<string, string> = {
  app: "Obsidian",
  command: "命令面板",
  editor: "编辑器",
  file: "文件",
  files: "文件",
  graph: "关系图谱",
  help: "帮助",
  window: "窗口",
  workspace: "工作区"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getCommandIdPrefix(commandId: string): string | null {
  const separatorIndex = commandId.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  return commandId.slice(0, separatorIndex);
}

export function getCommandRegistry(app: App): CommandRegistryLike | null {
  const appWithCommands = app as App & {
    commands?: CommandRegistryLike;
  };
  return appWithCommands.commands ?? null;
}

export function getRegistryCommand(
  registry: CommandRegistryLike | null,
  commandId: string
): RegistryCommand | null {
  if (!registry) {
    return null;
  }

  const collection = registry.commands;
  if (collection instanceof Map) {
    const command: unknown = collection.get(commandId);
    if (isRecord(command)) {
      return command;
    }
  }

  if (isRecord(collection)) {
    const command = collection[commandId];
    if (isRecord(command)) {
      return command;
    }
  }

  const listCommand = getListCommand(registry, commandId);
  return listCommand;
}

export function getRegisteredCommands(app: App): RegisteredCommandInfo[] {
  const registry = getCommandRegistry(app);
  const commandMap = getCommandMap(registry);
  return Array.from(commandMap.entries())
    .map(([id, command]) => buildRegisteredCommandInfo(app, id, command))
    .sort((left, right) => {
      const sourceCompare = left.source.label.localeCompare(right.source.label, undefined, {
        sensitivity: "base"
      });
      if (sourceCompare !== 0) {
        return sourceCompare;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
}

export function resolveRegisteredCommand(app: App, commandId: string): RegisteredCommandInfo | null {
  const registry = getCommandRegistry(app);
  const command = getRegistryCommand(registry, commandId);
  if (!command) {
    return null;
  }
  return buildRegisteredCommandInfo(app, commandId, command);
}

function getCommandMap(registry: CommandRegistryLike | null): Map<string, RegistryCommand> {
  const result = new Map<string, RegistryCommand>();
  if (!registry) {
    return result;
  }

  const collection = registry.commands;
  if (collection instanceof Map) {
    for (const [rawId, rawCommand] of collection.entries()) {
      addCommandToMap(result, rawId, rawCommand);
    }
  } else if (isRecord(collection)) {
    for (const [rawId, rawCommand] of Object.entries(collection)) {
      addCommandToMap(result, rawId, rawCommand);
    }
  }

  const listedCommands = getListedCommands(registry);
  for (const command of listedCommands) {
    addCommandToMap(result, command.id, command);
  }

  return result;
}

function getListedCommands(registry: CommandRegistryLike): RegistryCommand[] {
  if (typeof registry.listCommands !== "function") {
    return [];
  }

  try {
    const commands = registry.listCommands();
    if (!Array.isArray(commands)) {
      return [];
    }
    return commands.filter(isRegistryCommand);
  } catch {
    return [];
  }
}

function getListCommand(
  registry: CommandRegistryLike,
  commandId: string
): RegistryCommand | null {
  return getListedCommands(registry).find((command) => command.id === commandId) ?? null;
}

function addCommandToMap(
  result: Map<string, RegistryCommand>,
  rawId: unknown,
  rawCommand: unknown
): void {
  if (!isRegistryCommand(rawCommand)) {
    return;
  }

  const id = typeof rawCommand.id === "string" && rawCommand.id.trim().length > 0
    ? rawCommand.id.trim()
    : typeof rawId === "string"
      ? rawId.trim()
      : "";
  if (!id) {
    return;
  }

  result.set(id, rawCommand);
}

function isRegistryCommand(value: unknown): value is RegistryCommand {
  return isRecord(value);
}

function buildRegisteredCommandInfo(
  app: App,
  id: string,
  command: RegistryCommand
): RegisteredCommandInfo {
  const name = typeof command.name === "string" && command.name.trim().length > 0
    ? command.name.trim()
    : id;
  const icon = typeof command.icon === "string" && command.icon.trim().length > 0
    ? command.icon.trim()
    : "command";
  const source = resolveCommandSource(app, id);
  const searchText = [
    name,
    id,
    source.label,
    source.author ?? "",
    source.id ?? "",
    getSourceSearchLabel(source)
  ].join(" ");

  return {
    id,
    name,
    icon,
    source,
    searchText
  };
}

function getSourceSearchLabel(source: CommandSourceInfo): string {
  if (source.type === "community") {
    return "第三方 插件 community plugin";
  }
  if (source.type === "sidet") {
    return "Sidet 思得 plugin";
  }
  return "官方 核心 Obsidian core";
}

function resolveCommandSource(app: App, commandId: string): CommandSourceInfo {
  const prefix = getCommandIdPrefix(commandId);
  if (!prefix) {
    return {
      type: "core",
      id: null,
      label: "Obsidian"
    };
  }

  if (prefix === PLUGIN_ID) {
    return {
      type: "sidet",
      id: PLUGIN_ID,
      label: PLUGIN_NAME,
      author: PLUGIN_AUTHOR
    };
  }

  const communityManifest = getCommunityPluginManifest(app, prefix);
  if (communityManifest) {
    return {
      type: "community",
      id: prefix,
      label: communityManifest.name || prefix,
      author: communityManifest.author
    };
  }

  const internalManifest = getInternalPluginManifest(app, prefix);
  if (internalManifest) {
    return {
      type: "core",
      id: prefix,
      label: internalManifest.name || CORE_COMMAND_LABELS[prefix] || "Obsidian",
      author: internalManifest.author
    };
  }

  if (CORE_COMMAND_LABELS[prefix]) {
    return {
      type: "core",
      id: prefix,
      label: CORE_COMMAND_LABELS[prefix]
    };
  }

  return {
    type: "community",
    id: prefix,
    label: `插件：${prefix}`
  };
}

function getCommunityPluginManifest(app: App, pluginId: string): PluginManifestLike | null {
  const appWithPlugins = app as App & {
    plugins?: CommunityPluginsLike;
  };
  const plugins = appWithPlugins.plugins;
  return plugins?.manifests?.[pluginId] ?? plugins?.plugins?.[pluginId]?.manifest ?? null;
}

function getInternalPluginManifest(app: App, pluginId: string): PluginManifestLike | null {
  const appWithInternalPlugins = app as App & {
    internalPlugins?: InternalPluginsLike;
  };
  const internalPlugin = appWithInternalPlugins.internalPlugins?.plugins?.[pluginId];
  return internalPlugin?.manifest ?? internalPlugin?.instance?.manifest ?? (
    internalPlugin?.name
      ? {
          id: pluginId,
          name: internalPlugin.name
        }
      : null
  );
}
