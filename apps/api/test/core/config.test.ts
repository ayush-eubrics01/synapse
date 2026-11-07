import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NewDomainEvent } from "@synapse/contracts";
import { type DbOrTx, openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock, isoNow, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import {
  checkBackupDir,
  defaultRunScratchRoot,
  instanceRunRoot,
  loadConfig,
  REPO_ROOT,
  resolveHome,
} from "../../src/core/config/config";
import { SettingsService, USER_EDITABLE_SETTINGS } from "../../src/core/config/settings";

function setup() {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const publish = (tx: DbOrTx, e: NewDomainEvent<"settings.changed">): string => {
    const id = newId();
    tx.insert(schema.domainEvents)
      .values({
        id,
        type: e.type,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        correlationId: e.correlationId,
        payload: e.payload,
        occurredAt: isoNow(clock),
      })
      .run();
    return id;
  };
  return { db, settings: new SettingsService(db, clock, publish) };
}

const eventCount = (db: ReturnType<typeof setup>["db"]) =>
  db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, "settings.changed"))
    .all().length;

test("loadConfig defaults", () => {
  const c = loadConfig({ HOME: "/h" });
  expect(c.dbPath).toBe("/h/.local/share/synapse/synapse.db");
  expect(c.api).toEqual({ host: "127.0.0.1", port: 7400 });
  expect(c.web).toEqual({ host: "127.0.0.1", port: 7401 });
  expect(c.workerConcurrency).toBe(2);
  expect(c.claudeBinary).toBe("/h/.local/bin/claude");
  expect(c.credentialsPath).toBe("/h/.claude/.credentials.json");
});

test("loadConfig claude overrides", () => {
  const c = loadConfig({
    SYNAPSE_DB_PATH: "/d.db",
    SYNAPSE_CLAUDE_BIN: "/bin/c",
    SYNAPSE_CLAUDE_CREDENTIALS: "/cred.json",
  });
  expect(c.claudeBinary).toBe("/bin/c");
  expect(c.credentialsPath).toBe("/cred.json");
});

test("loadConfig honours XDG_DATA_HOME and overrides", () => {
  expect(loadConfig({ HOME: "/h", XDG_DATA_HOME: "/x" }).dbPath).toBe("/x/synapse/synapse.db");
  const c = loadConfig({
    SYNAPSE_DB_PATH: "/d.db",
    SYNAPSE_API_PORT: "9000",
    SYNAPSE_WEB_PORT: "9001",
  });
  expect(c.dbPath).toBe("/d.db");
  expect(c.api.port).toBe(9000);
  expect(c.web.port).toBe(9001);
});

test("defaultRunScratchRoot: an absolute XDG_CACHE_HOME, else <home>/.cache; never the data dir (Task 4b)", () => {
  expect(defaultRunScratchRoot({ HOME: "/h" })).toBe("/h/.cache/synapse");
  expect(defaultRunScratchRoot({ HOME: "/h", XDG_CACHE_HOME: "/c/" })).toBe("/c/synapse");
  // The XDG spec: a relative value is invalid and ignored.
  expect(defaultRunScratchRoot({ HOME: "/h", XDG_CACHE_HOME: "rel/cache" })).toBe(
    "/h/.cache/synapse",
  );
  expect(defaultRunScratchRoot({ HOME: "/h", XDG_CACHE_HOME: "" })).toBe("/h/.cache/synapse");
  expect(defaultRunScratchRoot({})).toBe(join(homedir(), ".cache", "synapse"));
  // XDG_DATA_HOME (the data dir, masked in the sandbox) plays no part.
  expect(defaultRunScratchRoot({ HOME: "/h", XDG_DATA_HOME: "/h/.cache" })).toBe(
    "/h/.cache/synapse",
  );
});

test("instanceRunRoot: <base>/<8 hex of sha256(realpath dataDir)>, distinct per data dir (Task 4b fix)", () => {
  const root = mkdtempSync(join(tmpdir(), "synapse-cfg-"));
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    symlinkSync(a, join(root, "a-link"));
    const ra = instanceRunRoot("/c/synapse", a);
    expect(ra).toMatch(/^\/c\/synapse\/[0-9a-f]{8}$/);
    expect(instanceRunRoot("/c/synapse", b)).not.toBe(ra);
    // The realpath decides: a symlink to the same data dir is the same instance.
    expect(instanceRunRoot("/c/synapse", join(root, "a-link"))).toBe(ra);
    expect(instanceRunRoot("/c/synapse", `${a}/`)).toBe(ra);
    // A missing data dir still hashes (its resolved path).
    expect(instanceRunRoot("/c/synapse", join(root, "missing"))).toMatch(/\/[0-9a-f]{8}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects non-loopback host", () => {
  expect(() => loadConfig({ HOME: "/h", SYNAPSE_API_HOST: "0.0.0.0" })).toThrow(/loopback/);
});

test("settings default on empty db", () => {
  const { settings } = setup();
  expect(settings.get("jobs.maxAttempts")).toBe(3);
  expect(settings.get("autoReply.awayMode")).toBe(false);
  expect(settings.get("system.lastHeartbeatAt")).toBeNull();
});

test("people memory settings have the Phase 5 defaults", () => {
  const { settings } = setup();
  expect(settings.get("people.update.intervalSeconds")).toBe(86400);
  expect(settings.get("people.temporaryContact.ttlDays")).toBe(30);
  expect(settings.get("people.recommendation.minConfidence")).toBe("medium");
  expect(settings.get("people.models.initial")).toBe("sonnet");
  expect(settings.get("people.models.update")).toBe("haiku");
  expect(settings.get("people.history.days")).toBe(90);
  expect(settings.get("people.history.maxMessages")).toBe(150);
  expect(settings.get("people.unknown.minMessages")).toBe(3);
});

test("phase 6 settings defaults and bounds", () => {
  const { settings } = setup();
  expect(settings.get("commitments.extract.debounceMinutes")).toBe(30);
  expect(settings.get("commitments.extract.batchMax")).toBe(40);
  expect(settings.get("commitments.stall.waitHours")).toBe(24);
  expect(settings.get("commitments.spec.maxAgeHours")).toBe(24);
  expect(settings.get("commitments.spec.maxPerSenderPerDay")).toBe(5);
  expect(settings.get("commitments.spec.maxPerDay")).toBe(30);
  expect(() => settings.set("commitments.spec.maxPerDay", 0)).toThrow();
  expect(() => settings.set("commitments.spec.maxAgeHours", 169)).toThrow();
  expect(() => settings.set("commitments.spec.maxAgeHours", 0)).toThrow();
  expect(settings.get("commitments.reminder.dueSoonHours")).toBe(24);
  expect(settings.get("commitments.requireReviewForDetected")).toBe(true);
  expect(settings.get("commitments.models.extract")).toBe("haiku");
  expect(settings.get("commitments.models.draft")).toBe("haiku");
  expect(settings.get("outgoing.verify.delaySeconds")).toBe(120);
  expect(settings.get("outgoing.verify.maxAttempts")).toBe(5);
  expect(() => settings.set("commitments.extract.batchMax", 41)).toThrow();
  settings.set("commitments.extract.batchMax", 40);
});

test("autoReply limits can only be tightened (ADR-033)", () => {
  const { settings } = setup();
  expect(() => settings.set("autoReply.minConfidence", 0.5)).toThrow();
  expect(() => settings.set("autoReply.maxPerPersonPerDay", 4)).toThrow();
  settings.set("autoReply.maxPerPersonPerDay", 0);
  expect(settings.get("autoReply.maxPerPersonPerDay")).toBe(0);
});

test("set then get round-trips and emits one settings.changed", () => {
  const { db, settings } = setup();
  settings.set("jobs.maxAttempts", 5);
  expect(settings.get("jobs.maxAttempts")).toBe(5);
  settings.set("jobs.maxAttempts", 6);
  expect(settings.get("jobs.maxAttempts")).toBe(6);
  expect(eventCount(db)).toBe(2);
  const row = db.select().from(schema.domainEvents).all()[0];
  expect(row?.payload).toEqual({ key: "jobs.maxAttempts" });
});

test("emit:false writes without an event", () => {
  const { db, settings } = setup();
  settings.set("system.lastHeartbeatAt", "2026-01-01T00:00:00.000Z", { emit: false });
  expect(settings.get("system.lastHeartbeatAt")).toBe("2026-01-01T00:00:00.000Z");
  expect(eventCount(db)).toBe(0);
});

test("invalid value throws and writes nothing", () => {
  const { db, settings } = setup();
  expect(() => settings.set("jobs.maxAttempts", -1)).toThrow();
  expect(settings.get("jobs.maxAttempts")).toBe(3);
  expect(eventCount(db)).toBe(0);
});

test("resolveHome: HOME, else os.homedir(); loadConfig and the container share it", () => {
  expect(resolveHome({ HOME: "/h" })).toBe("/h");
  expect(resolveHome({})).toBe(homedir());
  expect(resolveHome({ HOME: "" })).toBe(homedir());
  expect(loadConfig({ XDG_DATA_HOME: "/x" }).claudeBinary).toBe(`${homedir()}/.local/bin/claude`);
});

test("knownServers entries must match the R31 server-name rule", () => {
  const { settings } = setup();
  for (const bad of ["mcp__", "mcp_____", "Slack", "mcp__a,b", "mcp__a__b(", "mcp__a b"]) {
    expect(() =>
      settings.set("orchestrator.knownServers", ["mcp__claude_ai_Slack", bad]),
    ).toThrow();
  }
  expect(settings.get("orchestrator.knownServers")).toContain("mcp__claude_ai_Gmail");
  settings.set("orchestrator.knownServers", ["mcp__claude_ai_Slack", "mcp__a_1"]);
  expect(settings.get("orchestrator.knownServers")).toEqual(["mcp__claude_ai_Slack", "mcp__a_1"]);
});

test("slack.selfUserId validates the Slack user id shape", () => {
  const { settings } = setup();
  expect(settings.get("slack.selfUserId")).toBeNull();
  expect(() => settings.set("slack.selfUserId", "bob")).toThrow();
  settings.set("slack.selfUserId", "U012ABCDEF");
  expect(settings.get("slack.selfUserId")).toBe("U012ABCDEF");
});

test("urgency settings have the documented defaults", () => {
  const { settings } = setup();
  expect(settings.get("urgency.assess.batchWindowSeconds")).toBe(120);
  expect(settings.get("urgency.assess.batchMax")).toBe(10);
  expect(settings.get("urgency.notify.levels")).toEqual(["critical", "high"]);
  expect(settings.get("urgency.model")).toBe("haiku");
  expect(settings.get("urgency.suggest.model")).toBe("haiku");
  expect(settings.get("urgency.maxAgeHours")).toBe(24);
  expect(settings.get("urgency.candidateThreshold")).toBe(2);
  expect(settings.get("security.flags.notifyOnSeverity")).toBe("high");
  expect(settings.get("security.flags.widgetMinSeverity")).toBe("warning");
  expect(settings.get("security.flags.excerptMaxChars")).toBe(300);
  const kw = settings.get("urgency.rules.keywords");
  expect(kw.map((k) => k.id)).toEqual([
    "incident",
    "blocker",
    "urgent",
    "deadline",
    "today",
    "question",
  ]);
  expect(() => settings.set("urgency.rules.keywords", [{ id: "x" } as never])).toThrow();
});

test("urgency.assess.batchMax is capped at 10 so the prompt byte budget always holds", () => {
  const { settings } = setup();
  expect(() => settings.set("urgency.assess.batchMax", 11)).toThrow();
  settings.set("urgency.assess.batchMax", 5);
  expect(settings.get("urgency.assess.batchMax")).toBe(5);
});

test("auto-reply settings have the Phase 6b defaults", () => {
  const { settings } = setup();
  expect(settings.get("autoReply.allowedKinds")).toEqual([
    "code_answer",
    "stalled_reminder",
    "followup_question",
    "acknowledgement",
  ]);
  expect(settings.get("autoReply.maxPerPersonPerDay")).toBe(3);
  expect(settings.get("autoReply.minMinutesBetweenInThread")).toBe(30);
  expect(settings.get("autoReply.minConfidence")).toBe(0.75);
  expect(settings.get("autoReply.maxSendDelayMinutes")).toBe(15);
  expect(() => settings.set("autoReply.allowedKinds", ["bogus"] as never)).toThrow();
  expect(() => settings.set("autoReply.minConfidence", 2)).toThrow();
});

test("jira settings defaults", () => {
  const { settings } = setup();
  expect(settings.get("jira.enabled")).toBe(false);
  expect(settings.get("jira.cloudId")).toBeNull();
  expect(settings.get("jira.scope.jql")).toBe("assignee = currentUser() AND updated >= -60d");
  expect(settings.get("jira.excludedProjects")).toEqual([]);
  expect(settings.get("jira.sync.intervalMinutes")).toBe(30);
  expect(settings.get("jira.reconcile.hours")).toBe(24);
  expect(settings.get("jira.windowDays")).toBe(60);
  expect(settings.get("jira.stale.days")).toBe(5);
  expect(settings.get("jira.dueSoon.days")).toBe(2);
  expect(settings.get("jira.blockedStatuses")).toEqual([]);
  expect(settings.get("jira.pageSize")).toBe(20);
  expect(settings.get("jira.maxPagesPerRun")).toBe(6);
  expect(settings.get("jira.maxPagesPerChain")).toBe(50);
  expect(() => settings.set("jira.pageSize", 31)).toThrow();
});

test("jira settings validation", () => {
  const { settings } = setup();
  expect(() => settings.set("jira.excludedProjects", ["bad key"])).toThrow();
  expect(() => settings.set("jira.scope.jql", "a\nb")).toThrow();
  expect(() => settings.set("jira.scope.jql", "x".repeat(501))).toThrow();
  expect(() => settings.set("jira.cloudId", "not a uuid!")).toThrow();
  settings.set("jira.excludedProjects", ["SKIP"]);
  settings.set("jira.cloudId", "00000000-0000-4000-8000-000000000000");
  expect(settings.get("jira.excludedProjects")).toEqual(["SKIP"]);
});

test("brain settings defaults and validation", () => {
  const { settings } = setup();
  expect(settings.get("brain.inspect.model")).toBe("sonnet");
  expect(settings.get("brain.inspect.maxTurns")).toBe(30);
  expect(settings.get("brain.inspect.timeoutMinutes")).toBe(10);
  expect(settings.get("brain.upcoming.days")).toBe(30);
  expect(() => settings.set("brain.inspect.model", "gpt" as never)).toThrow();
});

test("engineering settings defaults and bounds", () => {
  const { settings } = setup();
  expect(settings.get("engineering.model")).toBe("sonnet");
  expect(settings.get("engineering.investigate.maxTurns")).toBe(30);
  // Default and max equal the request schema's cap (claudeJobRequestSchema maxTurns ≤ 50).
  expect(settings.get("engineering.develop.maxTurns")).toBe(50);
  expect(() => settings.set("engineering.develop.maxTurns", 51)).toThrow();
  expect(settings.get("engineering.develop.timeoutMinutes")).toBe(30);
  expect(settings.get("engineering.lock.ttlMinutes")).toBe(10);
  expect(() => settings.set("engineering.model", "gpt" as never)).toThrow();
  expect(() => settings.set("engineering.lock.ttlMinutes", 0)).toThrow();
});

test("phase 10b settings: defaults and bounds", () => {
  const { settings } = setup();
  expect(settings.get("claudeActivity.enabled")).toBe(true);
  expect(settings.get("claudeActivity.projectsDir")).toBeNull();
  expect(settings.get("claudeActivity.scanIntervalSeconds")).toBe(120);
  expect(settings.get("claudeActivity.activeWindowMinutes")).toBe(10);
  expect(settings.get("claudeActivity.yieldWhenActive")).toBe(true);
  expect(settings.get("claudeActivity.yieldEngineering")).toBe(false);
  expect(settings.get("claudeActivity.staleBranchDays")).toBe(3);
  expect(settings.get("claudeActivity.openPrReminderDays")).toBe(3);
  expect(settings.get("claudeActivity.lastActiveState")).toBe(false);
  expect(settings.get("claudeActivity.reminders.lastRunDate")).toBeNull();
  expect(settings.get("codeAnswer.model")).toBe("sonnet");
  expect(settings.get("codeAnswer.maxTurns")).toBe(16);
  expect(settings.get("codeAnswer.timeoutMinutes")).toBe(5);
  expect(settings.get("codeAnswer.away.enabled")).toBe(true);
  expect(settings.get("codeAnswer.away.autoSend")).toBe(false);
  expect(settings.get("codeAnswer.away.maxRunsPerDay")).toBe(10);
  expect(() => settings.set("codeAnswer.maxTurns", 31)).toThrow();
  expect(() => settings.set("claudeActivity.projectsDir", "relative/dir")).toThrow();
  expect(USER_EDITABLE_SETTINGS).not.toContain("claudeActivity.projectsDir");
  expect(USER_EDITABLE_SETTINGS).not.toContain("claudeActivity.scanIntervalSeconds");
  expect(USER_EDITABLE_SETTINGS).toContain("codeAnswer.away.autoSend");
});

test("phase 11 ops settings have the R7 defaults and bounds", () => {
  const { settings } = setup();
  expect(settings.get("ops.backup.enabled")).toBe(true);
  expect(settings.get("ops.backup.hour")).toBe(3);
  expect(settings.get("ops.backup.keep")).toBe(7);
  expect(settings.get("ops.disk.warnFreeGiB")).toBe(5);
  expect(settings.get("retention.jobsDays")).toBe(30);
  expect(settings.get("retention.notificationsDays")).toBe(30);
  expect(settings.get("retention.claudeRunsDays")).toBe(90);
  expect(settings.get("retention.auditDays")).toBe(365);
  expect(settings.get("ops.backup.dir")).toBeNull();
  expect(settings.get("ops.backup.lastRunDate")).toBeNull();
  expect(settings.get("ops.retention.lastRun")).toBeNull();
  expect(() => settings.set("ops.backup.hour", 24)).toThrow();
  expect(() => settings.set("ops.backup.keep", 0)).toThrow();
  expect(() => settings.set("retention.auditDays", 89)).toThrow();
  expect(() => settings.set("retention.jobsDays", 6)).toThrow();
  expect(() => settings.set("retention.claudeRunsDays", 13)).toThrow();
  expect(() => settings.set("ops.disk.warnFreeGiB", 101)).toThrow();
  expect(() => settings.set("ops.backup.dir", "rel")).toThrow();
});

test("SYNAPSE_BACKUP_DIR is validated", () => {
  expect(loadConfig({ HOME: "/h" }).backupDir).toBeNull();
  expect(() => loadConfig({ HOME: "/h", SYNAPSE_BACKUP_DIR: "rel/dir" })).toThrow(
    "SYNAPSE_BACKUP_DIR must be an absolute path outside the repository",
  );
  expect(() => loadConfig({ HOME: "/h", SYNAPSE_BACKUP_DIR: `${REPO_ROOT}/backups` })).toThrow(
    /outside the repository/,
  );
  expect(() => loadConfig({ HOME: "/h", SYNAPSE_BACKUP_DIR: REPO_ROOT })).toThrow(
    /outside the repository/,
  );
  const dir = mkdtempSync(join(tmpdir(), "syn-"));
  expect(loadConfig({ HOME: "/h", SYNAPSE_BACKUP_DIR: dir }).backupDir).toBe(dir);
  expect(checkBackupDir(dir)).toBe("ok");
  expect(checkBackupDir("rel")).toBe("not_absolute");
  expect(checkBackupDir(`${dir}/sub`, dir)).toBe("inside_repo");
  expect(checkBackupDir(`${dir}-other`, dir)).toBe("ok");
});

test("checkBackupDir: dotted names and symlinks into the repo", () => {
  const repo = mkdtempSync(join(tmpdir(), "syn-"));
  mkdirSync(join(repo, "..foo"));
  expect(checkBackupDir(join(repo, "..foo"), repo)).toBe("inside_repo");
  const other = mkdtempSync(join(tmpdir(), "syn-"));
  symlinkSync(repo, join(other, "link"));
  expect(checkBackupDir(join(other, "link", "not-yet", "b"), repo)).toBe("inside_repo");
  expect(checkBackupDir(join(other, "fresh", "b"), repo)).toBe("ok");
});

test("H4.4: a relative SYNAPSE_DB_PATH is resolved against the cwd", () => {
  expect(loadConfig({ HOME: "/home/u", SYNAPSE_DB_PATH: "data/t.db" }).dbPath).toBe(
    resolve(process.cwd(), "data/t.db"),
  );
  expect(loadConfig({ HOME: "/home/u", SYNAPSE_DB_PATH: ":memory:" }).dbPath).toBe(":memory:");
  expect(loadConfig({ HOME: "/home/u", SYNAPSE_DB_PATH: "/home/u/x.db" }).dbPath).toBe(
    "/home/u/x.db",
  );
});
