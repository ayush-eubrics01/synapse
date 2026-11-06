import { userInfo } from "node:os";
import { loadConfig } from "../../apps/api/src/core/config/config";

export const UNITS = ["synapse-api.service", "synapse-web.service"];

export interface StatusDeps {
  run: (cmd: string[]) => Promise<{ stdout: string; code: number }>;
  fetchHealth: () => Promise<string | null>;
  user: string;
}

const WORD = /^[a-z-]+$/;
const HEALTH = ["ok", "degraded", "down"];

function firstWord(stdout: string): string {
  const token = stdout.trim().split(/\s+/)[0] ?? "";
  return WORD.test(token) ? token : "unknown";
}

/** Read-only: three fixed command forms, statuses only (no journal content). */
export async function collectServiceStatus(deps: StatusDeps): Promise<string[]> {
  const lines: string[] = [];
  for (const unit of UNITS) {
    const active = await deps.run(["systemctl", "--user", "is-active", unit]);
    const enabled = await deps.run(["systemctl", "--user", "is-enabled", unit]);
    lines.push(`${unit}: active=${firstWord(active.stdout)} enabled=${firstWord(enabled.stdout)}`);
  }
  const linger = await deps.run(["loginctl", "show-user", deps.user, "-p", "Linger"]);
  const value = /^Linger=(yes|no)$/m.exec(linger.stdout)?.[1];
  lines.push(`linger: ${value === "yes" ? "on" : value === "no" ? "off" : "unknown"}`);
  const health = await deps.fetchHealth();
  lines.push(`api health: ${health !== null && HEALTH.includes(health) ? health : "unreachable"}`);
  return lines;
}

/** USER, else the OS account name; never an empty string. */
export function resolveUser(
  env: Record<string, string | undefined>,
  osUser: () => string = () => userInfo().username,
): string {
  const fromEnv = env.USER?.trim();
  if (fromEnv) return fromEnv;
  try {
    return osUser();
  } catch {
    return "unknown";
  }
}

const TIMEOUT_MS = 5_000;

async function run(cmd: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: TIMEOUT_MS });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
  } catch {
    return { stdout: "", code: 127 };
  }
}

async function fetchHealth(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/ready`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json()) as { status?: unknown };
    return typeof body.status === "string" ? body.status : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const port = loadConfig(process.env).api.port;
  const lines = await collectServiceStatus({
    run,
    fetchHealth: () => fetchHealth(port),
    user: resolveUser(process.env),
  });
  for (const l of lines) console.log(l);
  process.exit(0);
}
