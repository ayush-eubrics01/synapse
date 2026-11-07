import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AIProvider } from "@synapse/contracts";
import { createContainer } from "../../src/container";
import { instanceRunRoot, loadConfig } from "../../src/core/config/config";
import { sweepRunScratch } from "../../src/workers/engineering/steps";
import { tempDir } from "../fixtures/git-repo";

/**
 * Task 4b fix: the develop-run root is per instance (`<cache>/synapse/<hash of data dir>`), so the
 * startup sweep of one API (a smoke, a second dev API) never touches another instance's runs.
 */

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function container(root: string, name: string, cache: string) {
  const dbPath = join(root, name, "synapse.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  return createContainer(
    { ...loadConfig({ HOME: root, SYNAPSE_DB_PATH: dbPath }), backupDir: join(root, `${name}-bk`) },
    {
      run: async () => "Linger=yes",
      provider: fakeProvider,
      diskFree: () => 100 * 2 ** 30,
      claudeProjectsDir: join(root, "no-projects"),
      runCacheBase: cache,
    },
  );
}

test("two containers with different data dirs never sweep each other's runs", () => {
  const root = tempDir("synapse-runroot-");
  roots.push(root);
  const cache = join(root, "cache", "synapse");

  const a = container(root, "a", cache);
  const aRoot = instanceRunRoot(cache, join(root, "a"));
  expect(a.runRoot).toBe(aRoot);
  // A develop run of instance A is in progress.
  mkdirSync(join(aRoot, "r", "a1b2c3d4", "tmp"), { recursive: true });
  writeFileSync(join(aRoot, "r", "a1b2c3d4", "tmp", "f"), "x");

  // Instance B starts (a smoke, a second dev API): A's run stays.
  const b = container(root, "b", cache);
  expect(b.runRoot).not.toBe(aRoot);
  expect(b.runRoot.startsWith(`${cache}/`)).toBe(true);
  expect(existsSync(join(aRoot, "r", "a1b2c3d4", "tmp", "f"))).toBe(true);
  mkdirSync(join(b.runRoot, "r", "e5f6a7b8"), { recursive: true });

  // A restarts: createContainer never sweeps (a second process that then fails to bind must not
  // delete the live service's runs); main.ts sweeps after the bind, and only A's own leftovers go.
  a.sqlite.close();
  const a2 = container(root, "a", cache);
  expect(a2.runRoot).toBe(aRoot);
  expect(readdirSync(join(aRoot, "r"))).toEqual(["a1b2c3d4"]);
  sweepRunScratch(a2.runRoot);
  expect(readdirSync(join(aRoot, "r"))).toEqual([]);
  expect(existsSync(join(b.runRoot, "r", "e5f6a7b8"))).toBe(true);
  // Nothing is created at startup beyond what a run needs.
  expect(readdirSync(cache).sort()).toEqual(
    [aRoot, b.runRoot].map((p) => p.slice(cache.length + 1)).sort(),
  );
  a2.sqlite.close();
  b.sqlite.close();
});

test("an in-memory container creates no run root until a develop run needs one", () => {
  const c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
    diskFree: () => 100 * 2 ** 30,
  });
  try {
    expect(existsSync(c.runRoot)).toBe(false);
  } finally {
    c.sqlite.close();
  }
});

test("main.ts sweeps the run scratch only after the server binds, next to recoverOnStartup", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/main.ts"), "utf8");
  const serve = src.indexOf("Bun.serve(");
  const sweep = src.indexOf("sweepRunScratch(c.runRoot)");
  const recover = src.indexOf("recoverOnStartup(");
  expect(serve).toBeGreaterThan(-1);
  expect(sweep).toBeGreaterThan(serve);
  expect(recover).toBeGreaterThan(serve);
  expect(src.indexOf("createContainer(")).toBeLessThan(serve);
});

test("main.ts runs the backup tick right after bind, before the first tick()", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/main.ts"), "utf8");
  const serve = src.indexOf("Bun.serve(");
  const now = src.indexOf("runNow(OPS_BACKUP_JOB)");
  const firstTick = src.indexOf("\ntick();");
  expect(now).toBeGreaterThan(serve);
  expect(firstTick).toBeGreaterThan(now);
});
