/**
 * Away-mode auto-reply end to end: urgent message -> evaluate job -> policy-approved send ->
 * approval.execute -> the REAL SlackSender, ClaudeOrchestrator and ClaudeCliProvider, with a fake
 * `claude` binary (never the real one, never a real send). The fake asserts that the run received
 * the J2 PreToolUse guard in `--settings`; the real hook script is not executed, so the
 * after-the-fact argument check is what catches a differing send (second case).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { schema } from "@synapse/database";
import { FakeClock, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { ClaudeCliProvider } from "../../src/integrations/claude-code/cli-provider";
import { sendInputSha256 } from "../../src/integrations/claude-code/send-guard-canonical";
import { ACK_TEXT, withAutoReplyTag } from "../../src/modules/auto-reply/policy";

const fakeClaude = resolve(import.meta.dir, "../fixtures/away-fake-claude.ts");
const tmp = mkdtempSync(join(tmpdir(), "away-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = "2026-11-06T12:00:00.000Z";
const SELF = "USELF00001";
const ADA = "UADA000001";
const CHANNEL = "C0CHAN0001";
const TS = "1793880000.000100";
const SECRET_INCOMING = "SECRET-INCOMING the deploy is failing";

let c: Container | undefined;
afterEach(() => c?.sqlite.close());

function build(mode: "ok" | "altered") {
  const id = `${mode}-${newId()}`;
  const creds = join(tmp, `creds-${id}.json`);
  writeFileSync(
    creds,
    JSON.stringify({
      claudeAiOauth: { expiresAt: Date.parse(NOW) + 3_600_000, refreshTokenExpiresAt: 1.9e12 },
    }),
  );
  const files = {
    argv: join(tmp, `argv-${id}.json`),
    errors: join(tmp, `errors-${id}.txt`),
    spawns: join(tmp, `spawns-${id}.txt`),
  };
  writeFileSync(files.spawns, "");
  const clock = new FakeClock(NOW);
  const provider = new ClaudeCliProvider({
    binary: process.execPath,
    prefixArgs: ["run", fakeClaude],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      FAKE_AWAY_MODE: mode,
      FAKE_AWAY_ARGV: files.argv,
      FAKE_AWAY_ERRORS: files.errors,
      FAKE_AWAY_SPAWNS: files.spawns,
    },
    clock,
    killGraceMs: 200,
  });
  const container = createContainer(
    loadConfig({ SYNAPSE_DB_PATH: ":memory:", SYNAPSE_CLAUDE_CREDENTIALS: creds }),
    { run: async () => "Linger=yes", provider, clock },
  );
  c = container;
  const { db } = container;
  container.settings.set("slack.selfUserId", SELF);
  db.insert(schema.slackUsers)
    .values([
      { id: "u-self", externalId: SELF, name: "Me" },
      { id: "u-ada", externalId: ADA, name: "Ada" },
    ])
    .run();
  db.insert(schema.slackConversations)
    .values({ id: "c-ch", externalId: CHANNEL, type: "channel", name: "eng" })
    .run();
  db.insert(schema.slackMessages)
    .values({
      id: "m1",
      conversationId: "c-ch",
      ts: TS,
      senderUserId: "u-ada",
      text: SECRET_INCOMING,
      sentAt: NOW,
      collectedAt: NOW,
    })
    .run();
  container.people.setPriority(ADA, { priority: "high" });
  container.autoReply.setAway(true);
  container.db.transaction((tx) =>
    container.events.publish(tx, {
      type: "message.urgent_detected",
      aggregateType: "message",
      aggregateId: "m1",
      correlationId: newId(),
      payload: { messageId: "m1", level: "high", assessed: true },
    }),
  );
  return { c: container, files };
}

/** evaluate, then the approval's execute job: the dispatcher hands events to the queue in between. */
async function drain(container: Container): Promise<void> {
  for (let i = 0; i < 8; i++) {
    container.dispatcher.dispatchOnce();
    if (!(await container.worker.runOnce())) {
      container.dispatcher.dispatchOnce();
      if (!(await container.worker.runOnce())) return;
    }
  }
}

const events = (container: Container, type: string) =>
  container.db.select().from(schema.domainEvents).where(eq(schema.domainEvents.type, type)).all();

const noText = (container: Container) => {
  const dump = JSON.stringify([
    container.db.select().from(schema.auditEvents).all(),
    container.db.select().from(schema.domainEvents).all(),
    container.db.select().from(schema.jobs).all(),
    container.db.select().from(schema.claudeRuns).all(),
  ]);
  expect(dump).not.toContain("SECRET-INCOMING");
  expect(dump).not.toContain(ACK_TEXT);
};

describe("away auto-reply through the real provider", () => {
  test("happy path: guarded send, sent_unverified, autoreply.sent once", async () => {
    const { c: container, files } = build("ok");
    await drain(container);

    const approved = {
      channel_id: CHANNEL,
      message: withAutoReplyTag(ACK_TEXT),
      thread_ts: TS,
    };
    const args = JSON.parse(readFileSync(files.argv, "utf8")) as string[];
    const settings = JSON.parse(args[args.indexOf("--settings") + 1] as string);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("mcp__claude_ai_Slack__slack_send_message");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(sendInputSha256(approved));
    // the fake's own assertions (matcher, sha256, approved arguments) recorded no error
    expect(existsSync(files.errors)).toBe(false);
    expect(readFileSync(files.spawns, "utf8")).toBe("x");

    const out = container.db.select().from(schema.outgoingMessages).all();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "sent_unverified", text: approved.message });
    const ar = container.db.select().from(schema.autoReplies).all();
    expect(ar).toHaveLength(1);
    expect(ar[0]).toMatchObject({ decision: "sent", outgoingId: out[0]?.id });
    expect(events(container, "autoreply.sent")).toHaveLength(1);
    expect(events(container, "autoreply.held")).toHaveLength(0);
    noText(container);
  });

  test("a different send text: needs_attention/argument_mismatch, needs attention, never re-sent", async () => {
    const { c: container, files } = build("altered");
    await drain(container);

    expect(existsSync(files.errors)).toBe(false);
    const out = container.db.select().from(schema.outgoingMessages).all();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "needs_attention", failure: "argument_mismatch" });
    expect(events(container, "autoreply.sent")).toHaveLength(0);
    expect(readFileSync(files.spawns, "utf8")).toBe("x");
    // draining again must not spawn a second send
    await drain(container);
    expect(readFileSync(files.spawns, "utf8")).toBe("x");
    noText(container);
  });
});
