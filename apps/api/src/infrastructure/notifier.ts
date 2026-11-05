import type { DesktopNotifier } from "@synapse/contracts";

export interface NotifierHealth {
  /** `ok: false` when the adapter cannot deliver (binary missing or the last call failed). */
  health(): { ok: boolean; detail?: string };
}

/** Does nothing; used by tests and the smoke scripts so they never pop real notifications. */
export class NoopDesktopNotifier implements DesktopNotifier, NotifierHealth {
  async notify(): Promise<void> {}
  health() {
    return { ok: true };
  }
}

/** Runs `argv` without a shell; resolves with the exit code. Rejects on spawn failure or timeout. */
export type SpawnFn = (argv: string[], timeoutMs: number) => Promise<number>;

const BIN = "notify-send";
const TIMEOUT_MS = 5_000;
const URGENCY = { high: "critical", warning: "normal", info: "low" } as const;

const bunSpawn: SpawnFn = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const code = await proc.exited;
    if (proc.killed) throw new Error("notify-send timed out");
    return code;
  } finally {
    clearTimeout(timer);
  }
};

/** `notify-send` adapter: argv array, no shell, title only (no body), 5 s timeout. */
export class NotifySendNotifier implements DesktopNotifier, NotifierHealth {
  private lastFailed = false;
  private readonly spawn: SpawnFn;
  private readonly which: (bin: string) => string | null;

  constructor(opts: { spawn?: SpawnFn; which?: (bin: string) => string | null } = {}) {
    this.spawn = opts.spawn ?? bunSpawn;
    this.which = opts.which ?? ((b) => Bun.which(b));
  }

  async notify(n: { title: string; severity: "info" | "warning" | "high" }): Promise<void> {
    try {
      const code = await this.spawn(
        // "--" ends option parsing: titles carry Slack display names, which other people control.
        [BIN, "--app-name=Synapse", `--urgency=${URGENCY[n.severity]}`, "--", n.title],
        TIMEOUT_MS,
      );
      if (code !== 0) throw new Error(`notify-send exited with ${code}`);
      this.lastFailed = false;
    } catch (e) {
      this.lastFailed = true;
      throw e;
    }
  }

  health(): { ok: boolean; detail?: string } {
    if (this.which(BIN) === null) return { ok: false, detail: "notify-send not found on PATH" };
    if (this.lastFailed) return { ok: false, detail: "last desktop notification failed" };
    return { ok: true };
  }
}
