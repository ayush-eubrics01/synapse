import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DASHBOARD_SECTION_IDS } from "@synapse/contracts";

// A static check of the assembled page: it reads source files as text, nothing is rendered.
const WEB = join(import.meta.dir, "..");
const PAGE = readFileSync(join(WEB, "app/page.tsx"), "utf8");

/** Top-level components the redesign replaced (Tasks 3-8); none may come back. */
const DELETED = [
  "ApprovalsList",
  "ClaudePanel",
  "CommitmentsPanel",
  "FollowupDrafts",
  "HealthBadge",
  "IdentitySetup",
  "InboxPanel",
  "JobsTable",
  "PeopleCandidates",
  "PersonProfile",
  "PriorityPeople",
  "ProfileRecommendations",
  "RedFlags",
  "SlackStatus",
  "UrgentInbox",
];

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return filesUnder(p, ext);
    return ext.test(e.name) ? [p] : [];
  });
}

test("page.tsx renders sections through the layout, with overview the only literal section", () => {
  expect(PAGE).toContain("layoutRows(");
  expect(PAGE).toContain("<DashboardSection");
  expect(PAGE.match(/<section id=/g)?.length).toBe(1);
  expect(PAGE).toContain('<section id="overview"');
  expect(PAGE).toContain('className="syn-pair"');
  expect(PAGE).not.toContain("syn-top");
});

test("every layout section id has a body", () => {
  const start = PAGE.indexOf("const sectionBodies: Record<DashboardSectionId, ReactNode>");
  expect(start).toBeGreaterThan(0);
  const bodies = PAGE.slice(start, PAGE.indexOf("\n  };\n", start));
  for (const id of DASHBOARD_SECTION_IDS) expect(bodies).toMatch(new RegExp(`\\b${id}: `));
});

test("the profile drawer lives at page level, after the layout map and outside the people body", () => {
  const drawer = PAGE.indexOf("<ProfileDrawer");
  expect(drawer).toBeGreaterThan(PAGE.indexOf("{rows.map(renderRow)}"));
  const people = PAGE.slice(PAGE.indexOf("people: ("), PAGE.indexOf("system: ("));
  expect(people).not.toContain("ProfileDrawer");
});

test("the palette and header offer Customise dashboard", () => {
  expect(PAGE).toContain("Customise dashboard");
  expect(PAGE).toContain("onToggleCustomise=");
});

test("refresh applies the stored layout only when no save is pending (a live event must not undo an edit)", () => {
  expect(PAGE).toMatch(/if \(lo\.status === "fulfilled" && !saver\.isBusy\(\) && gate\.isCurrent/);
  expect(PAGE).toContain("saver.flush()");
});

test("page.tsx imports none of the deleted components and no top-level component file is left", () => {
  for (const name of DELETED) {
    expect(PAGE).not.toContain(`/${name}"`);
  }
  const topLevel = readdirSync(join(WEB, "app/components"), { withFileTypes: true }).filter((e) =>
    e.isFile(),
  );
  expect(topLevel.map((e) => e.name)).toEqual([]);
});

test("page.tsx sets no inline colour", () => {
  expect(PAGE).not.toMatch(/style=\{\{[^}]*color/);
});

test("no component file contains a hex colour literal (colours come from CSS variables)", () => {
  const offenders = filesUnder(join(WEB, "app/components"), /\.tsx$/)
    .filter((f) => /#[0-9a-fA-F]{3,8}\b/.test(readFileSync(f, "utf8")))
    .map((f) => relative(WEB, f));
  expect(offenders).toEqual([]);
});

test("refresh() reports a failed thread refetch like every other fetch", () => {
  const failed = /const failed = \[([^\]]*)\]\.find\(/.exec(PAGE);
  expect(failed?.[1]?.split(",").map((s) => s.trim())).toContain("td");
});

test("the profile drawer's opener is captured at click time and handed to the drawer", () => {
  const openPerson = PAGE.slice(PAGE.indexOf("const openPerson = "));
  const body = openPerson.slice(0, openPerson.indexOf("};"));
  expect(body).toContain("document.activeElement");
  expect(PAGE).toContain("opener={personOpenerRef.current}");
});

test("navigation reveals hidden or collapsed targets locally before scrolling", () => {
  expect(PAGE).toContain("const navigateTo = ");
  expect(PAGE).toMatch(/if \(!sec\.visible\) setLocalShown/);
  expect(PAGE).toMatch(/if \(sec\.collapsed\) setLocalExpanded/);
  const outside = PAGE.replace(/const navigateTo = [\s\S]*?\n {2}\};/, "").replace(
    /useEffect\(\(\) => \{\n {4}const id = pendingScrollRef[\s\S]*?\}, \[scrollTick\]\);/,
    "",
  );
  expect(outside.match(/scrollToSection\(/g)?.length).toBe(1); // only the function definition
  expect(PAGE).toMatch(/const rows = layoutRows\(shownLayout\)/);
});

test("a stale layout fetch is dropped and edits wait for a layout switch", () => {
  expect(PAGE).toMatch(/gate\.isCurrent\(layoutToken\)/);
  expect(PAGE).toMatch(/if \(gate\.isLocked\(\)\) return;/);
  expect(PAGE).toContain("runLayoutCall(");
  expect(PAGE).toContain("busy={layoutBusy}");
});

test("the palette entry reflects the customise state", () => {
  expect(PAGE).toContain('customising ? "Done customising" : "Customise dashboard"');
});
