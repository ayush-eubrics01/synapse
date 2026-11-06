import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { JiraSection } from "../app/components/jira/JiraSection";
import { JiraAttentionCard } from "../app/components/triage/JiraAttentionCard";
import { JiraSetupCard } from "../app/components/triage/JiraSetupCard";
import { DEFAULT_SCOPE_JQL } from "../lib/jira";
import { issue } from "./jira-fixtures";

const text = (html: string) => html.replace(/<!-- -->/g, "");
const NOW = new Date(2026, 10, 6, 12, 0, 0);
const status = (o = {}) => ({
  enabled: true,
  cloudIdSet: true,
  lastSyncAt: new Date(NOW.getTime() - 3 * 60_000).toISOString(),
  lastReconcileAt: null,
  issueCount: 3,
  lastError: null,
  ...o,
});
const render = (issues = [issue()], st: ReturnType<typeof status> | null = status()) =>
  text(
    renderToString(
      <JiraSection
        status={st}
        issues={issues}
        now={NOW}
        onSync={() => {}}
        onGoToSetup={() => {}}
      />,
    ),
  );

test("the section renders each group with a count, the sync line and a Sync now button", () => {
  const html = render([
    issue({ key: "DEMO-1" }),
    issue({ key: "DEMO-2", statusCategory: "indeterminate", statusName: "In Progress" }),
    issue({ key: "DEMO-3", attention: "overdue", dueDate: "2026-11-04" }),
    issue({ key: "DEMO-4", statusCategory: "done", statusName: "Done" }),
  ]);
  for (const g of ["Needs attention", "In progress", "To do", "Done recently"]) {
    expect(html).toContain(g);
  }
  expect(html).toContain("synced 3 min ago");
  expect(html).toContain("Sync now");
  expect(html).toContain("syn-chip--blue");
  expect(html).toContain("syn-chip--green");
  expect(html).toContain("syn-chip--red");
  expect(html).toContain("Overdue by 2 days");
});

test("a row shows key, plain-text summary, status, priority, due date, mentions and the Jira link", () => {
  const html = render([
    issue({
      summary: "<b>bold</b> thing",
      dueDate: "2026-11-07",
      slackMentions: { count: 2, latest: [] },
    }),
  ]);
  expect(html).toContain("DEMO-1");
  expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; thing");
  expect(html).not.toContain("<b>");
  expect(html).toContain("To Do");
  expect(html).toContain("High");
  expect(html).toContain("Due Sat 7 Nov");
  expect(html).toContain("2 Slack mentions");
  expect(html).toContain('id="jira-issue-DEMO-1"');
  expect(html).toContain('href="https://example.atlassian.net/browse/DEMO-1"');
  expect(html).toContain('rel="noreferrer noopener"');
  expect(html).toContain("Open in Jira ↗");
  expect(render()).not.toContain("Slack mention");
});

test("an attention row carries an attention chip: red for overdue, amber for stale", () => {
  const red = render([issue({ attention: "blocked" })]);
  expect(red).toMatch(/syn-chip--red[^>]*>Blocked/);
  const amber = render([
    issue({ attention: "stale", updatedAt: new Date(2026, 10, 1, 9).toISOString() }),
  ]);
  expect(amber).toMatch(/syn-chip--amber[^>]*>No update in 5 days/);
});

test("empty state, not-synced line and disabled state", () => {
  expect(render([])).toContain("No Jira issues in scope.");
  expect(render([], status({ lastSyncAt: null }))).toContain("not synced yet");
  const off = render([], status({ enabled: false }));
  expect(off).toContain("Jira tracking is off");
  expect(off).toContain("Set up in Needs you");
  expect(off).not.toContain("Sync now");
  expect(render([], null)).not.toContain("No Jira issues in scope.");
  expect(render([], status({ lastError: "rate_limited" }))).toContain("rate_limited");
});

test("the attention card lists up to 5 issues and links to the section", () => {
  const issues = Array.from({ length: 7 }, (_, i) =>
    issue({ key: `DEMO-${i + 1}`, attention: "overdue" }),
  );
  const html = text(
    renderToString(<JiraAttentionCard issues={issues} now={NOW} onSeeAll={() => {}} />),
  );
  expect(html).toContain("JIRA · ATTENTION");
  expect(html).toContain("7 Jira issues need attention");
  expect(html).toContain("DEMO-5");
  expect(html).not.toContain("DEMO-6");
  expect(html).toContain("+2 more");
  expect(html).toContain("See all in Jira →");
  expect(
    text(
      renderToString(
        <JiraAttentionCard issues={issues.slice(0, 1)} now={NOW} onSeeAll={() => {}} />,
      ),
    ),
  ).toContain("1 Jira issue needs attention");
});

test("the setup card has the explainer, a prefilled scope, excluded projects and Enable", () => {
  const html = text(renderToString(<JiraSetupCard onEnable={() => {}} />));
  expect(html).toContain("JIRA · SETUP");
  expect(html).toContain("Track the Jira issues assigned to you.");
  expect(html).toContain("<textarea");
  expect(html).toContain(DEFAULT_SCOPE_JQL.replace(">", "&gt;"));
  expect(html).toContain('aria-label="Excluded projects"');
  expect(html).toContain("Enable");
  expect(html).not.toContain('role="alert"');
});
