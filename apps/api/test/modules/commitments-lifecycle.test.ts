import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import {
  CommitmentLifecycle,
  InvalidCommitmentEdit,
  InvalidCommitmentTransition,
  InvalidProposal,
  InvalidReview,
  UnknownCommitment,
} from "../../src/modules/commitments/lifecycle";

type Status = "open" | "in_progress" | "blocked" | "completed" | "cancelled";
const NOW = "2026-11-05T12:00:00.000Z";
const SELF = "USELF00001";
const PRIYA = "UPRIYA0001";
const OTHER = "UOTHER0001";
const SECRET = "SECRET-COMMITMENT-TEXT";

let db: ReturnType<typeof openDatabase>["db"];
let lc: CommitmentLifecycle;
let settings: SettingsService;
let seq: number;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  const clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  settings.set("slack.selfUserId", SELF);
  lc = new CommitmentLifecycle({ db, clock, settings, events });
  seq = 0;
  db.insert(schema.slackUsers).values({ id: "su-self", externalId: SELF, name: "Me" }).run();
  db.insert(schema.slackUsers).values({ id: "su-priya", externalId: PRIYA, name: "Priya" }).run();
  db.insert(schema.slackConversations)
    .values({ id: "c1", externalId: "C1", type: "channel", name: "dev" })
    .run();
});

function seed(
  o: Partial<typeof schema.commitments.$inferInsert> & { sources?: string[] } = {},
): string {
  seq++;
  const id = o.id ?? `k${seq}`;
  const { sources, ...rest } = o;
  db.insert(schema.commitments)
    .values({
      id,
      description: `${SECRET} ${seq}`,
      ownerSlackUserId: SELF,
      counterpartySlackUserId: PRIYA,
      direction: "mine",
      status: "open",
      reviewStatus: "accepted",
      dedupKey: `dk${seq}`,
      createdAt: `2026-11-05T10:00:0${seq}.000Z`,
      updatedAt: NOW,
      ...rest,
    })
    .run();
  for (const ref of sources ?? []) {
    db.insert(schema.commitmentSources)
      .values({
        id: `s-${id}-${ref}`,
        commitmentId: id,
        messageId: null,
        sourceExternalRef: ref,
        conversationId: "c1",
        createdAt: NOW,
      })
      .run();
  }
  return id;
}

function propose(commitmentId: string, ref = "C1:1.0", n = 1): string {
  const id = `p${commitmentId}-${n}`;
  db.insert(schema.commitmentUpdates)
    .values({
      id,
      commitmentId,
      actor: "ai",
      field: "status",
      fromValue: "open",
      toValue: "completed",
      reason: `proposed:${ref}`,
      createdAt: NOW,
    })
    .run();
  return id;
}

const row = (id: string) =>
  db.select().from(schema.commitments).where(eq(schema.commitments.id, id)).get();
const updates = (id: string) =>
  db
    .select()
    .from(schema.commitmentUpdates)
    .where(eq(schema.commitmentUpdates.commitmentId, id))
    .all();
const events = () => db.select().from(schema.domainEvents).all();
const ids = (f: Parameters<CommitmentLifecycle["listViews"]>[0]) =>
  lc.listViews(f).map((v) => v.id);

describe("review", () => {
  test("accept with edits records one user update per changed field and recomputes direction", () => {
    const id = seed({ reviewStatus: "pending_review", dueAt: null });
    lc.review(id, "accept", {
      description: "  Ship the fix  ",
      dueAt: "2026-11-07T09:00:00+01:00",
      owner: PRIYA,
      counterparty: SELF,
    });
    const r = row(id);
    expect(r).toMatchObject({
      reviewStatus: "accepted",
      description: "Ship the fix",
      dueAt: "2026-11-07T08:00:00.000Z",
      ownerSlackUserId: PRIYA,
      counterpartySlackUserId: SELF,
      direction: "theirs",
    });
    const ups = updates(id).map((u) => [u.actor, u.field, u.fromValue, u.toValue]);
    expect(ups).toContainEqual(["user", "description", expect.any(String), "Ship the fix"]);
    expect(ups).toContainEqual(["user", "due_at", null, "2026-11-07T08:00:00.000Z"]);
    expect(ups).toContainEqual(["user", "owner", SELF, PRIYA]);
    expect(ups).toContainEqual(["user", "counterparty", PRIYA, SELF]);
    expect(ups).toContainEqual(["user", "direction", "mine", "theirs"]);
    expect(ups.every((u) => u[0] === "user")).toBe(true);
    const ev = events().find((e) => e.type === "commitment.reviewed");
    expect(ev?.payload).toEqual({ commitmentId: id, reviewStatus: "accepted" });
  });

  test("accept without edits writes only the review_status decision row; unchanged values write none", () => {
    const id = seed({ reviewStatus: "pending_review" });
    lc.review(id, "accept", { counterparty: PRIYA });
    expect(updates(id).map((u) => [u.actor, u.field, u.fromValue, u.toValue, u.reason])).toEqual([
      ["user", "review_status", "pending_review", "accepted", null],
    ]);
  });

  test("reject records a review_status rejected row (never accepted)", () => {
    const id = seed({ reviewStatus: "pending_review" });
    lc.review(id, "reject");
    expect(updates(id).map((u) => [u.field, u.toValue])).toEqual([["review_status", "rejected"]]);
  });

  test("an offset dueAt is stored as UTC ISO", () => {
    const id = seed({ reviewStatus: "pending_review" });
    lc.review(id, "accept", { dueAt: "2026-11-07T09:00:00+01:00" });
    expect(row(id)?.dueAt).toBe("2026-11-07T08:00:00.000Z");
    expect(updates(id)[0]).toMatchObject({ field: "due_at", toValue: "2026-11-07T08:00:00.000Z" });
  });

  test("dueAt null clears the due date", () => {
    const id = seed({ reviewStatus: "pending_review", dueAt: "2026-11-09T00:00:00Z" });
    lc.review(id, "accept", { dueAt: null });
    expect(row(id)?.dueAt).toBeNull();
    expect(updates(id)[0]).toMatchObject({ field: "due_at", toValue: null });
  });

  test("reject sets review_status only and leaves status alone", () => {
    const id = seed({ reviewStatus: "pending_review" });
    lc.review(id, "reject");
    expect(row(id)).toMatchObject({ reviewStatus: "rejected", status: "open", closedAt: null });
    expect(events().find((e) => e.type === "commitment.reviewed")?.payload).toEqual({
      commitmentId: id,
      reviewStatus: "rejected",
    });
  });

  test("reviewing a non-pending commitment throws InvalidReview", () => {
    const acc = seed();
    const rej = seed({ reviewStatus: "rejected" });
    expect(() => lc.review(acc, "accept")).toThrow(InvalidReview);
    expect(() => lc.review(rej, "reject")).toThrow(InvalidReview);
    expect(() => lc.review("nope", "accept")).toThrow(UnknownCommitment);
  });

  test("a rejection with edits is refused", () => {
    const id = seed({ reviewStatus: "pending_review" });
    expect(() => lc.review(id, "reject", { description: "x" })).toThrow(InvalidReview);
    expect(row(id)?.reviewStatus).toBe("pending_review");
  });

  test.each([
    ["empty description", { description: "   " }],
    ["long description", { description: "x".repeat(501) }],
    ["date without offset", { dueAt: "2026-11-07T09:00:00" }],
    ["garbage date", { dueAt: "tomorrow" }],
    ["owner equals counterparty", { owner: SELF, counterparty: SELF }],
    ["bad owner id", { owner: "priya" }],
    ["bad counterparty id", { counterparty: "u123" }],
    ["neither side is the user", { owner: PRIYA, counterparty: OTHER }],
    ["owner not the user and counterparty cleared", { owner: PRIYA, counterparty: null }],
  ])("invalid edit (%s) changes nothing", (_n, edits) => {
    const id = seed({ reviewStatus: "pending_review" });
    expect(() => lc.review(id, "accept", edits)).toThrow(InvalidCommitmentEdit);
    expect(row(id)).toMatchObject({ reviewStatus: "pending_review" });
    expect(updates(id)).toHaveLength(0);
  });

  test("owner and counterparty edits are refused while the user identity is unknown", () => {
    settings.clear("slack.selfUserId");
    const id = seed({ reviewStatus: "pending_review" });
    expect(() => lc.review(id, "accept", { owner: SELF })).toThrow(InvalidCommitmentEdit);
  });
});

describe("setStatus", () => {
  const legal: [Status, Status][] = [
    ["open", "in_progress"],
    ["open", "blocked"],
    ["open", "completed"],
    ["open", "cancelled"],
    ["in_progress", "blocked"],
    ["in_progress", "completed"],
    ["in_progress", "cancelled"],
    ["blocked", "open"],
    ["blocked", "in_progress"],
    ["blocked", "cancelled"],
    ["blocked", "completed"],
  ];
  test.each(legal)("%s -> %s is allowed", (from, to) => {
    const id = seed({ status: from });
    lc.setStatus(id, to, "because");
    const r = row(id);
    expect(r?.status).toBe(to);
    expect(r?.closedAt !== null).toBe(to === "completed" || to === "cancelled");
    expect(updates(id)).toEqual([
      expect.objectContaining({
        actor: "user",
        field: "status",
        fromValue: from,
        toValue: to,
        reason: "because",
      }),
    ]);
    expect(events().find((e) => e.type === "commitment.status_changed")?.payload).toEqual({
      commitmentId: id,
      status: to,
    });
  });

  const illegal: [Status, Status][] = [
    ["open", "open"],
    ["in_progress", "open"],
    ["in_progress", "in_progress"],
    ["blocked", "blocked"],
    ["completed", "open"],
    ["completed", "cancelled"],
    ["cancelled", "open"],
    ["cancelled", "completed"],
  ];
  test.each(illegal)("%s -> %s throws and changes nothing", (from, to) => {
    const id = seed({ status: from });
    expect(() => lc.setStatus(id, to)).toThrow(InvalidCommitmentTransition);
    expect(row(id)?.status).toBe(from);
    expect(updates(id)).toHaveLength(0);
    expect(events().filter((e) => e.type === "commitment.status_changed")).toHaveLength(0);
  });

  test("only accepted commitments change status", () => {
    const p = seed({ reviewStatus: "pending_review" });
    const r = seed({ reviewStatus: "rejected" });
    expect(() => lc.setStatus(p, "in_progress")).toThrow(InvalidCommitmentTransition);
    expect(() => lc.setStatus(r, "cancelled")).toThrow(InvalidCommitmentTransition);
    expect(() => lc.setStatus("nope", "cancelled")).toThrow(UnknownCommitment);
  });
});

describe("confirmProposal", () => {
  test("accepting completes the commitment with the source ref as evidence", () => {
    const id = seed({ status: "in_progress" });
    const p = propose(id, "C1:55.0");
    lc.confirmProposal(p, true);
    expect(row(id)).toMatchObject({
      status: "completed",
      completionEvidence: "C1:55.0",
    });
    expect(row(id)?.closedAt).toBe(NOW);
    const user = updates(id).filter((u) => u.actor === "user");
    expect(user.find((u) => u.field === "status")).toMatchObject({
      fromValue: "in_progress",
      toValue: "completed",
    });
    expect(user.find((u) => u.field === "proposal")?.reason).toBe(`confirmed_proposal:${p}`);
    expect(events().find((e) => e.type === "commitment.status_changed")).toBeDefined();
  });

  test("rejecting records a decision row and leaves the commitment alone", () => {
    const id = seed();
    const p = propose(id);
    lc.confirmProposal(p, false);
    expect(row(id)).toMatchObject({ status: "open", closedAt: null });
    expect(updates(id).filter((u) => u.actor === "user")).toEqual([
      expect.objectContaining({ field: "proposal", reason: `rejected_proposal:${p}` }),
    ]);
    expect(lc.listViews("all")[0]?.proposals).toEqual([]);
  });

  test("a proposal cannot be decided twice", () => {
    const id = seed();
    const p = propose(id);
    lc.confirmProposal(p, false);
    expect(() => lc.confirmProposal(p, true)).toThrow(InvalidProposal);
    const q = propose(id, "C1:2.0", 2);
    lc.confirmProposal(q, true);
    expect(() => lc.confirmProposal(q, true)).toThrow(InvalidProposal);
  });

  test("only AI completion proposals qualify", () => {
    const id = seed();
    lc.setStatus(id, "blocked");
    const userRow = updates(id)[0];
    expect(() => lc.confirmProposal(userRow?.id ?? "", true)).toThrow(InvalidProposal);
    expect(() => lc.confirmProposal("nope", true)).toThrow(InvalidProposal);
  });

  test("rejecting a proposal on a closed commitment is allowed", () => {
    const id = seed({ status: "completed", closedAt: NOW });
    const p = propose(id);
    lc.confirmProposal(p, false);
    expect(row(id)?.status).toBe("completed");
    expect(() => lc.confirmProposal(p, false)).toThrow(InvalidProposal);
  });

  test("setStatus refuses a free-text reason using a decision prefix", () => {
    const id = seed();
    for (const reason of ["confirmed_proposal:x", "rejected_proposal:x"]) {
      expect(() => lc.setStatus(id, "blocked", reason)).toThrow(InvalidCommitmentEdit);
    }
    expect(row(id)?.status).toBe("open");
  });

  test("accepting on a cancelled commitment throws InvalidCommitmentTransition", () => {
    const id = seed({ status: "cancelled" });
    const p = propose(id);
    expect(() => lc.confirmProposal(p, true)).toThrow(InvalidCommitmentTransition);
    expect(row(id)).toMatchObject({ status: "cancelled", completionEvidence: null });
    expect(updates(id).filter((u) => u.actor === "user")).toHaveLength(0);
  });

  test("accepting on a commitment still pending review throws", () => {
    const id = seed({ reviewStatus: "pending_review" });
    const p = propose(id);
    expect(() => lc.confirmProposal(p, true)).toThrow(InvalidCommitmentTransition);
  });
});

describe("views", () => {
  const DAY = 86_400_000;
  const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

  test("filters", () => {
    seed({ id: "open" });
    const prog = seed({ id: "prog", status: "in_progress", direction: "theirs" });
    const blocked = seed({ id: "blocked", status: "blocked" });
    const overdue = seed({ id: "overdue", dueAt: at(-DAY) });
    const soon = seed({ id: "soon", dueAt: at(3_600_000) });
    seed({ id: "far", dueAt: at(3 * DAY) });
    const done = seed({ id: "done", status: "completed", dueAt: at(-DAY), closedAt: NOW });
    seed({ id: "pending", reviewStatus: "pending_review", dueAt: at(-DAY) });
    seed({ id: "rejected", reviewStatus: "rejected" });
    expect(ids("all").sort()).toEqual(
      ["open", "prog", "blocked", "overdue", "soon", "far", "done"].sort(),
    );
    expect(ids("mine").sort()).toEqual(["open", "blocked", "overdue", "soon", "far"].sort());
    expect(ids("theirs")).toEqual([prog]);
    expect(ids("in_progress")).toEqual([prog]);
    expect(ids("blocked")).toEqual([blocked]);
    expect(ids("open").sort()).toEqual(["open", "overdue", "soon", "far"].sort());
    expect(ids("overdue")).toEqual([overdue]);
    expect(ids("due_soon")).toEqual([soon]);
    expect(ids("closed")).toEqual([done]);
    expect(ids("review").sort()).toEqual(["pending", "rejected"]);
    for (const f of ["all", "mine", "theirs", "open", "overdue", "due_soon", "closed"] as const) {
      expect(ids(f)).not.toContain("rejected");
    }
  });

  test("boundaries: due now is due soon not overdue; now + dueSoonHours is included", () => {
    seed({ id: "now", dueAt: NOW });
    seed({ id: "edge", dueAt: at(24 * 3_600_000) });
    seed({ id: "past-edge", dueAt: at(24 * 3_600_000 + 1) });
    expect(ids("overdue")).toEqual([]);
    expect(ids("due_soon").sort()).toEqual(["edge", "now"]);
  });

  test("limit defaults to 200, clamps to 500, and applies after ordering", () => {
    for (let i = 0; i < 3; i++) seed({ id: `r${i}` });
    seed({ id: "late", dueAt: at(-DAY) });
    expect(lc.listViews("all", 2).map((v) => v.id)[0]).toBe("late");
    expect(lc.listViews("all", 2)).toHaveLength(2);
    expect(lc.listViews("all", 0)).toHaveLength(4);
    expect(lc.listViews("all", 100000)).toHaveLength(4);
  });

  test("due_soon follows the setting", () => {
    seed({ id: "far", dueAt: at(3 * DAY) });
    expect(ids("due_soon")).toEqual([]);
    settings.set("commitments.reminder.dueSoonHours", 96);
    expect(ids("due_soon")).toEqual(["far"]);
  });

  test("order: overdue first, then soonest due, then newest", () => {
    seed({ id: "none-old" });
    seed({ id: "none-new" });
    seed({ id: "later", dueAt: at(2 * DAY) });
    seed({ id: "sooner", dueAt: at(DAY) });
    seed({ id: "od2", dueAt: at(-DAY) });
    seed({ id: "od1", dueAt: at(-2 * DAY) });
    expect(ids("all")).toEqual(["od1", "od2", "sooner", "later", "none-new", "none-old"]);
  });

  test("view carries names, sources, followups and server-computed actions", () => {
    const id = seed({ sources: ["C1:1.0"] });
    db.insert(schema.followups)
      .values({
        id: "f1",
        commitmentId: id,
        origin: "stalled",
        conversationId: "C1",
        status: "draft",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const p = propose(id, "C1:9.0");
    const [v] = lc.listViews("all");
    expect(v).toMatchObject({
      id,
      ownerName: "Me",
      counterpartyName: "Priya",
      followups: [{ id: "f1", origin: "stalled", status: "draft" }],
      proposals: [{ updateId: p, sourceExternalRef: "C1:9.0" }],
      actions: ["start", "block", "complete", "cancel", "confirm_proposal"],
    });
  });

  test("actions by state", () => {
    seed({ id: "a", reviewStatus: "pending_review" });
    seed({ id: "b", reviewStatus: "rejected" });
    seed({ id: "c", status: "in_progress" });
    seed({ id: "d", status: "blocked" });
    seed({ id: "e", status: "completed" });
    const act = (f: "all" | "review") =>
      Object.fromEntries(lc.listViews(f).map((v) => [v.id, v.actions]));
    expect(act("review")).toEqual({ a: ["accept", "reject", "edit"], b: [] });
    const all = act("all");
    expect(all.c).toEqual(["block", "complete", "cancel"]);
    expect(all.d).toEqual(["unblock", "start", "complete", "cancel"]);
    expect(all.e).toEqual([]);
  });

  test("an expired or removed source keeps its ref; permalinks are http(s) only", () => {
    const id = seed({ sources: ["C1:1.0", "C1:2.0", "C1:3.0"] });
    const mk = (mid: string, text: string | null, permalink: string) =>
      db
        .insert(schema.slackMessages)
        .values({
          id: mid,
          conversationId: "c1",
          ts: mid,
          senderUserId: "su-priya",
          text,
          permalink,
          sentAt: NOW,
          collectedAt: NOW,
        })
        .run();
    mk("m-ok", "hello", "https://slack.example/p1");
    mk("m-exp", null, "https://slack.example/p2");
    db.update(schema.commitmentSources)
      .set({ messageId: "m-ok" })
      .where(eq(schema.commitmentSources.sourceExternalRef, "C1:1.0"))
      .run();
    db.update(schema.commitmentSources)
      .set({ messageId: "m-exp" })
      .where(eq(schema.commitmentSources.sourceExternalRef, "C1:2.0"))
      .run();
    const v = lc.listViews("all").find((x) => x.id === id);
    expect(v?.sources).toEqual([
      {
        sourceExternalRef: "C1:1.0",
        messageAvailable: true,
        permalink: "https://slack.example/p1",
      },
      { sourceExternalRef: "C1:2.0", messageAvailable: false, permalink: null },
      { sourceExternalRef: "C1:3.0", messageAvailable: false, permalink: null },
    ]);
    mk("m-js", "hi", "javascript:alert(1)");
    db.update(schema.commitmentSources)
      .set({ messageId: "m-js" })
      .where(eq(schema.commitmentSources.sourceExternalRef, "C1:3.0"))
      .run();
    const v2 = lc.listViews("all").find((x) => x.id === id);
    expect(v2?.sources[2]).toMatchObject({ messageAvailable: true, permalink: null });
  });

  test("events and audit never carry commitment text", () => {
    const id = seed({ reviewStatus: "pending_review" });
    lc.review(id, "accept", { description: "ZZZ-NEW-TEXT" });
    lc.setStatus(id, "completed", "done");
    const dump = JSON.stringify([events(), db.select().from(schema.auditEvents).all()]);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("ZZZ-NEW-TEXT");
  });
});
