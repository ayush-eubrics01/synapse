// Real end-to-end send check: one approved send to YOUR OWN Slack DM through the full path
// (requestSend -> approve -> engine.execute -> SlackSender), then delivery verification with the
// real findSent. Spends a little Claude quota and posts one message to yourself. Temp DB, deleted
// afterwards; prints statuses and counts only.
//
//   bun scripts/dev/send-smoke.ts --self U0XXXXXXXX
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@synapse/database";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";
import { NoopDesktopNotifier } from "../../apps/api/src/infrastructure/notifier";
import { SlackConnectorSource } from "../../apps/api/src/integrations/slack/connector-source";
import { SlackSender } from "../../apps/api/src/integrations/slack/sender";

export function parseSelf(argv: string[]): string {
  const i = argv.indexOf("--self");
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!v || !/^[UW][A-Z0-9]+$/.test(v)) {
    throw new Error("usage: bun scripts/dev/send-smoke.ts --self U0XXXXXXXX");
  }
  return v;
}

if (import.meta.main) await main(parseSelf(process.argv.slice(2)));

async function main(SELF: string): Promise<void> {
  const TEXT = "Synapse test send (approved path) — https://example.com/?a=1&b=2 & done";

  const dir = mkdtempSync(join(tmpdir(), "synapse-send-smoke-"));
  try {
    const config = { ...loadConfig(process.env), dbPath: join(dir, "t.db") };
    const c = createContainer(config, { notifier: new NoopDesktopNotifier() });
    c.settings.set("slack.selfUserId", SELF);
    const now = c.clock.now().toISOString();
    const followupId = "fu-testsend";
    c.db
      .insert(schema.followups)
      .values({
        id: followupId,
        origin: "manual",
        conversationId: "self-dm",
        status: "awaiting_approval",
        draftText: TEXT,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const { outgoingId, approvalId } = c.db.transaction((tx) =>
      c.outgoing.requestSend(tx, {
        followupId,
        conversationExternalId: SELF,
        threadTs: null,
        text: TEXT,
        requestedByModule: "dev",
      }),
    );
    c.approvals.approve(approvalId);
    const outcome = await c.approvals.execute(approvalId, AbortSignal.timeout(300_000));
    const row = c.sqlite
      .query("select status, failure, sending_at as sendingAt from outgoing_messages where id = ?")
      .get(outgoingId) as {
      status: string;
      failure: string | null;
      sendingAt: string | null;
    } | null;
    console.log(`execute: ${outcome.status}`);
    console.log(`outgoing: ${row?.status}${row?.failure ? ` (${row.failure})` : ""}`);

    // Verification: the self-DM's conversation id is a D… id, not the user id, so try findSent
    // against each conversation the user posted in since the send (ids are never printed).
    const sinceTs = (Date.parse(row?.sendingAt ?? now) / 1000 - 5).toFixed(6);
    const source = new SlackConnectorSource({ orchestrator: c.orchestrator, clock: c.clock });
    const sink = new SlackSender({
      orchestrator: c.orchestrator,
      searchSource: source,
      selfUserId: () => SELF,
    });
    for (const waitS of [45, 90]) {
      await Bun.sleep(waitS * 1000);
      const res = await source.collect(
        { afterTs: sinceTs, maxPages: 2, queryTerms: [`from:<@${SELF}>`] },
        AbortSignal.timeout(300_000),
      );
      const convs = new Set(res.pages.flatMap((p) => p.messages.map((m) => m.conversationId)));
      let verified = false;
      for (const conv of convs) {
        const r = await sink.findSent(
          { outgoingId, approvalId, conversationExternalId: conv, text: TEXT },
          sinceTs,
        );
        if (r === true) verified = true;
      }
      console.log(
        `after ${waitS}s wait: own messages found=${res.pages.reduce((n, p) => n + p.messages.length, 0)} conversations=${convs.size} verified=${verified}`,
      );
      if (verified) break;
    }
    c.sqlite.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
