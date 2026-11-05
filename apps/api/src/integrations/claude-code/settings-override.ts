import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `--settings` override used when the user's settings cannot be read (R34). */
export const DEFAULT_SETTINGS_OVERRIDE = JSON.stringify({ enabledPlugins: {}, hooks: {} });

/**
 * Plugin NAMES (the keys of `enabledPlugins`) from a Claude Code settings file. Nothing else in
 * the file is kept, returned or logged. Missing, unreadable or malformed files give [].
 */
export function readPluginNames(settingsPath: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    const plugins = (parsed as { enabledPlugins?: unknown } | null)?.enabledPlugins;
    if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return [];
    return Object.keys(plugins);
  } catch {
    return [];
  }
}

/** Disables every named plugin and all hooks; used with `--setting-sources user` (R34). */
export function buildSettingsOverride(pluginNames: string[]): string {
  return JSON.stringify({
    enabledPlugins: Object.fromEntries(pluginNames.map((n) => [n, false])),
    hooks: {},
  });
}

/** Reads `<home>/.claude/settings.json` once and builds the override. */
export function loadSettingsOverride(home: string): string {
  return buildSettingsOverride(readPluginNames(join(home, ".claude", "settings.json")));
}
