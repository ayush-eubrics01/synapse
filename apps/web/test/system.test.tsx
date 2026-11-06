import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardOverview, Job } from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { QuotaBars } from "../app/components/system/QuotaBars";
import { Running } from "../app/components/system/Running";
import { SystemDetails } from "../app/components/system/SystemDetails";
import type { ClaudeRun, ClaudeStatus, SlackStatusDto } from "../lib/api";

const NOW = new Date("2026-11-06T12:00:00Z");

const pipeline: DashboardOverview["pipeline"] = [
  {
    id: "collect",
    label: "Collect",
    what: "Slack via Claude",
    state: "ok",
    summary: "synced 2 min ago",
  },
  { id: "screen", label: "Screen", what: "cheap rules", state: "ok", summary: "12 screened" },
  { id: "assess", label: "Assess", what: "Claude haiku", state: "waiting", summary: "3 waiting" },
  { id: "surface", label: "Surface", what: "Needs you", state: "idle", summary: "nothing yet" },
];

const status = (o: Partial<ClaudeStatus> = {}): ClaudeStatus => ({
  quota: {
    level: "ok",
    window: null,
    resetsAt: null,
    fiveHour: { utilization: 0.31, status: "allowed" },
    sevenDay: { utilization: 0.52, status: "allowed" },
  },
  thresholds: {
    fiveHour: { soft: 0.6, hard: 0.8, stop: 0.95 },
    sevenDay: { soft: 0.7, hard: 0.9 },
  },
  auth: { refreshExpiresAt: "2026-11-20T15:00:00Z", slides: true },
  ...o,
});

const run = (o: Partial<ClaudeRun> = {}): ClaudeRun => ({
  id: "r1",
  jobId: null,
  workerProfile: "collector",
  model: "haiku",
  status: "succeeded",
  numTurns: 3,
  durationMs: 11_400,
  tokens: { input: null, output: null, cacheRead: null, cacheCreation: null },
  costUsdEquivalent: null,
  permissionDenialCount: 0,
  errorKind: null,
  startedAt: "2026-11-06T11:50:00Z",
  finishedAt: "2026-11-06T11:50:11Z",
  ...o,
});

const renderRunning = (s: ClaudeStatus | null, runs: ClaudeRun[], p = pipeline) =>
  renderToString(<Running pipeline={p} status={s} runs={runs} now={NOW} />);

test("Running shows four stages with data-state, the explainer and the Claude login", () => {
  const html = renderRunning(status(), [run()]);
  for (const s of ["Collect", "Screen", "Assess", "Surface"]) expect(html).toContain(s);
  expect(html).toContain('data-state="ok"');
  expect(html).toContain('data-state="waiting"');
  expect(html).toContain('data-state="idle"');
  expect(html).toContain(
    "Messages are collected every 10 minutes, screened with cheap rules, and only likely-urgent ones go to Claude.",
  );
  expect(html).toContain("14d 3h left");
  expect(html).toContain("Succeeded · 11.4s");
  expect(html).toContain("collector · haiku");
  expect(html).toContain("None running");
  expect(html).toContain("lock free");
  expect(html).toContain("ok · jobs allowed");
});

test("Running shows unknown login and no runs when there is no data", () => {
  const html = renderRunning(status({ auth: { refreshExpiresAt: null, slides: null } }), []);
  expect(html).toContain("unknown");
  expect(html).toContain("No Claude runs yet.");
});

test("QuotaBars show both windows with a marker at the soft threshold", () => {
  const html = renderToString(<QuotaBars status={status()} />);
  expect(html).toContain("Five-hour window");
  expect(html).toContain("31%");
  expect(html).toContain("Seven-day window");
  expect(html).toContain("52%");
  expect(html).toContain('title="Non-urgent jobs pause above this"');
  expect(html).toContain("left:60%");
  expect(html).toContain("left:70%");
  expect(html).toContain(
    "Marker = pause threshold for non-urgent jobs, keeping headroom for your own Claude Code work.",
  );
});

test("QuotaBars without a reading say so, and a soft level is explained", () => {
  expect(renderToString(<QuotaBars status={status({ quota: null })} />)).toContain(
    "No quota reading yet.",
  );
  const soft = status();
  soft.quota = { ...(soft.quota as NonNullable<ClaudeStatus["quota"]>), level: "soft" };
  expect(renderToString(<QuotaBars status={soft} />)).toContain("soft · non-urgent jobs paused");
});

const job = (o: Partial<Job> = {}): Job => ({
  id: "j1",
  type: "slack.collect_incremental",
  priority: 0,
  status: "COMPLETED",
  input: null,
  attempts: 1,
  maxAttempts: 3,
  idempotencyKey: "k",
  concurrencyGroup: null,
  externalWrite: false,
  runAfter: "2026-11-06T11:00:00Z",
  leaseOwner: null,
  leaseExpiresAt: null,
  lastError: null,
  createdAt: "2026-11-06T11:55:00Z",
  startedAt: null,
  finishedAt: null,
  ...o,
});

const sync = {
  stream: "slack.messages",
  checkpoint: null,
  upperBound: null,
  status: "idle" as const,
  pagesDone: 0,
  lastSuccessAt: null,
  lastError: null,
  nextRunAfter: null,
};
const slackStatus = (
  o: Partial<SlackStatusDto["incremental"]> = {},
  b: Partial<SlackStatusDto["backfill"]> = {},
): SlackStatusDto => ({
  incremental: { ...sync, ...o },
  backfill: { ...sync, stream: "slack.backfill", resumable: false, ...b },
  searchesToday: 3,
});

const renderSystem = (jobs: Job[], slack: SlackStatusDto | null, runs: ClaudeRun[] = []) =>
  renderToString(
    <SystemDetails jobs={jobs} slack={slack} runs={runs} onSkip={() => {}} now={NOW} />,
  );

test("SystemDetails job rows show label, type, chip and attempts", () => {
  const html = renderSystem(
    [
      job(),
      job({ id: "j2", status: "PENDING", type: "urgency.assess", attempts: 0 }),
      job({ id: "j3", status: "FAILED", type: "mystery.job" }),
      job({ id: "j4", status: "NEEDS_ATTENTION" }),
    ],
    null,
  );
  expect(html).toContain("Background jobs");
  expect(html).toContain("retries up to 3×");
  expect(html).toContain("Collect new Slack messages");
  expect(html).toContain("slack.collect_incremental");
  expect(html).toContain("DONE");
  expect(html).toContain("PENDING");
  expect(html).toContain("FAILED");
  expect(html).toContain("NEEDS_ATTENTION");
  expect(html).toContain("1/3 · 5 min ago");
  expect(html).toContain("mystery.job");
  expect(renderSystem([], null)).toContain("No jobs yet.");
});

test("SystemDetails Slack rows cover the backfill states and checkpoint", () => {
  expect(renderSystem([], null)).toContain("No Slack status yet.");
  const html = renderSystem(
    [],
    slackStatus({ lastSuccessAt: "2026-11-06T11:58:00Z", checkpoint: "1730000000.0001" }),
  );
  for (const l of ["Last sync", "Searches today", "90-day backfill", "Checkpoint"])
    expect(html).toContain(l);
  expect(html).toContain("2 min ago");
  expect(html).toContain("1730000000.0001");
  expect(html).toContain("not started");
  expect(renderSystem([], slackStatus({}, { status: "running", pagesDone: 4 }))).toContain(
    "running · 4 pages",
  );
  expect(renderSystem([], slackStatus({}, { status: "complete" }))).toContain("done");
  expect(
    renderSystem([], slackStatus({}, { status: "error", lastError: { kind: "x", message: "m" } })),
  ).toContain("failed");
});

test("SystemDetails offers Skip unreadable page only for a stalled parse, and no backfill button", () => {
  const stalled = renderSystem(
    [],
    slackStatus({ status: "error", lastError: { kind: "parse_failed", message: "m" } }),
  );
  expect(stalled).toContain("Skip unreadable page");
  const fine = renderSystem([], slackStatus());
  expect(fine).not.toContain("Skip unreadable page");
  expect(fine).not.toContain("<button");
});

test("SystemDetails keeps the Claude runs table", () => {
  const html = renderSystem([], null, [run(), run({ id: "r2", durationMs: null, model: null })]);
  expect(html).toContain("Claude runs");
  expect(html).toContain("11.4s");
  expect(renderSystem([], null, [])).toContain("No Claude runs yet.");
});

test("system.css: only kv rows after the first get a divider (adjacent sibling, not first-of-type)", () => {
  const css = readFileSync(join(import.meta.dir, "../app/styles/system.css"), "utf8");
  expect(css).not.toContain(".syn-kv:first-of-type");
  expect(css).toMatch(/\.syn-kv \+ \.syn-kv\s*\{[^}]*border-top: 1px solid var\(--line2\)/);
});

test("Running with no pipeline yet says it is waiting for the API instead of an empty track", () => {
  const html = renderToString(<Running pipeline={[]} status={null} runs={[]} now={NOW} />);
  expect(html).not.toContain('class="syn-stages"');
  expect(html).toContain("Waiting for the API.");
});
