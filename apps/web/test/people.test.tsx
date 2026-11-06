import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidatesResponse, EvidenceView, PersonDetail } from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { People } from "../app/components/people/People";
import { ProfileDrawer } from "../app/components/people/ProfileDrawer";
import type { PersonDto } from "../lib/api";
import {
  barWidth,
  evaluateInOrder,
  evaluationsToast,
  priorityRows,
  pruneQueued,
  topUnqueued,
} from "../lib/people-ui";

// React inserts comment markers between adjacent text nodes; drop them to match on text.
const text = (html: string) => html.replace(/<!-- -->/g, "");

const ev = (o: Partial<EvidenceView> = {}): EvidenceView => ({
  observationKey: "communication.brief",
  sourceExternalRef: "C1:1.0",
  messageAvailable: true,
  confidence: "high",
  permalink: null,
  ...o,
});

const cand = (id: string, name: string, score: number, o: Record<string, unknown> = {}) => ({
  slackUserId: id,
  name,
  score,
  messageCount: 4,
  hasProfile: false,
  hasPendingRecommendation: false,
  isTemporary: false,
  actions: ["evaluate" as const],
  ...o,
});
const candidates = (...c: CandidatesResponse["candidates"]): CandidatesResponse => ({
  identityRequired: false,
  candidates: c,
});
const person = (id: string, name: string | null, o: Partial<PersonDto> = {}): PersonDto => ({
  slackUserId: id,
  name,
  rationale: null,
  priority: "normal",
  extraAttention: false,
  ...o,
});

const render = (
  c: CandidatesResponse | null,
  people: PersonDto[] = [],
  self: string | null = null,
) =>
  text(
    renderToString(
      <People
        candidates={c}
        people={people}
        self={self}
        onEvaluate={async () => ({ queued: true, notice: null })}
        onNotice={() => {}}
        onPriority={() => {}}
        onOpen={() => {}}
        queued={new Set()}
        onQueued={() => {}}
      />,
    ),
  );

test("People header and subtitles", () => {
  const html = render(candidates(cand("U1", "Grace", 40)), [person("U1", "Grace")]);
  expect(html).toContain("People");
  expect(html).toContain(
    "Profiles exist only for people you choose. Claude never changes priority.",
  );
  expect(html).toContain("Ranked by how much you talk to them");
  expect(html).toContain("Extra attention screens a person&#x27;s messages more carefully.");
  expect(html).not.toMatch(/away|auto-repl/i);
  expect(html).toContain('aria-label="Filter people"');
});

test("identity required shows the notice instead of a list, with no Evaluate button", () => {
  const html = render({ identityRequired: true, candidates: [] });
  expect(html).toContain("Confirm your Slack identity");
  expect(html).not.toContain(">Evaluate</button>");
  expect(html).toMatch(/disabled=""[^>]*>Evaluate top 3</);
});

test("loading and empty candidate states", () => {
  expect(render(null)).toContain("Loading candidates.");
  expect(render(candidates())).toContain("No one to evaluate right now.");
});

test("Ready to evaluate rows: avatar, score line, bar width, button variant by score", () => {
  const html = render(
    candidates(cand("U1", "Grace", 42), cand("U2", "Linus", 9, { messageCount: 1 })),
  );
  expect(html).toContain("score 42 · 4 msgs");
  expect(html).toContain("score 9 · 1 msgs");
  expect(html).toContain("width:42%");
  expect(html).toContain("width:9%");
  expect(html).toContain("Grace");
  expect(html).toContain("syn-avatar");
  // one primary (>= 30), one secondary Evaluate (plus the secondary "Evaluate top 3")
  expect(html.match(/syn-btn--primary[^>]*>Evaluate</g)?.length).toBe(1);
  expect(html.match(/syn-btn--secondary[^>]*>Evaluate</g)?.length).toBe(1);
});

test("Evaluate button only when the server allows it; status notes show", () => {
  const html = render(
    candidates(
      cand("U1", "Grace", 9),
      cand("U2", "Linus", 9, { hasProfile: true, hasPendingRecommendation: true, actions: [] }),
    ),
  );
  expect(html).toContain("Linus");
  expect(html.match(/>Evaluate</g)?.length).toBe(1);
  expect(html).toContain("Profiled");
  expect(html).toContain("Review pending");
});

test("bar width is max(score, 2) percent, capped at 100", () => {
  expect(barWidth(0)).toBe(2);
  expect(barWidth(1)).toBe(2);
  expect(barWidth(55)).toBe(55);
  expect(barWidth(140)).toBe(100);
  expect(render(candidates(cand("U1", "Grace", 0)))).toContain("width:2%");
});

test("topUnqueued takes the first three evaluable, unqueued candidates in order", () => {
  const list = [
    cand("U1", "Ada", 50),
    cand("U2", "Grace", 40, { actions: [] }),
    cand("U3", "Linus", 30),
    cand("U4", "Barbara", 20),
    cand("U5", "Ken", 10),
  ];
  expect(topUnqueued(list, new Set())).toEqual(["U1", "U3", "U4"]);
  expect(topUnqueued(list, new Set(["U1"]))).toEqual(["U3", "U4", "U5"]);
  expect(topUnqueued([], new Set())).toEqual([]);
});

test("evaluateInOrder is sequential, skips refusals and errors, and returns the queued ids", async () => {
  const calls: string[] = [];
  let running = 0;
  let overlap = false;
  const r = await evaluateInOrder(["U1", "U2", "U3"], async (id) => {
    running++;
    if (running > 1) overlap = true;
    calls.push(id);
    await Promise.resolve();
    running--;
    if (id === "U2") return { queued: false, notice: "Not queued: already queued" };
    return { queued: true, notice: null };
  });
  expect(calls).toEqual(["U1", "U2", "U3"]);
  expect(overlap).toBe(false);
  expect(r.queued).toEqual(["U1", "U3"]);
  const withError = await evaluateInOrder(["U1", "U2"], async (id) => {
    if (id === "U1") throw new Error("boom");
    return { queued: true, notice: null };
  });
  expect(withError.queued).toEqual(["U2"]);
  expect(withError.notice).toBe("Error: boom");
});

test("evaluateInOrder keeps every refusal in a batch, joined once after it (a later success can't clear one)", async () => {
  const r = await evaluateInOrder(["U1", "U2", "U3"], async (id) =>
    id === "U3"
      ? { queued: true, notice: null }
      : { queued: false, notice: id === "U1" ? "Not queued: no identity" : "Not queued: busy" },
  );
  expect(r.queued).toEqual(["U3"]);
  expect(r.notice).toBe("Not queued: no identity · Not queued: busy");
  const same = await evaluateInOrder(["U1", "U2"], async () => ({
    queued: false,
    notice: "Not queued: no identity",
  }));
  expect(same.notice).toBe("Not queued: no identity");
  const clean = await evaluateInOrder(["U1"], async () => ({ queued: true, notice: null }));
  expect(clean.notice).toBeNull();
});

test("people.css: a selected Critical uses the red tone, High uses --high", () => {
  const css = readFileSync(join(import.meta.dir, "../app/styles/people.css"), "utf8");
  expect(css).toMatch(
    /\.syn-seg-option\[aria-checked="true"\]\[data-value="high"\]\s*\{[^}]*background: var\(--high\);[^}]*color: var\(--onHigh\)/,
  );
  expect(css).toMatch(
    /\.syn-seg-option\[aria-checked="true"\]\[data-value="critical"\]\s*\{[^}]*background: var\(--redBg\);[^}]*color: var\(--redFg\)/,
  );
});

test("evaluationsToast uses the actual count", () => {
  expect(evaluationsToast(3)).toBe("3 evaluations queued · drafts will need your approval");
  expect(evaluationsToast(2)).toBe("2 evaluations queued · drafts will need your approval");
  expect(evaluationsToast(1)).toBe("1 evaluation queued · draft will need your approval");
});

test("queued ids are pruned once the candidate leaves the list", () => {
  const list = candidates(cand("U1", "Ada", 5)).candidates;
  expect([...pruneQueued(new Set(["U1", "U9"]), list)]).toEqual(["U1"]);
});

test("Priority rows: radiogroup and Extra attention switch per person", () => {
  const html = render(candidates(), [
    person("U1", "Grace", { priority: "high", extraAttention: true }),
    person("U2", "Linus"),
  ]);
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('aria-label="Priority for Grace"');
  expect(html).toContain('aria-label="Priority for Linus"');
  expect(html.match(/role="switch"/g)?.length).toBe(2);
  expect(html.match(/Extra attention</g)?.length).toBe(2);
  for (const l of ["Normal", "High", "Critical"]) expect(html).toContain(l);
  expect(html).toContain('aria-checked="true"');
});

test("Priority list leaves the user out and says so", () => {
  const people = [person("U1", "Ada"), person("U2", "Grace")];
  const html = render(candidates(), people, "U1");
  expect(html).toContain("Ada is you, so you are left out of this list.");
  expect(html).not.toContain("Priority for Ada");
  expect(html).toContain("Priority for Grace");
  expect(render(candidates(), people, null)).not.toContain("is you");
  expect(render(candidates(), [], null)).toContain("No people.");
});

test("priorityRows filters by name or id, excludes self, caps at 50", () => {
  const people = [person("U1", "Ada"), person("U2", "Grace"), person("U3", null)];
  expect(priorityRows(people, "U1", "").map((p) => p.slackUserId)).toEqual(["U2", "U3"]);
  expect(priorityRows(people, null, "gra").map((p) => p.slackUserId)).toEqual(["U2"]);
  expect(priorityRows(people, null, "u3").map((p) => p.slackUserId)).toEqual(["U3"]);
  const many = Array.from({ length: 80 }, (_, i) => person(`U${i}`, `P${i}`));
  expect(priorityRows(many, null, "")).toHaveLength(50);
});

const detail = (o: Partial<PersonDetail> = {}): PersonDetail => ({
  slackUserId: "U1",
  name: "Grace",
  title: null,
  team: null,
  email: null,
  rationale: null,
  priority: "high",
  extraAttention: false,
  hasProfile: true,
  profileVersion: 2,
  hasPendingRecommendation: false,
  profile: {
    version: 2,
    updatedAt: "2026-01-02T00:00:00.000Z",
    content: {
      professionalContext: [],
      communication: [
        { key: "brief", text: "Prefers short messages", evidence: ["m"], confidence: "high" },
      ],
      responseGuidelines: [],
    },
    evidence: [ev({ observationKey: "communication.brief", messageAvailable: false })],
  },
  versions: [
    { version: 1, createdAt: "2026-01-01T00:00:00.000Z", approvalId: "a1" },
    { version: 2, createdAt: "2026-01-02T00:00:00.000Z", approvalId: "a2" },
  ],
  temporaryContact: null,
  flagCount: 1,
  actions: [],
  ...o,
});
const drawer = (p: PersonDetail | null) =>
  text(
    renderToString(
      <ProfileDrawer person={p} onClose={() => {}} onEvaluate={() => {}} onPriority={() => {}} />,
    ),
  );

test("ProfileDrawer is a modal dialog named by the person, with the full profile and Close", () => {
  const html = drawer(detail());
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
  const labelledby = html.match(/aria-labelledby="([^"]+)"/)?.[1];
  expect(labelledby).toBeTruthy();
  expect(html).toMatch(new RegExp(`id="${labelledby}"[^>]*>Grace<`));
  expect(html).toContain("Close");
  expect(html).toContain("Current version 2");
  expect(html).toContain("v1");
  expect(html).toContain("v2");
  expect(html).toContain("Prefers short messages");
  expect(html).toContain("original message no longer available locally");
  expect(html).toContain("Priority for Grace");
  expect(html).toContain("1 red flag");
  expect(html).not.toContain("Evaluate");
});

test("ProfileDrawer renders nothing without a person; Evaluate and notes follow the server", () => {
  expect(drawer(null)).toBe("");
  const html = drawer(
    detail({
      profile: null,
      actions: ["evaluate"],
      temporaryContact: {
        firstSeenAt: "2026-01-01",
        lastSeenAt: "2026-01-05",
        messageCount: 3,
        expiresAt: "2026-02-01",
      },
    }),
  );
  expect(html).toContain("No profile yet.");
  expect(html).toContain("Evaluate");
  expect(html).toContain("Temporary contact, 3 messages");
});
