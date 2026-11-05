import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AIProvider, MessageSink } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";

const NOW = "2026-11-06T12:00:00.000Z";
const SELF = "USELF00001";
const THEM = "UTHEM00001";
const REASON = "You messaged this person";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const sink: MessageSink = {
  send: async () => {
    throw new Error("must not send");
  },
  findSent: async () => null,
};

let c: Container;
let logs: string[];
const realError = console.error;

beforeEach(() => {
  logs = [];
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
    sink,
  });
  c.settings.set("slack.selfUserId", SELF);
  c.db
    .insert(schema.slackConversations)
    .values({ id: "c1", externalId: "C0SYNTH01", type: "im" })
    .run();
});
afterEach(() => {
  console.error = realError;
  c.sqlite.close();
});

function followup(recipient: string | null): string {
  const id = newId();
  c.db
    .insert(schema.followups)
    .values({
      id,
      origin: "stalled",
      conversationId: "c1",
      recipientSlackUserId: recipient,
      draftText: "text",
      status: "sent",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return id;
}

function sent(followupId: string): void {
  c.db.transaction((tx) =>
    c.events.publish(tx, {
      type: "followup.sent",
      aggregateType: "followup",
      aggregateId: followupId,
      correlationId: newId(),
      payload: { followupId, outgoingId: "o1" },
    }),
  );
  c.dispatcher.dispatchOnce();
}

const suggestions = () =>
  c.db
    .select()
    .from(schema.peopleProfileRecommendations)
    .where(eq(schema.peopleProfileRecommendations.kind, "suggest_evaluation"))
    .all();

describe("people.post_send", () => {
  test("a send to someone without a profile stores one suggestion", () => {
    c.db.insert(schema.slackUsers).values({ id: "u1", externalId: THEM, name: "Grace" }).run();
    sent(followup(THEM));
    const rows = suggestions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: REASON, status: "pending" });
    // A second send does not duplicate the pending suggestion.
    sent(followup(THEM));
    expect(suggestions()).toHaveLength(1);
  });

  test("a recipient who already has a profile gets none", () => {
    c.db.insert(schema.slackUsers).values({ id: "u1", externalId: THEM, name: "Grace" }).run();
    const personId = c.db.transaction((tx) => c.people.ensurePerson(tx, THEM));
    c.db
      .insert(schema.peopleProfiles)
      .values({
        id: newId(),
        personId,
        currentVersion: 1,
        content: { professionalContext: [], communication: [], responseGuidelines: [] },
        updatedAt: NOW,
      })
      .run();
    sent(followup(THEM));
    expect(suggestions()).toHaveLength(0);
  });

  test("self, a bot and a missing recipient are skipped without creating a person", () => {
    c.db.insert(schema.slackUsers).values({ id: "u1", externalId: THEM, isBot: true }).run();
    sent(followup(SELF));
    sent(followup(THEM));
    sent(followup(null));
    expect(suggestions()).toHaveLength(0);
    expect(c.db.select().from(schema.people).all()).toHaveLength(0);
  });

  test("an existing pending recommendation is not duplicated", () => {
    c.db.insert(schema.slackUsers).values({ id: "u1", externalId: THEM }).run();
    const personId = c.db.transaction((tx) => c.people.ensurePerson(tx, THEM));
    c.db
      .insert(schema.peopleProfileRecommendations)
      .values({
        id: newId(),
        personId,
        kind: "suggest_evaluation",
        reason: "earlier",
        status: "pending",
        createdAt: NOW,
      })
      .run();
    sent(followup(THEM));
    expect(suggestions()).toHaveLength(1);
  });

  test("a failing suggestion never throws and logs ids only", () => {
    c.db.insert(schema.slackUsers).values({ id: "u1", externalId: THEM }).run();
    const id = followup(THEM);
    c.db.run(
      `create trigger boom before insert on people_profile_recommendations begin select raise(abort, 'SECRET-TEXT'); end`,
    );
    expect(() => sent(id)).not.toThrow();
    expect(logs.join("\n")).toContain(id);
    expect(logs.join("\n")).not.toContain("SECRET-TEXT");
  });
});
