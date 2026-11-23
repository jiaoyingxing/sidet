import type { RegisteredCommandInfo } from "../commands/command-registry";

const HOME_COMMAND_PRIORITY_AUTHORS = ["jiao yingxing", "焦应行"];
const HOME_COMMAND_EDITOR_COMMAND_PREFIXES = new Set(["editor", "markdown"]);
const HOME_COMMAND_EDITOR_PLUGIN_IDS = new Set([
  "editing-toolbar",
  "number-headings-obsidian",
  "cmenu",
  "obsidian-editing-toolbar"
]);
const HOME_COMMAND_DEPRECATED_IDS = new Set([
  "sidet:open-native-new-tab",
  "sidet:insert-related-notes-into-sidet-draft",
  "sidet:insert-markdown-folder-summary-into-sidet-draft",
  "sidet:repair-sidet-wiki-notes",
  "sidet:insert-memory-candidate-prompt-into-sidet-draft",
  "sidet:insert-draft-note-preview-prompt-into-sidet-draft",
  "sidet:create-memory-candidate-from-latest-sidet-reply",
  "sidet:replace-active-selection-with-latest-sidet-reply",
  "sidet:replace-active-section-with-latest-sidet-reply",
  "sidet:generate-wiki-from-current-markdown-note",
  "sidet:generate-wiki-from-markdown-note",
  "sidet:generate-skill-from-current-sidet-conversation",
  "sidet:save-latest-sidet-reply-as-wiki-memory",
  "sidet:save-latest-sidet-reply-as-skill",
  "sidet:create-draft-note-from-latest-sidet-reply",
  "sidet:append-latest-sidet-reply-to-markdown-note"
]);
const HOME_COMMAND_PUBLIC_SIDET_IDS = new Set([
  "sidet:open-sidet-workspace",
  "sidet:open-sidet-conversation-list",
  "sidet:new-sidet-conversation"
]);
const HOME_COMMAND_ID_MIGRATIONS = new Map([
  ["sidet:open-native-new-tab", "workspace:new-tab"]
]);

function getCommandIdPrefix(commandId: string): string | null {
  const separatorIndex = commandId.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  return commandId.slice(0, separatorIndex);
}

function normalizeCommandSearchText(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function isPriorityAuthorCommand(command: RegisteredCommandInfo): boolean {
  const author = normalizeCommandSearchText(command.source.author);
  return HOME_COMMAND_PRIORITY_AUTHORS.some((owner) => author.includes(owner));
}

export function isEditorFacingCommandId(commandId: string): boolean {
  const prefix = getCommandIdPrefix(commandId);
  if (!prefix) {
    return false;
  }
  return HOME_COMMAND_EDITOR_COMMAND_PREFIXES.has(prefix)
    || HOME_COMMAND_EDITOR_PLUGIN_IDS.has(prefix);
}

export function isDeprecatedHomeCommandId(commandId: string): boolean {
  return HOME_COMMAND_DEPRECATED_IDS.has(commandId);
}

export function migrateHomeLauncherCommandId(commandId: string): string {
  return HOME_COMMAND_ID_MIGRATIONS.get(commandId) ?? commandId;
}

export function isHomeLauncherCommandId(commandId: string): boolean {
  if (isEditorFacingCommandId(commandId) || isDeprecatedHomeCommandId(commandId)) {
    return false;
  }
  if (getCommandIdPrefix(commandId) === "sidet") {
    return HOME_COMMAND_PUBLIC_SIDET_IDS.has(commandId);
  }
  return true;
}

function isEditorFacingCommand(command: RegisteredCommandInfo): boolean {
  if (isEditorFacingCommandId(command.id)) {
    return true;
  }
  const sourceId = command.source.id;
  return Boolean(sourceId && HOME_COMMAND_EDITOR_PLUGIN_IDS.has(sourceId));
}

export function isHomeLauncherCommand(command: RegisteredCommandInfo): boolean {
  return isHomeLauncherCommandId(command.id) && !isEditorFacingCommand(command);
}

export function compareHomeCommandOptions(left: RegisteredCommandInfo, right: RegisteredCommandInfo): number {
  const leftPriorityAuthor = isPriorityAuthorCommand(left) ? 0 : 1;
  const rightPriorityAuthor = isPriorityAuthorCommand(right) ? 0 : 1;
  if (leftPriorityAuthor !== rightPriorityAuthor) {
    return leftPriorityAuthor - rightPriorityAuthor;
  }

  const leftSourceWeight = getHomeCommandSourceWeight(left);
  const rightSourceWeight = getHomeCommandSourceWeight(right);
  if (leftSourceWeight !== rightSourceWeight) {
    return leftSourceWeight - rightSourceWeight;
  }

  const sourceCompare = left.source.label.localeCompare(right.source.label, undefined, {
    sensitivity: "base"
  });
  if (sourceCompare !== 0) {
    return sourceCompare;
  }
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

function getHomeCommandSourceWeight(command: RegisteredCommandInfo): number {
  if (command.source.type === "community") {
    return 0;
  }
  if (command.source.type === "sidet") {
    return 1;
  }
  return 2;
}
