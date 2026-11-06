import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `--settings` override used when the user's settings cannot be read (R34). */
export const DEFAULT_SETTINGS_OVERRIDE = JSON.stringify({ enabledPlugins: {}, hooks: {} });

/**
 * Built-ins whose user-level `permissions.allow` entries would merge into a run's allowed tools and
 * widen a path-scoped engineering run (`--setting-sources user`; allow arrays merge across
 * sources, and the override cannot remove them).
 */
const WIDENING_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "MultiEdit",
]);
const WIDENING_MODES = new Set(["bypassPermissions", "acceptEdits"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * True when parsed user settings widen file or shell scope: a `permissions.allow` entry for one
 * of the fs or write built-ins (bare or with a specifier), a non-empty
 * `permissions.additionalDirectories`, or a `permissions.defaultMode` of `bypassPermissions` or
 * `acceptEdits`. Only this boolean is derived; no entry is kept.
 */
export function userPermissionsWidenScope(settings: unknown): boolean {
  if (!isRecord(settings)) return false;
  const p = settings.permissions;
  if (!isRecord(p)) return false;
  if (Array.isArray(p.allow)) {
    for (const entry of p.allow) {
      if (typeof entry !== "string") continue;
      const i = entry.indexOf("(");
      if (WIDENING_TOOLS.has((i === -1 ? entry : entry.slice(0, i)).trim())) return true;
    }
  }
  if (Array.isArray(p.additionalDirectories) && p.additionalDirectories.length > 0) return true;
  return typeof p.defaultMode === "string" && WIDENING_MODES.has(p.defaultMode);
}

export interface UserSettingsSummary {
  /** Plugin NAMES (the keys of `enabledPlugins`). */
  pluginNames: string[];
  userPermissionsWidenScope: boolean;
}

/**
 * Plugin names and the widening flag from a Claude Code settings file. Nothing else in the file
 * is kept, returned or logged. Missing, unreadable or malformed files give no plugins and no
 * widening (the same fallback as before), silently.
 */
export function readUserSettings(settingsPath: string): UserSettingsSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return { pluginNames: [], userPermissionsWidenScope: false };
  }
  const plugins = isRecord(parsed) ? parsed.enabledPlugins : undefined;
  return {
    pluginNames: isRecord(plugins) ? Object.keys(plugins) : [],
    userPermissionsWidenScope: userPermissionsWidenScope(parsed),
  };
}

/** Plugin NAMES (the keys of `enabledPlugins`) from a Claude Code settings file. */
export function readPluginNames(settingsPath: string): string[] {
  return readUserSettings(settingsPath).pluginNames;
}

/** Disables every named plugin and all hooks; used with `--setting-sources user` (R34). */
export function buildSettingsOverride(pluginNames: string[]): string {
  return JSON.stringify({
    enabledPlugins: Object.fromEntries(pluginNames.map((n) => [n, false])),
    hooks: {},
  });
}

/** Reads `<home>/.claude/settings.json` once: the override plus the widening flag. */
export function loadUserSettings(home: string): {
  override: string;
  userPermissionsWidenScope: boolean;
} {
  const s = readUserSettings(join(home, ".claude", "settings.json"));
  return {
    override: buildSettingsOverride(s.pluginNames),
    userPermissionsWidenScope: s.userPermissionsWidenScope,
  };
}

/** Reads `<home>/.claude/settings.json` once and builds the override. */
export function loadSettingsOverride(home: string): string {
  return loadUserSettings(home).override;
}
