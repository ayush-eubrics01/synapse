import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSettingsOverride,
  DEFAULT_SETTINGS_OVERRIDE,
  loadSettingsOverride,
  readPluginNames,
} from "../../src/integrations/claude-code/settings-override";

const tmp = mkdtempSync(join(tmpdir(), "settings-override-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SECRET = "sk-ant-SECRET-TOKEN-VALUE";

function home(name: string, settings: unknown | string): string {
  const h = join(tmp, name);
  mkdirSync(join(h, ".claude"), { recursive: true });
  writeFileSync(
    join(h, ".claude", "settings.json"),
    typeof settings === "string" ? settings : JSON.stringify(settings),
  );
  return h;
}

test("reads only enabledPlugins names; other settings content never reaches the override", () => {
  const h = home("full", {
    env: { ANTHROPIC_API_KEY: SECRET },
    apiKeyHelper: `echo ${SECRET}`,
    hooks: { PreToolUse: [{ command: `curl ${SECRET}` }] },
    enabledPlugins: { "postman@official": true, "superpowers@market": { note: SECRET } },
    permissions: { allow: [SECRET] },
  });
  expect(readPluginNames(join(h, ".claude", "settings.json"))).toEqual([
    "postman@official",
    "superpowers@market",
  ]);
  const override = loadSettingsOverride(h);
  expect(JSON.parse(override)).toEqual({
    enabledPlugins: { "postman@official": false, "superpowers@market": false },
    hooks: {},
  });
  expect(override).not.toContain(SECRET);
});

test("missing, unreadable or malformed settings fall back to the default override", () => {
  expect(DEFAULT_SETTINGS_OVERRIDE).toBe('{"enabledPlugins":{},"hooks":{}}');
  expect(loadSettingsOverride(join(tmp, "nope"))).toBe(DEFAULT_SETTINGS_OVERRIDE);
  expect(loadSettingsOverride(home("bad-json", "{not json"))).toBe(DEFAULT_SETTINGS_OVERRIDE);
  expect(loadSettingsOverride(home("no-plugins", { env: { X: SECRET } }))).toBe(
    DEFAULT_SETTINGS_OVERRIDE,
  );
  expect(loadSettingsOverride(home("array", { enabledPlugins: ["a"] }))).toBe(
    DEFAULT_SETTINGS_OVERRIDE,
  );
  const dirHome = join(tmp, "dir");
  mkdirSync(join(dirHome, ".claude", "settings.json"), { recursive: true });
  expect(loadSettingsOverride(dirHome)).toBe(DEFAULT_SETTINGS_OVERRIDE);
});

test("buildSettingsOverride disables every named plugin and clears hooks", () => {
  expect(buildSettingsOverride(["a@b", 'q"uote'])).toBe(
    JSON.stringify({ enabledPlugins: { "a@b": false, 'q"uote': false }, hooks: {} }),
  );
  expect(buildSettingsOverride([])).toBe(DEFAULT_SETTINGS_OVERRIDE);
});
