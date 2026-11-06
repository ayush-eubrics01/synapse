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
/** `auto` approves tool calls by classifier; `--permission-mode default` overrides all of them. */
const WIDENING_MODES = new Set(["bypassPermissions", "acceptEdits", "auto"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * True when parsed user settings widen file or shell scope: a `permissions.allow` entry for one
 * of the fs or write built-ins (bare or with a specifier), a non-empty
 * `permissions.additionalDirectories`, a `permissions.defaultMode` of `bypassPermissions`,
 * `acceptEdits` or `auto`, or any top-level `sandbox` key (ADR-040). Only this boolean is derived;
 * no entry is kept.
 *
 * `sandbox`, whatever its content: with `--setting-sources user` the user's sandbox settings
 * merge into a develop run's sandbox key by key. Arrays (excludedCommands, allowWrite, allowedDomains,
 * …) would loosen it, and so would keys the run does not set (httpProxyPort/socksProxyPort,
 * enableWeakerNestedSandbox, allowLocalBinding, any future key). Refusing on its presence is the
 * simplest rule that covers them all (controller ruling, Task 2 fix round 1).
 */
export function userPermissionsWidenScope(settings: unknown): boolean {
  if (!isRecord(settings)) return false;
  if (Object.hasOwn(settings, "sandbox")) return true;
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

/**
 * Connector server names (`mcp__<server>`) of the user's `permissions.allow` entries that start
 * with `mcp__`, sorted and deduplicated. Only the server part is kept, never the tool or a
 * specifier. An entry with no recognisable server part is returned whole (after stripping a
 * specifier), so it can never match a known server name and errs on the refusing side. The
 * orchestrator refuses reader runs while any of them is outside `orchestrator.knownServers`, whose
 * servers every reader run denies (C1).
 */
export function userAllowedConnectorServers(settings: unknown): string[] {
  if (!isRecord(settings)) return [];
  const p = settings.permissions;
  if (!isRecord(p) || !Array.isArray(p.allow)) return [];
  const out = new Set<string>();
  for (const entry of p.allow) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed.startsWith("mcp__")) continue;
    const i = trimmed.indexOf("(");
    const name = (i === -1 ? trimmed : trimmed.slice(0, i)).trim();
    const rest = name.slice("mcp__".length);
    const j = rest.indexOf("__");
    out.add(j > 0 ? `mcp__${rest.slice(0, j)}` : name);
  }
  return [...out].sort();
}

export interface UserSettingsSummary {
  /** Plugin NAMES (the keys of `enabledPlugins`). */
  pluginNames: string[];
  userPermissionsWidenScope: boolean;
  /** Server names only (see `userAllowedConnectorServers`). */
  userAllowedConnectorServers: string[];
}

/**
 * Plugin names, the widening flag and the connector server names of user-level allow entries from
 * a Claude Code settings file. Nothing else in the file is kept, returned or logged. Missing,
 * unreadable or malformed files give no plugins, no widening and no servers (the same fallback as
 * before), silently.
 */
export function readUserSettings(settingsPath: string): UserSettingsSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return { pluginNames: [], userPermissionsWidenScope: false, userAllowedConnectorServers: [] };
  }
  const plugins = isRecord(parsed) ? parsed.enabledPlugins : undefined;
  return {
    pluginNames: isRecord(plugins) ? Object.keys(plugins) : [],
    userPermissionsWidenScope: userPermissionsWidenScope(parsed),
    userAllowedConnectorServers: userAllowedConnectorServers(parsed),
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

/**
 * Reads `<home>/.claude/settings.json` once: the override, the widening flag and the user-allowed
 * connector server names.
 */
export function loadUserSettings(home: string): {
  override: string;
  userPermissionsWidenScope: boolean;
  userAllowedConnectorServers: string[];
} {
  const s = readUserSettings(join(home, ".claude", "settings.json"));
  return {
    override: buildSettingsOverride(s.pluginNames),
    userPermissionsWidenScope: s.userPermissionsWidenScope,
    userAllowedConnectorServers: s.userAllowedConnectorServers,
  };
}

/** Reads `<home>/.claude/settings.json` once and builds the override. */
export function loadSettingsOverride(home: string): string {
  return loadUserSettings(home).override;
}
