import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../../apps/api/src/core/config/config";

export interface UnitVars {
  BUN: string;
  REPO: string;
  PATH: string;
  DB_PATH: string;
}

export function renderUnit(template: string, vars: UnitVars): string {
  const out = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = (vars as unknown as Record<string, string | undefined>)[key];
    return value === undefined ? match : value;
  });
  const left = out.match(/\{\{\w+\}\}/);
  if (left) throw new Error(`unresolved placeholder ${left[0]}`);
  return out;
}

export interface InstallPlan {
  files: { path: string; content: string }[];
  commands: string[];
}

const UNITS = ["synapse-api.service", "synapse-web.service"];

export function servicePath(home: string): string {
  return `${home}/.bun/bin:${home}/.local/bin:/usr/bin:/bin`;
}

export function planInstall(opts: {
  home: string;
  repo: string;
  bunPath: string;
  dbPath: string;
}): InstallPlan {
  const vars: UnitVars = {
    BUN: opts.bunPath,
    REPO: opts.repo,
    PATH: servicePath(opts.home),
    DB_PATH: opts.dbPath,
  };
  const files = UNITS.map((name) => ({
    path: `${opts.home}/.config/systemd/user/${name}`,
    content: renderUnit(readFileSync(join(import.meta.dir, "systemd", name), "utf8"), vars),
  }));
  return {
    files,
    commands: [
      "systemctl --user daemon-reload && systemctl --user enable --now synapse-api synapse-web",
    ],
  };
}

if (import.meta.main) {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set");
  const plan = planInstall({
    home,
    repo: resolve(import.meta.dir, "../.."),
    bunPath: `${home}/.bun/bin/bun`,
    dbPath: loadConfig({ HOME: home, XDG_DATA_HOME: process.env.XDG_DATA_HOME }).dbPath,
  });
  for (const f of plan.files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
    console.log(`wrote ${f.path}`);
  }
  console.log("\nRun these yourself (not executed by this script):");
  for (const c of plan.commands) console.log(`  ${c}`);
  console.log(`  loginctl enable-linger ${process.env.USER ?? "<user>"}   # if linger is off`);
}
