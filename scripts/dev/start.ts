// Starts the API (127.0.0.1:7400, watch mode) and the web dashboard (127.0.0.1:7401) together.
// Output is prefixed [api] / [web]. Ctrl+C stops both; if either exits, the other is stopped too.
//
//   bun run dev            (from the repo root)
//
// It uses your normal database (SYNAPSE_DB_PATH, else ~/.local/share/synapse). Ports and paths come
// from the usual SYNAPSE_* environment variables.

/** Splits a byte stream into lines and emits each complete line with a prefix. */
export class LineSplitter {
  private tail = "";
  constructor(
    private readonly prefix: string,
    private readonly emit: (line: string) => void,
  ) {}

  push(chunk: string): void {
    const parts = (this.tail + chunk).split("\n");
    this.tail = parts.pop() ?? "";
    for (const p of parts) this.emit(this.prefix + p);
  }

  flush(): void {
    if (this.tail !== "") this.emit(this.prefix + this.tail);
    this.tail = "";
  }
}

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string): Promise<void> {
  const split = new LineSplitter(prefix, (l) => console.log(l));
  const decoder = new TextDecoder();
  for await (const chunk of stream) split.push(decoder.decode(chunk, { stream: true }));
  split.flush();
}

async function main(): Promise<void> {
  const root = new URL("../..", import.meta.url).pathname;
  const procs = [
    { name: "api", cwd: `${root}apps/api` },
    { name: "web", cwd: `${root}apps/web` },
  ].map(({ name, cwd }) => {
    const proc = Bun.spawn(["bun", "run", "dev"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
    void pipe(proc.stdout, `[${name}] `);
    void pipe(proc.stderr, `[${name}] `);
    return { name, proc };
  });

  let stopping = false;
  const stopAll = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const { proc } of procs) if (proc.exitCode === null) proc.kill("SIGTERM");
    setTimeout(() => process.exit(code), 3000).unref();
  };
  process.on("SIGINT", () => stopAll(0));
  process.on("SIGTERM", () => stopAll(0));

  console.log(
    "Synapse: API http://127.0.0.1:7400 · dashboard http://127.0.0.1:7401 (Ctrl+C stops both)",
  );
  const first = await Promise.race(procs.map(async (p) => ({ ...p, code: await p.proc.exited })));
  if (!stopping)
    console.log(`[${first.name}] exited with code ${first.code}; stopping the other server`);
  stopAll(first.code === 0 ? 0 : 1);
  await Promise.all(procs.map((p) => p.proc.exited));
  process.exit(first.code === 0 ? 0 : 1);
}

if (import.meta.main) await main();
