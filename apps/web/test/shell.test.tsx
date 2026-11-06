import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Sidebar } from "../app/components/shell/Sidebar";
import { Avatar } from "../app/components/ui/Avatar";
import { Button } from "../app/components/ui/Button";
import { Card } from "../app/components/ui/Card";
import { Chip } from "../app/components/ui/Chip";
import { nextSegmentedValue, Segmented } from "../app/components/ui/Segmented";
import { Switch } from "../app/components/ui/Switch";
import { ToastProvider, Toasts, useToast } from "../app/components/ui/Toasts";
import { hueFor } from "../lib/avatar";
import { sidebarItems } from "../lib/nav";

const footer = { api: "127.0.0.1:7400", web: ":7401", lock: "not in use yet" };

const sidebar = (count: number) =>
  renderToString(
    <Sidebar
      items={[
        { id: "overview", label: "Overview" },
        { id: "triage", label: "Needs you", count, hot: true },
      ]}
      active="triage"
      onGo={() => {}}
      footer={footer}
    />,
  );

test("Sidebar shows the brand, nav labels, counts and the local-only line", () => {
  const html = sidebar(4);
  expect(html).toContain("Synapse");
  expect(html).toContain("Engineering ops");
  expect(html).toContain("Needs you");
  expect(html).toMatch(/syn-badge[^"]*"[^>]*>4</);
  expect(html).toContain("Runs locally. Nothing leaves this machine without your approval.");
  expect(html).toContain('aria-current="true"');
});

test("Sidebar shows no badge when the count is 0", () => {
  expect(sidebar(0)).not.toContain("syn-badge");
});

test("Sidebar footer shows the endpoints and the lock text as given", () => {
  const html = sidebar(1);
  expect(html).toContain("127.0.0.1:7400");
  expect(html).toContain(":7401");
  expect(html).toContain("eng lock");
  expect(html).toContain("not in use yet");
  expect(html).toContain("Dark");
  expect(html).toContain("Light");
});

test("Switch disabled renders an unchecked, aria-disabled switch with its hint", () => {
  const html = renderToString(
    <Switch
      checked={false}
      onChange={() => {}}
      label="Away mode"
      disabled
      hint="Away mode isn't available yet."
    />,
  );
  expect(html).toContain('role="switch"');
  expect(html).toContain('aria-checked="false"');
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain("Away mode isn&#x27;t available yet.");
  expect(html).not.toContain(" disabled=");
});

test("Segmented renders a radiogroup with exactly one checked option", () => {
  const html = renderToString(
    <Segmented
      ariaLabel="Filter"
      options={[
        { value: "all", label: "All" },
        { value: "dm", label: "DMs" },
        { value: "ch", label: "Channels" },
      ]}
      value="dm"
      onChange={() => {}}
    />,
  );
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('aria-label="Filter"');
  expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
  expect(html.match(/aria-checked="false"/g)?.length).toBe(2);
});

test("nextSegmentedValue steps from the local value, so → → from Normal reaches Critical", () => {
  const opts = [
    { value: "normal", label: "Normal" },
    { value: "high", label: "High" },
    { value: "critical", label: "Critical" },
  ] as const;
  const once = nextSegmentedValue(opts, "normal", "ArrowRight");
  expect(once).toBe("high");
  expect(nextSegmentedValue(opts, once ?? "normal", "ArrowRight")).toBe("critical");
  expect(nextSegmentedValue(opts, "normal", "ArrowLeft")).toBe("critical");
  expect(nextSegmentedValue(opts, "critical", "ArrowDown")).toBe("normal");
  expect(nextSegmentedValue(opts, "high", "ArrowUp")).toBe("normal");
  expect(nextSegmentedValue(opts, "high", "Enter")).toBeNull();
  expect(nextSegmentedValue([], "high", "ArrowRight")).toBeNull();
});

test("Avatar shows initials on the id's hue, and a # tile for channels", () => {
  const person = renderToString(<Avatar id="U0ADA" name="Ada Lovelace" />);
  expect(person).toContain(">AL<");
  expect(person).toContain(`oklch(var(--avBgL) 0.055 ${hueFor("U0ADA")})`);
  const channel = renderToString(<Avatar id="C0OPS" name="ops" kind="channel" size={20} />);
  expect(channel).toContain(">#<");
  expect(channel).toContain("syn-avatar--channel");
});

test("Button, Chip and Card render their variant classes", () => {
  const b = renderToString(
    <Button variant="primary" size="sm">
      Approve
    </Button>,
  );
  expect(b).toContain('type="button"');
  expect(b).toContain("syn-btn--primary");
  expect(b).toContain("syn-btn--sm");
  expect(renderToString(<Chip tone="red">RED FLAG</Chip>)).toContain("syn-chip--red");
  expect(renderToString(<Card tone="quiet">x</Card>)).toContain("syn-card--quiet");
});

function Shower() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show("Sent")}>
      go
    </button>
  );
}

test("Toasts render an empty polite live region; useToast works without a provider", () => {
  const html = renderToString(
    <ToastProvider>
      <Toasts />
    </ToastProvider>,
  );
  expect(html).toContain('aria-live="polite"');
  expect(() => renderToString(<Shower />)).not.toThrow();
});

test("sidebarItems shows the Needs-you card count and marks it hot", () => {
  const counts = {
    urgent: 1,
    approvals: 2,
    outgoingAttention: 0,
    redFlags: 1,
    commitmentsToReview: 3,
    followupDrafts: 0,
    profileRecommendations: 1,
    peopleToEvaluate: 5,
    conversations: 12,
    jiraAttention: 0,
  };
  const items = sidebarItems(counts, 8);
  expect(items.map((i) => i.id)).toEqual([
    "overview",
    "triage",
    "inbox",
    "commitments",
    "people",
    "system",
  ]);
  const triage = items.find((i) => i.id === "triage");
  expect(triage?.label).toBe("Needs you");
  expect(triage?.count).toBe(8);
  expect(triage?.hot).toBe(true);
  expect(items.find((i) => i.id === "commitments")?.count).toBe(3);
  expect(items.find((i) => i.id === "people")?.count).toBe(5);
  expect(sidebarItems(null, 0).every((i) => !i.count)).toBe(true);
  // The Inbox badge counts conversations where they wrote last, not all conversations.
  expect(sidebarItems(counts, 8, 4).find((i) => i.id === "inbox")?.count).toBe(4);
  expect(sidebarItems(counts, 8).find((i) => i.id === "inbox")?.count).toBe(0);
  // The badge is the feed's card count, not a sum of overview counts.
  const two = sidebarItems(counts, 2).find((i) => i.id === "triage");
  expect(two?.count).toBe(2);
  expect(sidebarItems(counts, 0).find((i) => i.id === "triage")?.hot).toBe(false);
});
