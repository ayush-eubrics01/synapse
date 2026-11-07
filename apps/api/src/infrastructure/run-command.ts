export type CommandRunner = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<string>;

export class CommandTimeoutError extends Error {
  constructor() {
    super("command timed out");
    this.name = "CommandTimeoutError";
  }
}

export const runCommand: CommandRunner = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  })();
  if (opts?.timeoutMs === undefined) return work;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new CommandTimeoutError());
    }, opts.timeoutMs);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};
