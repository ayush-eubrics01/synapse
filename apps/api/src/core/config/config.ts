import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export interface AppConfig {
  dbPath: string;
  api: { host: string; port: number };
  web: { host: string; port: number };
  workerConcurrency: number;
  claudeBinary: string;
  credentialsPath: string;
  /** null: resolved at startup to `<data dir>/backups`. */
  backupDir: string | null;
}

export const REPO_ROOT = resolve(import.meta.dir, "../../../../..");

function realIfExists(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** A backup dir must be absolute and not the repository or inside it (backups hold real data). */
export function checkBackupDir(
  dir: string,
  repoRoot = REPO_ROOT,
): "ok" | "not_absolute" | "inside_repo" {
  if (!isAbsolute(dir)) return "not_absolute";
  const rel = relative(realIfExists(repoRoot), realIfExists(resolve(dir)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? "inside_repo" : "ok";
}

const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer port between 1 and 65535, got "${raw}"`);
  }
  return port;
}

function defaultDbPath(env: Record<string, string | undefined>): string {
  if (env.XDG_DATA_HOME) return `${env.XDG_DATA_HOME}/synapse/synapse.db`;
  if (!env.HOME)
    throw new Error("cannot resolve database path: set SYNAPSE_DB_PATH, XDG_DATA_HOME or HOME");
  return `${env.HOME}/.local/share/synapse/synapse.db`;
}

/** The user's home: $HOME, else os.homedir(). Shared with the container's provider env. */
export function resolveHome(env: Record<string, string | undefined>): string {
  return env.HOME || homedir();
}

function homePath(
  env: Record<string, string | undefined>,
  override: string | undefined,
  rel: string,
): string {
  return override || `${resolveHome(env)}/${rel}`;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const apiHost = env.SYNAPSE_API_HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(apiHost)) {
    throw new Error(
      `SYNAPSE_API_HOST must be a loopback address (127.0.0.1, ::1 or localhost), got "${apiHost}"`,
    );
  }
  const backupDir = env.SYNAPSE_BACKUP_DIR || null;
  if (backupDir !== null && checkBackupDir(backupDir) !== "ok") {
    throw new Error("SYNAPSE_BACKUP_DIR must be an absolute path outside the repository");
  }
  return {
    dbPath: env.SYNAPSE_DB_PATH || defaultDbPath(env),
    api: { host: apiHost, port: parsePort("SYNAPSE_API_PORT", env.SYNAPSE_API_PORT, 7400) },
    web: { host: "127.0.0.1", port: parsePort("SYNAPSE_WEB_PORT", env.SYNAPSE_WEB_PORT, 7401) },
    workerConcurrency: 2,
    claudeBinary: homePath(env, env.SYNAPSE_CLAUDE_BIN, ".local/bin/claude"),
    credentialsPath: homePath(env, env.SYNAPSE_CLAUDE_CREDENTIALS, ".claude/.credentials.json"),
    backupDir,
  };
}
