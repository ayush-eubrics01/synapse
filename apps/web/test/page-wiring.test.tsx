import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SECTION_IDS } from "../lib/nav";

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

test("page.tsx renders every section id, Running included", () => {
  for (const id of [...SECTION_IDS, "running"]) expect(PAGE).toContain(`id="${id}"`);
});

test("sections come in the designed order, Needs you and Running sharing the two-column row", () => {
  const at = (id: string) => PAGE.indexOf(`id="${id}"`);
  const order = ["overview", "triage", "running", "inbox", "commitments", "people", "system"];
  const positions = order.map(at);
  expect(positions.every((p) => p >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  const top = PAGE.indexOf('className="syn-top"');
  expect(top).toBeGreaterThan(at("overview"));
  expect(top).toBeLessThan(at("triage"));
  // Running is always rendered (with a waiting state), so the row never collapses to one column.
  expect(PAGE).not.toMatch(/\{overview && \(\s*<section id="running"/);
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
