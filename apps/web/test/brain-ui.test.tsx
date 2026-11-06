import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { ProjectCard } from "../app/components/brain/ProjectCard";
import { ProjectsSection } from "../app/components/brain/ProjectsSection";
import { RegisterRepository } from "../app/components/brain/RegisterRepository";
import { Running } from "../app/components/system/Running";
import { BrainReviewCard } from "../app/components/triage/BrainReviewCard";
import { BrainSetupCard } from "../app/components/triage/BrainSetupCard";
import { detail, fact, proposal, repo, upcoming } from "./brain-fixtures";

const text = (html: string) => html.replace(/<!-- -->/g, "");
const NOW = new Date(2026, 10, 6, 12, 0, 0);
const noop = () => {};
const asyncNoop = async () => ({ ok: true }) as const;

const registerHtml = (o: Partial<Parameters<typeof RegisterRepository>[0]> = {}) =>
  text(
    renderToString(
      <RegisterRepository
        onInspect={async () => ({ ok: false, error: "x" })}
        onRegister={asyncNoop}
        initialOpen
        {...o}
      />,
    ),
  );

test("the register form starts with a path field and no proposal fields", () => {
  const html = registerHtml();
  expect(html).toContain("Repository path");
  expect(html).not.toContain("Tracked branch");
});

test("the proposal prefills name, tracked branch and environment rows with toggles", () => {
  const html = registerHtml({ initialPath: "/tmp/demo/app", initialProposal: proposal() });
  expect(html).toContain("Tracked branch");
  expect(html).toMatch(/<option value="main" selected="">main<\/option>/);
  expect(html).toContain('value="demo-app"');
  expect(html).toContain('value="stage"');
  expect(html).toContain('value="prod"');
  expect(html).toContain('role="switch"');
  expect(html).toContain("Protected");
  expect(html).toContain("Auto-deploys on merge");
  expect(html).toContain("Jira project keys");
  expect(html).toContain("Notes");
  expect(html).toContain("Register repository");
});

test("the register form checks Jira keys with the shared contracts rule (M8)", () => {
  const src = readFileSync(
    join(import.meta.dir, "../app/components/brain/RegisterRepository.tsx"),
    "utf8",
  );
  expect(src).toContain("JIRA_PROJECT_KEY_RE");
  expect(src).not.toMatch(/\/\^\[A-Z\]\[A-Z0-9_\]\+\$\//);
});

test("a bad path shows its reason label inline", () => {
  const html = registerHtml({ initialPath: "/nope", initialError: "not_found" });
  expect(html).toContain('role="alert"');
  expect(html).toContain("Path not found");
});

test("a refused register shows the label for its code", () => {
  const html = registerHtml({
    initialPath: "/tmp/demo/app",
    initialProposal: proposal(),
    initialError: "duplicate_name",
  });
  expect(html).toContain("Name already used by another project");
});

test("the project card groups approved facts and lists pending facts with Accept, Edit, Reject", () => {
  const html = text(
    renderToString(
      <ProjectCard
        project={detail()}
        now={NOW}
        hidden={new Set()}
        onAcceptFact={noop}
        onRejectFact={noop}
        onAddFact={noop}
        onSaveMilestone={noop}
        onDeleteMilestone={noop}
      />,
    ),
  );
  expect(html).toContain("demo-app");
  expect(html).toContain("A demo application");
  expect(html).toContain("Stack");
  expect(html).toContain("TypeScript on Bun");
  expect(html).toContain("Module");
  expect(html).toContain("No migrations lock");
  expect(html).toContain("Needs review");
  for (const b of ["Accept", "Edit", "Reject"]) expect(html).toContain(`>${b}</button>`);
  expect(html).toContain("Go live");
  expect(html).toContain("In 4 days");
  expect(html).toContain("Add milestone");
  expect(html).toContain("1 overdue");
});

const card = (o: Partial<Parameters<typeof ProjectCard>[0]> = {}) =>
  text(
    renderToString(
      <ProjectCard
        project={detail()}
        now={NOW}
        hidden={new Set()}
        onAcceptFact={noop}
        onRejectFact={noop}
        onAddFact={noop}
        onSaveMilestone={noop}
        onDeleteMilestone={noop}
        {...o}
      />,
    ),
  );

test("deleting a milestone asks for an inline confirmation first (M8)", () => {
  const idle = card();
  expect(idle).toContain(">Delete</button>");
  expect(idle).not.toContain("Delete this milestone?");
  const asking = card({ initialConfirmDelete: "m1" });
  expect(asking).toContain("Delete this milestone?");
  expect(asking).toContain(">Confirm delete</button>");
  expect(asking).toContain(">Keep</button>");
});

test("the milestone edit form can set planned, done, slipped or cancelled (M8)", () => {
  const html = card({ initialEditingMilestone: "m1" });
  expect(html).toContain('aria-label="Milestone status"');
  for (const s of ["planned", "done", "slipped", "cancelled"]) {
    expect(html).toContain(`<option value="${s}"`);
  }
  expect(html).toMatch(/<option value="planned" selected="">/);
  // A new milestone is always planned: no status choice.
  expect(card({ initialEditingMilestone: "new" })).not.toContain('aria-label="Milestone status"');
});

test("fact text renders as plain text", () => {
  const html = renderToString(
    <ProjectCard
      project={detail({ facts: [fact({ content: "<img src=x onerror=alert(1)>" })] })}
      now={NOW}
      hidden={new Set()}
      onAcceptFact={noop}
      onRejectFact={noop}
      onAddFact={noop}
      onSaveMilestone={noop}
      onDeleteMilestone={noop}
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

test("a fact pending a deferred reject is hidden in the card", () => {
  const html = renderToString(
    <ProjectCard
      project={detail()}
      now={NOW}
      hidden={new Set(["brain-fact:f3"])}
      onAcceptFact={noop}
      onRejectFact={noop}
      onAddFact={noop}
      onSaveMilestone={noop}
      onDeleteMilestone={noop}
    />,
  );
  expect(html).not.toContain("No migrations lock");
});

const section = (o: Partial<Parameters<typeof ProjectsSection>[0]> = {}) =>
  text(
    renderToString(
      <ProjectsSection
        repos={[repo()]}
        projects={[detail()]}
        loaded
        now={NOW}
        hidden={new Set()}
        onInspectNow={noop}
        onAcceptRemotes={noop}
        onProposal={async () => ({ ok: false, error: "x" })}
        onRegister={asyncNoop}
        onAcceptFact={noop}
        onRejectFact={noop}
        onAddFact={noop}
        onSaveMilestone={noop}
        onDeleteMilestone={noop}
        {...o}
      />,
    ),
  );

test("the repository list shows branch, env chips, and Inspect now", () => {
  const html = section();
  expect(html).toContain("demo-app");
  expect(html).toContain("/tmp/demo/app");
  expect(html).toContain("main");
  expect(html).toContain("stage → stage · auto-deploys on merge");
  expect(html).toContain("prod → prod · protected");
  expect(html).toContain("Inspect now");
  expect(html).not.toContain("Accept current remotes");
});

test("drift shows a warning, and remotes drift offers Accept current remotes", () => {
  const html = section({
    repos: [
      repo({
        drift: {
          offTrackedBranch: "feature",
          remotesChanged: true,
          detectedAt: "2026-11-05T00:00:00.000Z",
        },
      }),
    ],
  });
  expect(html).toContain("Not on main (now feature)");
  expect(html).toContain("Remotes changed");
  expect(html).toContain("Accept current remotes");
});

test("an empty section explains how to start", () => {
  const html = section({ repos: [], projects: [] });
  expect(html).toContain("Register a repository");
});

const review = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    fact: fact({ id: `f${i}`, status: "needs_review", content: `Fact number ${i}` }),
    projectName: "demo-app",
  }));

test("the review card lists up to 5 facts with Accept and Reject and counts the rest", () => {
  const html = text(
    renderToString(
      <BrainReviewCard facts={review(7)} onAccept={noop} onReject={noop} onSeeAll={noop} />,
    ),
  );
  expect(html).toContain("PROJECTS · REVIEW");
  expect(html).toContain("Fact number 0");
  expect(html).toContain("Fact number 4");
  expect(html).not.toContain("Fact number 5");
  expect(html).toContain("+2 more");
  expect(html.match(/>Accept<\/button>/g)?.length).toBe(5);
  expect(html.match(/>Reject<\/button>/g)?.length).toBe(5);
});

test("the setup card offers Register a repository", () => {
  const html = text(renderToString(<BrainSetupCard onRegister={noop} />));
  expect(html).toContain("PROJECTS · SETUP");
  expect(html).toContain("Register a repository");
  expect(html).toContain("<button");
});

test("the Running panel lists the next 3 milestones under Upcoming", () => {
  const html = text(
    renderToString(
      <Running
        pipeline={[]}
        status={null}
        runs={[]}
        now={NOW}
        upcoming={[
          upcoming({ id: "a", name: "Alpha", targetDate: "2026-11-08" }),
          upcoming({ id: "b", name: "Beta", overdue: true }),
          upcoming({ id: "c", name: "Gamma" }),
          upcoming({ id: "d", name: "Delta" }),
        ]}
      />,
    ),
  );
  expect(html).toContain("Upcoming");
  expect(html).toContain("Alpha");
  expect(html).toContain("In 2 days");
  expect(html).toContain("Overdue");
  expect(html).toContain("Gamma");
  expect(html).not.toContain("Delta");
});

test("brain.css exists, uses tokens only and is imported by the layout", () => {
  const css = readFileSync(join(import.meta.dir, "../app/styles/brain.css"), "utf8");
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  const layout = readFileSync(join(import.meta.dir, "../app/layout.tsx"), "utf8");
  expect(layout).toContain("./styles/brain.css");
});
