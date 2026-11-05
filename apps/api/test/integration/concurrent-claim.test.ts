import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, runMigrations } from "@synapse/database";
import { systemClock } from "@synapse/shared";
import { JobQueue } from "../../src/core/jobs/queue.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

async function runWorker(dbPath: string, workerId: string): Promise<string[]> {
  const proc = Bun.spawn(["bun", "apps/api/test/fixtures/claim-worker.ts", dbPath, workerId], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`worker ${workerId} exited ${code}: ${err}`);
  return JSON.parse(out) as string[];
}

test("two worker processes never claim the same job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-claim-"));
  try {
    const dbPath = join(dir, "test.db");
    const { db, sqlite } = openDatabase(dbPath);
    runMigrations(db);
    const q = new JobQueue(db, systemClock);
    db.transaction((tx) => {
      for (let i = 0; i < 200; i++) q.enqueue(tx, { type: "t", idempotencyKey: `k${i}` });
    });
    const [a, b] = await Promise.all([runWorker(dbPath, "w1"), runWorker(dbPath, "w2")]);
    const all = [...a, ...b];
    expect(all).toHaveLength(200);
    expect(new Set(all).size).toBe(200);
    expect(q.list({ status: "COMPLETED", limit: 1000 })).toHaveLength(200);
    sqlite.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
