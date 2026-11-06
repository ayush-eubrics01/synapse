import { expect, test } from "bun:test";
import type { BackupEntry, RuntimeView } from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { RuntimePanel } from "../app/components/system/RuntimePanel";
import type { SettingsDto } from "../lib/api";
import { ApiError } from "../lib/api";
import { backupStartMessage } from "../lib/backup";
import { formatBytes } from "../lib/format";

const NOW = new Date("2026-11-07T12:00:00Z");
const GIB = 2 ** 30;
const runtime = (o: Partial<RuntimeView> = {}): RuntimeView => ({
  startedAt: "2026-11-07T09:00:00.000Z",
  uptimeSeconds: 3 * 3600 + 120,
  version: "0.0.0+abc1234",
  memoryRssBytes: 150 * 2 ** 20,
  dbBytes: 5 * 2 ** 20,
  walBytes: 1536,
  dataDirFreeBytes: 42 * GIB,
  lastBackup: { name: "synapse-20261107-030000.db", createdAt: "2026-11-07T03:00:00.000Z" },
  backupCount: 1,
  lastBackupAttempt: { ok: true, at: "2026-11-07T03:00:00.000Z", code: null },
  queue: { pending: 4, running: 1, retry: 2, needsAttention: 3, oldestPendingAgeSeconds: 300 },
  retention: {
    at: "2026-11-07T03:05:00.000Z",
    date: "2026-11-07",
    jobs: 11,
    notifications: 22,
    events: 33,
    audit: 44,
    claudeRunsCompacted: 55,
    quickCheck: "ok",
  },
  ...o,
});
const backups: BackupEntry[] = [
  { name: "synapse-20261107-030000.db", bytes: 5 * 2 ** 30, createdAt: "2026-11-07T03:00:00.000Z" },
];
const settings = {
  "ops.backup.enabled": true,
  "ops.backup.hour": 3,
  "ops.backup.keep": 7,
  "ops.disk.warnFreeGiB": 5,
  "retention.jobsDays": 30,
  "retention.notificationsDays": 30,
  "retention.claudeRunsDays": 90,
  "retention.auditDays": 365,
} as unknown as SettingsDto;
const render = (o: Partial<Parameters<typeof RuntimePanel>[0]> = {}) =>
  renderToString(
    <RuntimePanel
      runtime={runtime()}
      backups={backups}
      settings={settings}
      now={NOW}
      onBackupNow={() => {}}
      backupPending={false}
      onSetting={() => {}}
      {...o}
    />,
  );

test("shows the runtime values, backups and retention counts", () => {
  const html = render();
  for (const s of [
    "Runtime",
    "Back up now",
    "synapse-20261107-030000.db",
    "5.0 GiB",
    "1.5 KiB",
    "0.0.0+abc1234",
    "Retention",
    "55",
  ])
    expect(html).toContain(s);
  expect(html).not.toContain("No backups yet");
  expect(html).not.toContain("Retention has not run yet");
});

test("backupPending disables the button", () => {
  expect(render({ backupPending: true })).toMatch(/<button[^>]*disabled[^>]*>Back up now/);
  expect(render()).not.toMatch(/<button[^>]*disabled[^>]*>Back up now/);
});

test("empty states", () => {
  const html = render({
    backups: [],
    runtime: runtime({ retention: null, lastBackup: null, backupCount: 0, version: null }),
  });
  expect(html).toContain("No backups yet");
  expect(html).toContain("Retention has not run yet");
  expect(html).toContain("unknown");
});

test("R7 inputs carry the spec bounds", () => {
  const html = render();
  expect(html).toMatch(/<input[^>]*id="syn-set-ops\.backup\.keep"[^>]*/);
  const tag = html.match(/<input[^>]*id="syn-set-ops\.backup\.keep"[^>]*>/)?.[0] ?? "";
  expect(tag).toContain('min="1"');
  expect(tag).toContain('max="60"');
  const hour = html.match(/<input[^>]*id="syn-set-ops\.backup\.hour"[^>]*>/)?.[0] ?? "";
  expect(hour).toContain('min="0"');
  expect(hour).toContain('max="23"');
  expect(html).toContain('role="switch"');
});

test("formatBytes", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KiB");
  expect(formatBytes(5 * GIB)).toBe("5.0 GiB");
});

test("a failed last backup attempt shows its fixed code; a successful one shows nothing", () => {
  const failed = render({
    runtime: runtime({
      lastBackupAttempt: { ok: false, at: "2026-11-07T03:00:00.000Z", code: "insufficient_space" },
    }),
  });
  expect(failed).toContain("The last backup failed (insufficient_space)");
  expect(render()).not.toContain("The last backup failed");
});

test("backup start messages: 409 is already running, anything else is a generic failure", () => {
  expect(backupStartMessage(new ApiError("x", 409, "already_running"))).toBe(
    "A backup is already running",
  );
  expect(backupStartMessage(new ApiError("x", 500))).toBe("Couldn't start the backup");
  expect(backupStartMessage(new TypeError("network"))).toBe("Couldn't start the backup");
});
