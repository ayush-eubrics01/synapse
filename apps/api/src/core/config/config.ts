export interface AppConfig {
  dbPath: string;
  api: { host: string; port: number };
  web: { host: string; port: number };
  workerConcurrency: number;
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

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const apiHost = env.SYNAPSE_API_HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(apiHost)) {
    throw new Error(
      `SYNAPSE_API_HOST must be a loopback address (127.0.0.1, ::1 or localhost), got "${apiHost}"`,
    );
  }
  return {
    dbPath: env.SYNAPSE_DB_PATH || defaultDbPath(env),
    api: { host: apiHost, port: parsePort("SYNAPSE_API_PORT", env.SYNAPSE_API_PORT, 7400) },
    web: { host: "127.0.0.1", port: parsePort("SYNAPSE_WEB_PORT", env.SYNAPSE_WEB_PORT, 7401) },
    workerConcurrency: 2,
  };
}
