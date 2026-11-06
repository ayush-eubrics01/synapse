/**
 * Runs read-only git commands for the repository provider (C3): an argv array (never a shell),
 * `-C <dir>` instead of a working directory (so a missing path is a git error, not a spawn
 * failure), a hard timeout, no terminal prompts, no optional locks and no fsmonitor hook (a
 * repository's own config could otherwise name a command to run). stderr is discarded: it can
 * contain paths or remote URLs, and nothing here logs.
 */

export const GIT_TIMEOUT_MS = 10_000;

export interface GitResult {
  /** git's exit code; -1 when it could not be started or was killed by the timeout. */
  code: number;
  stdout: string;
  timedOut: boolean;
}

export interface GitOptions {
  home: string;
  timeoutMs?: number;
  /** The git executable (tests point it at a missing binary to simulate a spawn failure). */
  binary?: string;
}

export async function runGit(dir: string, args: string[], opts: GitOptions): Promise<GitResult> {
  const argv = [opts.binary ?? "git", "-c", "core.fsmonitor=false", "-C", dir, ...args];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: "/",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: opts.home,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
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
  }, opts.timeoutMs ?? GIT_TIMEOUT_MS);
  try {
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const code = await proc.exited;
    return timedOut ? { code: -1, stdout: "", timedOut } : { code, stdout, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Non-empty trimmed lines. */
export function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
