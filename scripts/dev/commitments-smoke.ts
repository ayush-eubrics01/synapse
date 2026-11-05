import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Job, JobError, type MessageSink } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { type Container, createContainer } from "../../apps/api/src/container";
import { type AppConfig, loadConfig } from "../../apps/api/src/core/config/config";
import { NoopDesktopNotifier } from "../../apps/api/src/infrastructure/notifier";
import { SlackConnectorSource } from "../../apps/api/src/integrations/slack/connector-source";

export const USAGE = `Usage: bun scripts/dev/commitments-smoke.ts [--pages N] [--self Uxxxx]

Runs ONE real incremental Slack collection (after = now - 30 days) on a temporary database,
then runs exactly ONE commitments.extract batch (at most one real Claude run, model haiku) and
prints counts only. Spends a little Claude quota and reads real Slack; run deliberately.
It NEVER sends: the container's message sink throws if it is called. Never prints message
text, names, ids, descriptions or reasons. The temporary database is deleted afterwards. No
desktop notification is shown.

  --pages N     pages to collect, 1..3 (default 1)
  --self Uxxxx  your Slack user id; otherwise the identity suggestion is used. With neither,
                the script prints "identity: none" and exits 0 after the collection count.`;

export class UsageError extends Error {}

export interface Args {
  pages: number;
  self: string | null;
}

export function parseArgs(argv: string[]): Args {
  let pages = 1;
  let self: string | null = null;
  const value = (a: string, name: string, i: number): [string, number] => {
    if (a === name) {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError(`${name} needs a value`);
      return [v, i + 1];
    }
    return [a.slice(name.length + 1), i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--pages" || a.startsWith("--pages=")) {
      let raw: string;
      [raw, i] = value(a, "--pages", i);
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 3) {
        throw new UsageError("--pages must be an integer 1..3");
      }
      pages = Number(raw);
    } else if (a === "--self" || a.startsWith("--self=")) {
      let raw: string;
      [raw, i] = value(a, "--self", i);
      if (!/^[UW][A-Z0-9]+$/.test(raw)) throw new UsageError("--self must be a Slack user id");
      self = raw;
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  return { pages, self };
}

/** Removes the temp dir; used by the finally block and by the signal handlers. */
export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** This script never sends: any call is a bug and fails loudly. */
export const throwingSink: MessageSink = {
  send: async () => {
    throw new Error("commitments-smoke must never send a message");
  },
  findSent: async () => {
    throw new Error("commitments-smoke must never look up a sent message");
  },
};

/** The container for the smoke run: no-op notifier and the throwing sink. */
export function createSmokeContainer(
  config: AppConfig,
  create: typeof createContainer = createContainer,
) {
  return create(config, { notifier: new NoopDesktopNotifier(), sink: throwingSink });
}

/** Inputs may carry content; only the listed numeric and enum fields are read. */
export interface SmokeInput {
  messages: number;
  eligible: number;
  candidates: number;
  dropped: number;
  created: number;
  mine: number;
  theirs: number;
  proposed: number;
  /** "none": no usable identity, so no extraction ran. */
  identity: "set" | "none";
  collect: "ok" | "error";
  /** "none": no job ran. */
  run: string;
  errorKind?: string;
  [extra: string]: unknown;
}

/** Counts only. Names, ids, text, descriptions and reasons never reach the output. */
export function summarize(o: SmokeInput): string[] {
  const lines = [`messages: ${o.messages}`];
  const status = (extra: string) =>
    `run: collect=${o.collect}${extra}${o.errorKind ? ` (${o.errorKind})` : ""}`;
  if (o.identity === "none") {
    lines.push("identity: none", status(""));
    return lines;
  }
  lines.push(
    `eligible: ${o.eligible}`,
    `candidates: ${o.candidates}`,
    `dropped: ${o.dropped}`,
    `commitments created: ${o.created} (mine=${o.mine} theirs=${o.theirs})`,
    `completion proposals: ${o.proposed}`,
    status(` extract=${o.run}`),
  );
  return lines;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  const dir = mkdtempSync(join(tmpdir(), "synapse-commitments-smoke-"));
  const onSignal = (code: number) => () => {
    cleanupDir(dir);
    process.exit(code);
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  let sqlite: { close(): void } | undefined;
  const out: SmokeInput = {
    messages: 0,
    eligible: 0,
    candidates: 0,
    dropped: 0,
    created: 0,
    mine: 0,
    theirs: 0,
    proposed: 0,
    identity: "none",
    collect: "ok",
    run: "none",
  };
  try {
    const config = { ...loadConfig(process.env), dbPath: join(dir, "smoke.db") };
    const c: Container = createSmokeContainer(config);
    sqlite = c.sqlite;
    // Quota: the extraction run uses haiku here.
    c.settings.set("commitments.models.extract", "haiku");
    const source = new SlackConnectorSource({ orchestrator: c.orchestrator, clock: c.clock });
    const afterTs = String(Math.floor(c.clock.now().getTime() / 1000) - 30 * 86400);
    try {
      const r = await source.collect(
        { afterTs, maxPages: args.pages },
        new AbortController().signal,
      );
      for (const p of r.pages) c.inbox.persistPage("slack.messages", p);
    } catch (e) {
      out.collect = "error";
      out.errorKind = e instanceof JobError ? e.classified.kind : "unknown";
    }
    out.messages = c.db
      .select({ id: schema.slackMessages.id })
      .from(schema.slackMessages)
      .all().length;

    // The identity first, then the outbox: the extraction queue needs it to enqueue.
    const self = args.self ?? c.people.suggestSelfUserId();
    if (self) {
      c.settings.set("slack.selfUserId", self);
      out.identity = "set";
    }
    for (let i = 0; i < 100; i++) {
      const d = c.dispatcher.dispatchOnce(500);
      if (d.delivered + d.failed === 0) break;
    }
    if (!self) {
      for (const line of summarize(out)) console.log(line);
      return out.collect === "ok" ? 0 : 1;
    }

    // Exactly one batch: the real PENDING job, run through the registered handler.
    const pending = c.queue
      .list({ status: "PENDING" })
      .find((j): j is Job => j.type === "commitments.extract");
    const reg = c.handlers.get("commitments.extract");
    if (pending && reg) {
      try {
        const result = (await reg.handler(pending, {
          signal: new AbortController().signal,
          checkpoint: () => {},
          getCheckpoint: () => undefined,
        })) as
          | {
              messages?: number;
              candidates?: number;
              dropped?: number;
              created?: number;
              proposed?: number;
            }
          | undefined;
        out.run = "ok";
        out.eligible = result?.messages ?? 0;
        out.candidates = result?.candidates ?? 0;
        out.dropped = result?.dropped ?? 0;
        out.created = result?.created ?? 0;
        out.proposed = result?.proposed ?? 0;
      } catch (e) {
        out.run = "error";
        out.errorKind ??= e instanceof JobError ? e.classified.kind : "unknown";
      }
    }
    const rows = c.db
      .select({ direction: schema.commitments.direction })
      .from(schema.commitments)
      .all();
    out.mine = rows.filter((r) => r.direction === "mine").length;
    out.theirs = rows.filter((r) => r.direction === "theirs").length;
    for (const line of summarize(out)) console.log(line);
    return out.collect === "ok" && out.run !== "error" ? 0 : 1;
  } finally {
    sqlite?.close();
    cleanupDir(dir);
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`smoke failed: ${e instanceof Error ? e.constructor.name : "error"}`);
      process.exit(1);
    },
  );
}
