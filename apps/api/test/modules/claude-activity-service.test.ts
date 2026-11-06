import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CLAUDE_ACTIVITY_FORMAT_MESSAGE } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { claudeActivityCheck } from "../../src/core/health/checks";
import { defaultFsOps, type FsOps } from "../../src/modules/claude-activity/scanner";
import {
  ClaudeActivityService,
  repositoryForCwd,
  SCAN_BUDGET_MS,
} from "../../src/modules/claude-activity/service";
import { encodeProjectDir } from "../../src/modules/claude-activity/session-meta";
import { SENTINEL, sessionLine, writeSession } from "../fixtures/claude-sessions";
import { tempDir } from "../fixtures/git-repo";

const NOW = "2026-11-06T09:00:00.000Z";
const nowMs = Date.parse(NOW);
const iso = (minAgo: number) => new Date(nowMs - minAgo * 60_000).toISOString();
const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";

const roots: string[] = [];
const scratch = (p: string) => {
  const d = tempDir(p);
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let settings: SettingsService;
let events: EventPublisher;
let projects: string;
let repoRoot: string;
let repoPath: string;
let repoId: string;
let reads: { path: string; offset: number; length: number }[];
let fs: FsOps;

function addRepo(name: string, path: string): string {
  const id = `repo-${name}`;
  db.insert(schema.repositories)
    .values({
      id,
      name,
      localPath: path,
      upstreamPushDisabled: false,
      trackedBranch: "main",
      jiraProjectKeys: [],
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return id;
}

function service(extra: Partial<ConstructorParameters<typeof ClaudeActivityService>[0]> = {}) {
  return new ClaudeActivityService({
    db,
    clock,
    settings,
    events,
    audit: new AuditLogger(clock),
    projectsDir: projects,
    fs,
    ...extra,
  });
}

function dirFor(path = repoPath) {
  return join(projects, encodeProjectDir(path));
}

function write(id: string, lines: string[], mtimeMinAgo: number, dir = dirFor()): string {
  const p = writeSession(dir, id, lines);
  const t = new Date(nowMs - mtimeMinAgo * 60_000);
  utimesSync(p, t, t);
  return p;
}

const baseLines = (cwd = repoPath, minAgo = 30) => [
  sessionLine("user", {
    cwd,
    gitBranch: "feature-x",
    version: "2.1.0",
    entrypoint: "cli",
    timestamp: iso(minAgo + 1),
  }),
  sessionLine("ai-title", { aiTitle: "Demo title" }),
  sessionLine("pr-link", {
    prUrl: "https://github.com/demo-org/demo-app/pull/7",
    prNumber: 7,
    prRepository: "demo-org/demo-app",
    timestamp: iso(minAgo),
  }),
];

const sessions = () => db.select().from(schema.claudeSessions).all();
const prs = () => db.select().from(schema.claudeSessionPrs).all();

beforeEach(() => {
  ({ db } = openDatabase(":memory:"));
  runMigrations(db);
  clock = new FakeClock(NOW);
  events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  projects = scratch("synapse-claude-proj-");
  repoRoot = scratch("synapse-claude-repos-");
  repoPath = join(repoRoot, "demo-app");
  mkdirSync(repoPath);
  repoId = addRepo("demo-app", repoPath);
  reads = [];
  fs = {
    ...defaultFsOps,
    readRange: (path, offset, length) => {
      reads.push({ path, offset, length });
      return defaultFsOps.readRange(path, offset, length);
    },
  };
});

afterEach(() => {
  rmSync(projects, { recursive: true, force: true });
});

describe("scan", () => {
  test("stores one session row and one PR", async () => {
    const path = write(ID, baseLines(), 30);
    const s = await service().scan();
    expect(s).toMatchObject({ files: 1, sessionsUpserted: 1, prsInserted: 1 });
    const [row] = sessions();
    expect(row).toMatchObject({
      sessionId: ID,
      repositoryId: repoId,
      cwd: repoPath,
      title: "Demo title",
      gitBranch: "feature-x",
      version: "2.1.0",
      entrypoint: "cli",
      firstAt: iso(31),
      lastAt: iso(30),
      fileOffset: statSync(path).size,
    });
    const [pr] = prs();
    expect(pr).toMatchObject({
      prUrl: "https://github.com/demo-org/demo-app/pull/7",
      gitBranch: "feature-x",
      firstSeenAt: iso(30),
      repositoryId: repoId,
    });
  });

  test("unchanged file is skipped without reads; an append reads only new bytes", async () => {
    const path = write(ID, baseLines(), 30);
    const svc = service();
    await svc.scan();
    const size = statSync(path).size;
    reads.length = 0;
    expect((await svc.scan()).skippedUnchanged).toBe(1);
    expect(reads).toEqual([]);
    appendFileSync(path, `${sessionLine("user", { timestamp: iso(20) })}\n`);
    const t = new Date(nowMs - 20 * 60_000);
    utimesSync(path, t, t);
    const s = await svc.scan();
    expect(s.sessionsUpserted).toBe(1);
    expect(reads).toHaveLength(1);
    // one byte before the offset is read to confirm a line boundary
    expect(reads[0]?.offset).toBe(size - 1);
    expect(sessions()[0]?.lastAt).toBe(iso(20));
    expect(prs()).toHaveLength(1);
  });

  test("a partial last line waits until it is completed", async () => {
    const path = write(ID, baseLines(), 30);
    const svc = service();
    await svc.scan();
    const size = statSync(path).size;
    appendFileSync(path, `{"type":"user","timestamp":"${iso(10)}"`);
    const t30 = new Date(nowMs - 30 * 60_000);
    utimesSync(path, t30, t30);
    await svc.scan();
    expect(sessions()[0]?.fileOffset).toBe(size);
    expect(sessions()[0]?.lastAt).toBe(iso(30));
    appendFileSync(path, "}\n");
    utimesSync(path, t30, t30);
    await svc.scan();
    expect(sessions()[0]?.lastAt).toBe(iso(10));
  });

  test("a file truncated below the stored offset is re-read from 0", async () => {
    const path = write(ID, baseLines(repoPath, 60), 60);
    const svc = service();
    await svc.scan();
    const full = statSync(path).size;
    const shortLines = [
      sessionLine("user", { cwd: repoPath, gitBranch: "main", timestamp: iso(50) }),
      sessionLine("ai-title", { aiTitle: "Demo rewritten" }),
    ];
    writeFileSync(path, `${shortLines.join("\n")}\n`);
    expect(statSync(path).size).toBeLessThan(full);
    const t = new Date(nowMs - 50 * 60_000);
    utimesSync(path, t, t);
    reads.length = 0;
    await svc.scan();
    expect(reads[0]?.offset).toBe(0);
    const [row] = sessions();
    expect(row).toMatchObject({
      title: "Demo rewritten",
      gitBranch: "main",
      firstAt: iso(50),
      lastAt: iso(50),
      fileOffset: statSync(path).size,
    });
    // also truncating in place
    truncateSync(path, 0);
    await svc.scan();
    expect(sessions()).toHaveLength(1);
  });

  test("a file without a cwd yet stores nothing and is re-read from 0", async () => {
    const path = write(ID, [sessionLine("ai-title", { aiTitle: "Demo title" })], 30);
    const svc = service();
    await svc.scan();
    expect(sessions()).toHaveLength(0);
    reads.length = 0;
    await svc.scan();
    expect(reads[0]?.offset).toBe(0);
    appendFileSync(path, `${sessionLine("user", { cwd: repoPath, timestamp: iso(29) })}\n`);
    await svc.scan();
    expect(sessions()[0]?.title).toBe("Demo title");
  });

  test("a cwd outside every repository is ignored until it is registered", async () => {
    const other = join(repoRoot, "demo-other");
    mkdirSync(other);
    write(ID, baseLines(other), 30, dirFor(other));
    const svc = service();
    // the directory is only a candidate once some repository encodes to it
    const first = await svc.scan();
    expect(first.files).toBe(0);
    // a nested dir name under demo-app's prefix whose cwd lies elsewhere
    write(ID2, baseLines(other), 30, `${dirFor()}-wt`);
    const s = await svc.scan();
    expect(s.ignored).toBe(1);
    expect(sessions()).toHaveLength(0);
    reads.length = 0;
    expect((await svc.scan()).ignored).toBe(1);
    expect(reads).toEqual([]);
    addRepo("demo-other", other);
    const after = await svc.scan();
    expect(after.sessionsUpserted).toBe(2);
    expect(sessions().find((r) => r.sessionId === ID2)?.repositoryId).toBe("repo-demo-other");
  });

  test("a cwd through a symlink matches; a sibling name does not", async () => {
    const link = join(repoRoot, "link-to-app");
    symlinkSync(repoPath, link);
    write(ID, baseLines(`${link}/`), 30);
    const sibling = `${repoPath}-two`;
    mkdirSync(sibling);
    write(ID2, baseLines(sibling), 30, `${dirFor()}-two`);
    const s = await service().scan();
    expect(s.ignored).toBe(1);
    expect(sessions().map((r) => r.sessionId)).toEqual([ID]);
  });

  test("repositoryForCwd normalises trailing slashes and rejects siblings", () => {
    const id = (p: string) => p;
    const repos = [{ id: "r", localPath: "/w/demo-app" }];
    expect(repositoryForCwd("/w/demo-app/", repos, () => null)).toBe("r");
    expect(repositoryForCwd("/w/demo-app/src/x", repos, id)).toBe("r");
    expect(repositoryForCwd("/w/demo-app-two", repos, id)).toBeNull();
    expect(repositoryForCwd("/w/demo-app-two/src", repos, id)).toBeNull();
    expect(repositoryForCwd("/w", repos, id)).toBeNull();
  });

  test("a future timestamp does not push last_at past now", async () => {
    const future = new Date(nowMs + 2 * 3_600_000).toISOString();
    write(ID, [sessionLine("user", { cwd: repoPath, timestamp: future })], 40);
    await service().scan();
    expect(Date.parse(sessions()[0]?.lastAt as string)).toBeLessThanOrEqual(nowMs);
    expect(sessions()[0]?.lastAt).toBe(iso(40));
  });

  test("a file mtime in the future is capped at now", async () => {
    const p = write(ID, [sessionLine("user", { cwd: repoPath })], 0);
    const t = new Date(nowMs + 3 * 3_600_000);
    utimesSync(p, t, t);
    await service().scan();
    expect(sessions()[0]?.lastAt).toBe(NOW);
  });

  test("unregistering the repository removes its sessions and PRs", async () => {
    write(ID, baseLines(), 30);
    await service().scan();
    expect(sessions()).toHaveLength(1);
    expect(prs()).toHaveLength(1);
    db.delete(schema.repositories).where(eq(schema.repositories.id, repoId)).run();
    expect(sessions()).toHaveLength(0);
    expect(prs()).toHaveLength(0);
  });

  test("the time budget stops the scan after the first file", async () => {
    write(ID, baseLines(), 30);
    write(ID2, baseLines(), 30);
    let calls = 0;
    const svc = service({ monotonicMs: () => (calls++ < 2 ? 0 : SCAN_BUDGET_MS + 5_000) });
    const s = await svc.scan();
    expect(s.timedOut).toBe(true);
    expect(s.sessionsUpserted).toBe(1);
    expect(sessions()).toHaveLength(1);
  });

  test("an unreadable session file is skipped for this scan", async () => {
    write(ID, baseLines(), 30);
    write(ID2, baseLines(), 30);
    const failing: FsOps = {
      ...fs,
      readRange: (p, o, l) =>
        p.endsWith(`${ID}.jsonl`)
          ? Promise.reject(Object.assign(new Error("x"), { code: "EACCES" }))
          : fs.readRange(p, o, l),
    };
    const s = await service({ fs: failing }).scan();
    expect(s.sessionsUpserted).toBe(1);
    expect(sessions().map((r) => r.sessionId)).toEqual([ID2]);
  });
});

describe("activity", () => {
  test("active within the window, idle after", async () => {
    write(ID, [sessionLine("user", { cwd: repoPath, timestamp: iso(5) })], 5);
    const svc = service();
    await svc.scan();
    const a = svc.isUserActive(clock.now());
    expect(a.active).toBe(true);
    expect(a.until).toBe(new Date(nowMs - 5 * 60_000 + 10 * 60_000).toISOString());
    clock.advance(6 * 60_000); // last line is now 11 minutes old
    expect(svc.isUserActive(clock.now()).active).toBe(false);
    expect(svc.lastActiveAt()).toBe(iso(5));
  });

  test("no sessions means idle with no deadline; disabled means never active", async () => {
    const svc = service();
    expect(svc.isUserActive(clock.now())).toEqual({ active: false, until: null });
    write(ID, [sessionLine("user", { cwd: repoPath, timestamp: iso(1) })], 1);
    await svc.scan();
    settings.set("claudeActivity.enabled", false);
    expect(svc.isUserActive(clock.now()).active).toBe(false);
  });

  test("a transition publishes one event and one audit row; a repeat publishes nothing", async () => {
    write(ID, [sessionLine("user", { cwd: repoPath, timestamp: iso(5) })], 5);
    const svc = service();
    await svc.scan();
    await svc.scan();
    const ev = () =>
      db
        .select()
        .from(schema.domainEvents)
        .where(eq(schema.domainEvents.type, "claude_session.activity_changed"))
        .all();
    expect(ev()).toHaveLength(1);
    expect(ev()[0]?.payload).toEqual({ active: true, lastActiveAt: iso(5) });
    const audits = () =>
      db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.module, "claude-activity"))
        .all();
    expect(audits().map((a) => a.action)).toEqual(["claude_activity.active"]);
    expect(audits()[0]?.actor).toBe("system");
    expect(audits()[0]?.details).toEqual({ lastActiveAt: iso(5) });
    clock.advance(20 * 60_000);
    await svc.scan();
    expect(ev()).toHaveLength(2);
    expect(audits().map((a) => a.action)).toContain("claude_activity.idle");
    await svc.scan();
    expect(ev()).toHaveLength(2);
  });
});

describe("health", () => {
  test("lines read but none known degrades with the format message", async () => {
    write(
      ID,
      [
        sessionLine("mystery", { a: 1 }),
        sessionLine("other", { b: 2 }),
        sessionLine("unknown", { c: 3 }),
      ],
      30,
    );
    const svc = service();
    await svc.scan();
    expect(svc.healthState()).toEqual({
      state: "degraded",
      message: CLAUDE_ACTIVITY_FORMAT_MESSAGE,
    });
    const r = await claudeActivityCheck(svc)();
    expect(r).toEqual({ status: "degraded", detail: CLAUDE_ACTIVITY_FORMAT_MESSAGE });
  });

  test("a missing projects dir is ok", async () => {
    const svc = service({ projectsDir: join(projects, "does-not-exist") });
    await svc.scan();
    expect(svc.healthState()).toEqual({ state: "ok", message: null });
    expect(await claudeActivityCheck(svc)()).toEqual({ status: "ok" });
  });

  test("a projects dir that is a file is degraded with a fixed detail", async () => {
    const file = join(projects, "afile");
    writeFileSync(file, "x");
    const svc = service({ projectsDir: file });
    await svc.scan();
    expect(svc.healthState()).toEqual({ state: "degraded", message: "projects dir unreadable" });
    expect(await claudeActivityCheck(svc)()).toEqual({
      status: "degraded",
      detail: "projects dir unreadable",
    });
  });

  test("disabled: reads as ok/disabled and scan touches no path", async () => {
    settings.set("claudeActivity.enabled", false);
    const touched: string[] = [];
    const rec = (p: string) => {
      touched.push(p);
      throw new Error("touched");
    };
    const svc = service({
      fs: { readdir: rec, lstat: rec, realpath: rec, readRange: rec } as unknown as FsOps,
    });
    const s = await svc.scan();
    expect(s).toMatchObject({ files: 0, sessionsUpserted: 0, timedOut: false });
    expect(touched).toEqual([]);
    expect(svc.healthState()).toEqual({ state: "disabled", message: null });
    expect(await claudeActivityCheck(svc)()).toEqual({ status: "ok", detail: "disabled" });
  });

  test("a known line clears the format degradation", async () => {
    const path = write(ID, [sessionLine("mystery", { a: 1 })], 30);
    const svc = service();
    await svc.scan();
    expect(svc.healthState().state).toBe("degraded");
    appendFileSync(path, `${sessionLine("user", { cwd: repoPath, timestamp: iso(29) })}\n`);
    await svc.scan();
    expect(svc.healthState().state).toBe("ok");
  });
});

describe("privacy sentinel", () => {
  test("session content appears in no table, event, audit row or console call", async () => {
    const spies = (["log", "warn", "error"] as const).map((m) => spyOn(console, m));
    const lines = [
      sessionLine("last-prompt", { lastPrompt: SENTINEL }),
      sessionLine("user", {
        cwd: repoPath,
        timestamp: iso(5),
        message: { role: "user", content: SENTINEL },
      }),
      sessionLine("assistant", {
        timestamp: iso(4),
        message: { role: "assistant", content: [{ type: "text", text: SENTINEL }] },
      }),
    ];
    const path = write(ID, lines, 4);
    const svc = service();
    await svc.scan();
    appendFileSync(path, `${sessionLine("assistant", { timestamp: iso(3), message: SENTINEL })}\n`);
    await svc.scan();
    clock.advance(30 * 60_000);
    await svc.scan();
    expect(sessions()).toHaveLength(1);
    const sqlite = (db as unknown as { $client: import("bun:sqlite").Database }).$client;
    const tables = sqlite
      .query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all() as { name: string }[];
    const dump = JSON.stringify(tables.map((t) => sqlite.query(`select * from "${t.name}"`).all()));
    expect(dump).not.toContain(SENTINEL);
    expect(dump).toContain("claude_activity.idle");
    for (const s of spies) {
      expect(s.mock.calls).toEqual([]);
      s.mockRestore();
    }
  });
});
