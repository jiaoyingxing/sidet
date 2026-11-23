export type SettingsTrack = "declarative" | "legacy";
export type SettingsRerenderAction = "update" | "display";

export interface DeclarativeSettingsSource {
  settingItems?: unknown;
}

export function detectSettingsTrack(
  source: DeclarativeSettingsSource | null | undefined
): SettingsTrack {
  const items = source?.settingItems;
  return Array.isArray(items) && items.length > 0 ? "declarative" : "legacy";
}

export function resolveSettingsRerenderAction(
  source: DeclarativeSettingsSource | null | undefined
): SettingsRerenderAction {
  return detectSettingsTrack(source) === "declarative" ? "update" : "display";
}
