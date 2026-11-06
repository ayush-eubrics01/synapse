import { expect, test } from "bun:test";
import type { ClaudeActivityView, DashboardOverview } from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { ClaudeCodeCard } from "../app/components/system/ClaudeCodeCard";
import { ClaudeSettings } from "../app/components/system/ClaudeSettings";
import { Running } from "../app/components/system/Running";
import type { ClaudeSettingsDto } from "../lib/api";
import { activityHeadline } from "../lib/claude-activity";
import { jobLabel } from "../lib/job-labels";

const NOW = new Date("2026-11-06T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const view = (o: Partial<ClaudeActivityView> = {}): ClaudeActivityView => ({
  enabled: true,
  active: true,
  lastActiveAt: ago(2),
  yielding: true,
  health: { state: "ok", message: null },
  repositories: [
    {
      repositoryId: "r1",
      name: "demo-app",
      sessions: [
        {
          sessionId: "00000000-0000-4000-8000-000000000001",
          title: "Demo title",
          branch: "feature-x",
          firstAt: ago(50),
          lastAt: ago(2),
          activeNow: true,
          entrypoint: "cli",
        },
        {
          sessionId: "00000000-0000-4000-8000-000000000002",
          title: null,
          branch: null,
          firstAt: ago(500),
          lastAt: ago(180),
          activeNow: false,
          entrypoint: null,
        },
      ],
      prs: [
        {
          url: "https://github.com/demo-org/demo-app/pull/7",
          number: 7,
          repository: "demo-org/demo-app",
          branch: "feature-x",
          firstSeenAt: ago(30),
          engineeringTaskId: "t1",
        },
        {
          url: "https://github.com/demo-org/demo-app/pull/8",
          number: 8,
          repository: "demo-org/demo-app",
          branch: null,
          firstSeenAt: ago(40),
        },
      ],
    },
  ],
  ...o,
});

test("headline: yielding, active, idle", () => {
  expect(activityHeadline(view())).toBe("You're active in Claude Code: background analysis paused");
  expect(activityHeadline(view({ yielding: false }))).toBe("You're active in Claude Code");
  expect(activityHeadline(view({ active: false, yielding: false }))).toBe("Idle");
  expect(activityHeadline(null)).toBe("Idle");
});

test("card shows the headline, per-repo title, branch, relative time and the active dot", () => {
  const html = renderToString(<ClaudeCodeCard activity={view()} now={NOW} />);
  expect(html).toContain("You&#x27;re active in Claude Code: background analysis paused");
  expect(html).toContain("demo-app");
  expect(html).toContain("Demo title");
  expect(html).toContain("feature-x");
  expect(html).toContain("2 min ago");
  expect(html).toContain("3 h ago");
  expect(html).toContain('data-active="true"');
  expect(html).toContain("Untitled session");
});

test("a PR with a linked task carries a badge; one without does not", () => {
  const html = renderToString(<ClaudeCodeCard activity={view()} now={NOW} />);
  expect(html).toContain("PR #7");
  expect(html).toContain("PR #8");
  expect(html.match(/linked task/g)).toHaveLength(1);
});

test("idle state", () => {
  const html = renderToString(
    <ClaudeCodeCard
      activity={view({ active: false, yielding: false, repositories: [] })}
      now={NOW}
    />,
  );
  expect(html).toContain("Idle");
  expect(html).not.toContain("background analysis paused");
});

test("a degraded health message is shown", () => {
  const html = renderToString(
    <ClaudeCodeCard
      activity={view({
        health: {
          state: "degraded",
          message: "Claude Code session format not recognised; observation paused",
        },
      })}
      now={NOW}
    />,
  );
  expect(html).toContain("Claude Code session format not recognised; observation paused");
});

test("a session title with markup renders as escaped plain text", () => {
  const v = view();
  const s = v.repositories[0]?.sessions[0];
  if (s) {
    s.title = "<b>x</b>";
    s.branch = "<i>y</i>";
  }
  const html = renderToString(<ClaudeCodeCard activity={v} now={NOW} />);
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html).toContain("&lt;i&gt;y&lt;/i&gt;");
  expect(html).not.toContain("<b>x</b>");
  expect(html).not.toContain("<i>y</i>");
});

const overviewPipeline: DashboardOverview["pipeline"] = [
  { id: "collect", label: "Collect", what: "Slack via Claude", state: "ok", summary: "synced" },
];

test("Running shows 'paused while you work' only while yielding", () => {
  const props = { pipeline: overviewPipeline, status: null, runs: [], now: NOW };
  const on = renderToString(
    <Running {...props} claudeActivity={{ active: true, sessionsToday: 2, yielding: true }} />,
  );
  expect(on).toContain("paused while you work");
  const off = renderToString(
    <Running {...props} claudeActivity={{ active: true, sessionsToday: 2, yielding: false }} />,
  );
  expect(off).not.toContain("paused while you work");
  expect(renderToString(<Running {...props} />)).not.toContain("paused while you work");
});

const settings: ClaudeSettingsDto = {
  "claudeActivity.enabled": true,
  "claudeActivity.activeWindowMinutes": 10,
  "claudeActivity.yieldWhenActive": true,
  "claudeActivity.yieldEngineering": false,
  "claudeActivity.staleBranchDays": 3,
  "claudeActivity.openPrReminderDays": 3,
  "codeAnswer.model": "sonnet",
  "codeAnswer.maxTurns": 16,
  "codeAnswer.timeoutMinutes": 5,
  "codeAnswer.away.enabled": true,
  "codeAnswer.away.autoSend": false,
  "codeAnswer.away.maxRunsPerDay": 10,
};

test("settings render the auto-send switch with the residual-risk sentence", () => {
  const html = renderToString(<ClaudeSettings values={settings} onChange={() => {}} />);
  expect(html).toContain("Auto-send code answers while away");
  expect(html).toContain(
    "Residual risk: with auto-send on, a repository secret that does not match a secret pattern could be sent to a priority person.",
  );
  expect(html).toContain('aria-checked="false"');
});

test("settings show a fallback while unavailable", () => {
  expect(renderToString(<ClaudeSettings values={null} onChange={() => {}} />)).toContain(
    "Settings unavailable.",
  );
});

test("job labels cover the Phase 10b job types", () => {
  expect(jobLabel("claude_activity.scan")).not.toBe("claude_activity.scan");
  expect(jobLabel("claude_activity.reminders")).not.toBe("claude_activity.reminders");
  expect(jobLabel("code_answer.generate")).not.toBe("code_answer.generate");
});
