/**
 * R59: incremental collection overlaps the checkpoint by slack.collection.indexLagSeconds, so a
 * message Slack's search index returns late is still accepted; dedup absorbs the overlap.
 * Real SlackConnectorSource + InboxStore + handler; the orchestrator is a fake that answers the
 * exact arguments it was asked for (the source still checks them).
 */
import { beforeEach, expect, test } from "bun:test";
import type { AIExecutionResult, ClaudeJobRequest, Job, SourceMessage } from "@synapse/contracts";
import { openDatabase, runMigrations } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { SEARCH, SlackConnectorSource } from "../../src/integrations/slack/connector-source";
import { InboxStore } from "../../src/modules/inbox/store";
import { SyncStateService } from "../../src/modules/inbox/sync-state";
import { registerSlackJobs } from "../../src/workers/slack";

const NOW = "2026-11-05T10:05:00.000Z"; // 1793873100
const CHECKPOINT = "1793872910.000400";
const STORED = "1793872900.000300"; // inside the overlap, already stored
const LATE = "1793872905.000000"; // inside the overlap, indexed late, not yet stored
const NEW = "1793872950.000000"; // after the checkpoint
const TOO_OLD = "1793872600.000000"; // before checkpoint - 300 s

let db: ReturnType<typeof openDatabase>["db"];
let sync: SyncStateService;
let settings: SettingsService;
let store: InboxStore;
let handlers: Map<string, HandlerRegistration>;
let seen: ClaudeJobRequest[];

const searchBody = (tss: string[]): string => {
  const blocks = tss
    .map(
      (ts, i) =>
        `### Result ${i + 1} of ${tss.length}\nChannel: DM (ID: D0SYNTHDM01)\nFrom: P <p@example.com> (ID: U0SYNTH0001) \nTime: 2026-11-05 15:31:24 IST\nMessage_ts: ${ts}\nPermalink: [link](https://e.slack.com/archives/D0SYNTHDM01/p1)\nText: \nhello\n\n---\n`,
    )
    .join("\n");
  return JSON.stringify({
    results: `# Search Results for: q\n\n## Messages (${tss.length} results)\n${blocks}`,
    pagination_info: "End of results - No more pages available.\n",
  });
};

const answer = (req: ClaudeJobRequest, content: string): AIExecutionResult => ({
  status: "succeeded",
  // The instructions carry the exact argument JSON on their second line.
  toolResults: [
    {
      toolUseId: "t1",
      toolName: SEARCH,
      input: JSON.parse(req.instructions.split("\n")[1] ?? "{}"),
      isError: false,
      content,
    },
  ],
  finalText: "DONE",
  numTurns: 1,
  durationMs: 1,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsdEquivalent: 0,
  },
  permissionDenials: [],
  connectors: [],
  availableTools: [],
  exitCode: 0,
});

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  const clock = new FakeClock(NOW);
  sync = new SyncStateService(db, clock);
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  const queue = new JobQueue(db, clock);
  store = new InboxStore({ db, clock, events, queue, sync });
  seen = [];
  const body = searchBody([TOO_OLD, STORED, LATE, NEW]);
  const source = new SlackConnectorSource({
    orchestrator: {
      run: async (req) => {
        seen.push(req);
        return answer(req, body);
      },
    },
    clock,
  });
  handlers = new Map();
  registerSlackJobs({
    db,
    clock,
    source,
    store,
    sync,
    queue,
    settings,
    events,
    audit: new AuditLogger(clock),
    scheduler: new SchedulerService(db, clock, queue),
    handlers,
  });
  const stored: SourceMessage = {
    externalId: `D0SYNTHDM01:${STORED}`,
    conversationId: "D0SYNTHDM01",
    conversationType: "im",
    ts: STORED,
    senderId: "U0SYNTH0001",
    text: "hello",
    sentAt: new Date(Number(STORED) * 1000).toISOString(),
  };
  store.persistPage("slack.messages", { messages: [stored], rejected: 0 });
  db.transaction((tx) => sync.update(tx, "slack.messages", { checkpoint: CHECKPOINT }));
});

const runIncremental = () =>
  handlers.get("slack.collect_incremental")?.handler(
    { id: undefined, type: "slack.collect_incremental", input: null } as unknown as Job,
    {
      signal: new AbortController().signal,
      checkpoint() {},
      getCheckpoint: () => undefined,
    } as never,
  );

test("R59: overlap message is accepted and deduplicated; checkpoint never moves back", async () => {
  const out = await runIncremental();
  const args = JSON.parse(seen[0]?.instructions.split("\n")[1] ?? "{}");
  expect(args.after).toBe(String(1793872910 - 300));
  expect(out).toMatchObject({ inserted: 2, duplicates: 1, rejected: 1 });
  expect(sync.get("slack.messages").checkpoint).toBe(NEW);
});

test("R59: the lag is a setting; 0 restores the exact checkpoint bound", async () => {
  settings.set("slack.collection.indexLagSeconds", 0);
  const out = await runIncremental();
  const args = JSON.parse(seen[0]?.instructions.split("\n")[1] ?? "{}");
  expect(args.after).toBe("1793872910");
  expect(out).toMatchObject({ inserted: 1, duplicates: 0, rejected: 3 });
});
