import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, runMigrations } from "@synapse/database";
import { systemClock } from "@synapse/shared";
import { JobQueue } from "../../src/core/jobs/queue";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

function startWorker(dbPath: string, workerId: string): () => Promise<string[]> {
  const proc = Bun.spawn(["bun", "apps/api/test/fixtures/claim-worker.ts", dbPath, workerId], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return async () => {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`worker ${workerId} exited ${code}: ${err}`);
    return JSON.parse(out) as string[];
  };
}

test("two worker processes never claim the same job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-claim-"));
  try {
    const dbPath = join(dir, "test.db");
    const { db, sqlite } = openDatabase(dbPath);
    runMigrations(db);
    const q = new JobQueue(db, systemClock);
    db.transaction((tx) => {
      for (let i = 0; i < 300; i++) q.enqueue(tx, { type: "t", idempotencyKey: `k${i}` });
    });
    const waitA = startWorker(dbPath, "w1");
    const waitB = startWorker(dbPath, "w2");
    while (!(existsSync(`${dbPath}.ready.w1`) && existsSync(`${dbPath}.ready.w2`))) {
      await Bun.sleep(5);
    }
    writeFileSync(`${dbPath}.go`, "");
    const [a, b] = await Promise.all([waitA(), waitB()]);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    const all = [...a, ...b];
    expect(all).toHaveLength(300);
    expect(new Set(all).size).toBe(300);
    expect(q.list({ status: "COMPLETED", limit: 300 })).toHaveLength(300);
    sqlite.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
