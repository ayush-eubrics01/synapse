import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { newId } from "@synapse/shared";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const spawned: Subprocess[] = [];
const dirs: string[] = [];
type Subprocess = ReturnType<typeof Bun.spawn>;

afterEach(() => {
  for (const p of spawned.splice(0)) p.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port;
  if (port === undefined) throw new Error("no port");
  s.stop(true);
  return port;
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "synapse-proc-"));
  dirs.push(dir);
  return join(dir, "synapse.db");
}

function start(dbPath: string, port: number, extra: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", "apps/api/src/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      SYNAPSE_DB_PATH: dbPath,
      SYNAPSE_API_PORT: String(port),
      SYNAPSE_CLAUDE_BIN: "/nonexistent/claude",
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      ...extra,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  spawned.push(p);
  return p;
}

async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
  throw new Error("timed out");
}

function readSetting(dbPath: string, key: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("select value from app_settings where key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value;
  } finally {
    db.close();
  }
}

const live = async (port: number) =>
  (await fetch(`http://127.0.0.1:${port}/health/live`)).status === 200 ? true : undefined;

test("runs without the web app: heartbeat is recorded; foreign Host is refused", async () => {
  const dbPath = tempDb();
  const port = freePort();
  start(dbPath, port);
  await waitFor(() => live(port), 8000);
  await waitFor(() => readSetting(dbPath, "system.lastHeartbeatAt"), 8000);
  const rebound = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
    headers: { host: `rebound.example:${port}` },
  });
  expect(rebound.status).toBe(403);
}, 20_000);

test("SIGTERM exits cleanly with code 0", async () => {
  const dbPath = tempDb();
  const port = freePort();
  const p = start(dbPath, port);
  await waitFor(() => live(port), 8000);
  p.kill("SIGTERM");
  const code = await Promise.race([p.exited, Bun.sleep(12_000).then(() => "timeout")]);
  expect(code).toBe(0);
}, 20_000);

test("restart mid-job: expired RUNNING job is recovered and completed", async () => {
  const dbPath = tempDb();
  const { sqlite, db } = openDatabase(dbPath);
  runMigrations(db);
  const id = newId();
  const past = new Date(Date.now() - 60_000).toISOString();
  db.insert(schema.jobs)
    .values({
      id,
      type: "test.noop",
      priority: 100,
      status: "RUNNING",
      input: {},
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: `restart-${id}`,
      runAfter: past,
      leaseOwner: "dead-worker",
      leaseExpiresAt: past,
      createdAt: past,
    })
    .run();
  sqlite.close();
  const port = freePort();
  start(dbPath, port, { SYNAPSE_TEST_HANDLERS: "1" });
  const status = await waitFor(() => {
    const d = new Database(dbPath, { readonly: true });
    try {
      const row = d.query("select status from jobs where id = ?").get(id) as {
        status: string;
      } | null;
      return row?.status === "COMPLETED" ? row.status : undefined;
    } finally {
      d.close();
    }
  }, 8000);
  expect(status).toBe("COMPLETED");
}, 20_000);

test("port in use: exits 1 with a message", async () => {
  const port = freePort();
  const blocker = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") });
  try {
    const p = start(tempDb(), port);
    const code = await Promise.race([p.exited, Bun.sleep(8000).then(() => "timeout")]);
    expect(code).toBe(1);
    const err = await new Response(p.stderr as ReadableStream).text();
    expect(err).toContain("already in use");
  } finally {
    blocker.stop(true);
  }
}, 20_000);

test("SSE stream flushes headers promptly and survives past 10 s idle", async () => {
  const port = freePort();
  start(tempDb(), port);
  await waitFor(() => live(port), 8000);
  const ctrl = new AbortController();
  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ctrl.signal });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let closed = false;
    const pump = (async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // connection reset
      }
      closed = true;
    })();
    await Bun.sleep(12_000);
    expect(closed).toBe(false);
    ctrl.abort();
    await pump;
  } finally {
    ctrl.abort();
  }
}, 20_000);
