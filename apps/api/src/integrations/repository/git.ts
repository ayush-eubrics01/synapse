/**
 * The hardened git runner (C3, E17). Every Synapse git call goes through here:
 * - an argv array (never a shell);
 * - `-C <dir>` instead of a working directory (so a missing path is a git error, not a spawn
 *   failure), with the process itself started in `/`;
 * - `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.interactive=never`, so a
 *   repository's own config cannot name a command to run, no hook runs and no credential prompt
 *   appears (command-line `-c` wins over every config file);
 * - a minimal env: PATH, HOME, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, plus
 *   the variables ssh-agent and credential helpers need, when set (the user's credentials are used
 *   as configured; nothing here reads a token);
 * - a hard timeout: 60 s, or 120 s for the network commands (push, fetch, pull, ls-remote).
 * stderr is discarded: it can contain paths or remote URLs, and nothing here logs.
 */

export const GIT_TIMEOUT_MS = 60_000;
export const GIT_NETWORK_TIMEOUT_MS = 120_000;

const NETWORK_SUBCOMMANDS = new Set(["push", "fetch", "pull", "ls-remote"]);

export const GIT_HARDENING_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.interactive=never",
] as const;

/** Inherited only when set: ssh-agent, and the session bus/runtime dir credential helpers use. */
const PASSTHROUGH_ENV = ["SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;

export interface GitResult {
  /** git's exit code; -1 when it could not be started or was killed by the timeout. */
  code: number;
  stdout: string;
  timedOut: boolean;
}

/** Exactly what is spawned: argv, env and timeout. */
export interface GitInvocation {
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

export type GitExec = (inv: GitInvocation) => Promise<GitResult>;

export interface GitOptions {
  home: string;
  /** Overrides the per-command default timeout for every call. */
  timeoutMs?: number;
  /** The git executable (tests point it at a missing binary to simulate a spawn failure). */
  binary?: string;
  /**
   * Extra env (tests: `GIT_CONFIG_NOSYSTEM`). Applied before the fixed variables, so it can
   * never turn prompts or optional locks back on.
   */
  extraEnv?: Record<string, string>;
  /** Spawns an invocation; tests wrap `spawnGit` to record every call. */
  exec?: GitExec;
}

/** Builds the invocation for `git <args>` in `dir`. Pure apart from reading process.env. */
export function gitInvocation(dir: string, args: string[], opts: GitOptions): GitInvocation {
  const env: Record<string, string> = { ...(opts.extraEnv ?? {}) };
  for (const k of PASSTHROUGH_ENV) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  Object.assign(env, {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: opts.home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  });
  const sub = args[0] ?? "";
  return {
    argv: [opts.binary ?? "git", ...GIT_HARDENING_ARGS, "-C", dir, ...args],
    env,
    timeoutMs:
      opts.timeoutMs ?? (NETWORK_SUBCOMMANDS.has(sub) ? GIT_NETWORK_TIMEOUT_MS : GIT_TIMEOUT_MS),
  };
}

/** Spawns an invocation from `/` with stdin closed and stderr discarded. */
export async function spawnGit(inv: GitInvocation): Promise<GitResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(inv.argv, {
      cwd: "/",
      env: inv.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return { code: -1, stdout: "", timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, inv.timeoutMs);
  try {
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const code = await proc.exited;
    return timedOut ? { code: -1, stdout: "", timedOut } : { code, stdout, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export function runGit(dir: string, args: string[], opts: GitOptions): Promise<GitResult> {
  return (opts.exec ?? spawnGit)(gitInvocation(dir, args, opts));
}

/** Non-empty trimmed lines. */
export function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
