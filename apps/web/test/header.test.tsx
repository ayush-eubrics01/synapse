import { expect, test } from "bun:test";
import type { DashboardOverview } from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { CommandPalette } from "../app/components/header/CommandPalette";
import { Header } from "../app/components/header/Header";

const now = new Date(2026, 10, 6, 9, 0);

function overview(
  health: DashboardOverview["health"],
  name: string | null = "Ada",
): DashboardOverview {
  return {
    generatedAt: now.toISOString(),
    self: { slackUserId: name ? "U1" : null, name },
    counts: {
      urgent: 0,
      approvals: 0,
      outgoingAttention: 0,
      redFlags: 0,
      commitmentsToReview: 0,
      followupDrafts: 0,
      profileRecommendations: 0,
      peopleToEvaluate: 0,
      conversations: 0,
    },
    lastSlackSyncAt: null,
    health,
    pipeline: [],
    engineeringLock: null,
  } as DashboardOverview;
}

const issue = (label: string, detail: string | null, hint: string | null) => ({
  check: label.toLowerCase(),
  label,
  status: "degraded" as const,
  detail,
  hint,
});

const render = (o: DashboardOverview, initiallyOpen = false) =>
  renderToString(
    <Header
      overview={o}
      now={now}
      onOpenPalette={() => {}}
      backfillStarted
      initiallyOpen={initiallyOpen}
    />,
  );

test("greeting with and without a name", () => {
  expect(render(overview({ status: "ok", issues: [] }))).toContain("Good morning, Ada.");
  const html = render(overview({ status: "ok", issues: [] }, null));
  expect(html).toContain("Good morning.");
  expect(html).not.toContain("Good morning,");
});

test("away switch is disabled with the D9 text", () => {
  const html = render(overview({ status: "ok", issues: [] }));
  expect(html).toContain('role="switch"');
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain("Away mode");
  expect(html).toContain(
    "Away mode isn&#x27;t available yet. Until it is, every reply waits for you.",
  );
});

test("health pill states", () => {
  expect(render(overview({ status: "ok", issues: [] }))).toContain("Healthy");
  expect(render(overview({ status: "degraded", issues: [issue("Claude", "x", null)] }))).toContain(
    "Degraded · 1 check",
  );
  const down = render(
    overview({
      status: "down",
      issues: [issue("Claude", null, null), issue("Slack", null, null)],
    }),
  );
  expect(down).toContain("Down · 2 checks");
});

test("popover lists issues and the first hint", () => {
  const html = render(
    overview({
      status: "degraded",
      issues: [
        issue("Claude CLI", "token expires soon", null),
        issue("Slack", "no sync", "Run the incremental sync"),
      ],
    }),
    true,
  );
  expect(html).toContain("Why “degraded”?");
  expect(html).toContain("Claude CLI");
  expect(html).toContain("token expires soon");
  expect(html).toContain("Most likely fix: Run the incremental sync");
});

test("palette open is a dialog and shows an empty state", () => {
  const html = renderToString(<CommandPalette open items={[]} onClose={() => {}} />);
  expect(html).toContain('role="dialog"');
  expect(html).toContain("Jump to a conversation, person or action…");
  expect(html).toContain("No matches.");
  expect(renderToString(<CommandPalette open={false} items={[]} onClose={() => {}} />)).toBe("");
});

test("palette lists items with their group", () => {
  const html = renderToString(
    <CommandPalette
      open
      items={[{ id: "a", label: "Inbox", group: "go to", run: () => {} }]}
      onClose={() => {}}
    />,
  );
  expect(html).toContain("Inbox");
  expect(html).toContain("go to");
  expect(html).toContain("esc close");
});
