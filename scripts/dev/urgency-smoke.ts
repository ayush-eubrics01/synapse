import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Job, JobError } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";
import { SlackConnectorSource } from "../../apps/api/src/integrations/slack/connector-source";

export const USAGE = `Usage: bun scripts/dev/urgency-smoke.ts [--pages N]

Runs ONE real incremental Slack collection (after = now - 1 day) through Claude on a
temporary database, lets rule screening run, then runs the urgency.assess handler ONCE
(at most one more real Claude run) and prints counts only. Suggested replies are never
generated. Spends a little Claude quota and reads real Slack; run deliberately. Never
prints message text, names, emails, conversation names, permalinks, excerpts or ids. The
temporary database is deleted afterwards. In-app notification rows stay in that database.

  --pages N   pages to collect, 1..3 (default 1)`;

export class UsageError extends Error {}

export function parseArgs(argv: string[]): { pages: number } {
  let pages = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    let raw: string | undefined;
    if (a === "--pages") {
      raw = argv[++i];
      if (raw === undefined) throw new UsageError("--pages needs a value");
    } else if (a.startsWith("--pages=")) raw = a.slice("--pages=".length);
    else throw new UsageError(`unknown argument: ${a}`);
    if (!/^\d+$/.test(raw)) throw new UsageError("--pages must be an integer 1..3");
    pages = Number(raw);
    if (pages < 1 || pages > 3) throw new UsageError("--pages must be an integer 1..3");
  }
  return { pages };
}

/** Removes the temp dir; used by the finally block and by the signal handlers. */
export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const LEVELS = ["critical", "high", "medium", "low"] as const;
const SEVERITIES = ["info", "warning", "high"] as const;

/** Rows may carry content (text, excerpts, ids); only the listed fields are ever read. */
export interface MessageRow {
  screening: unknown;
  urgencyLevel: string | null;
  [extra: string]: unknown;
}
export interface FlagRow {
  severity: string;
  [extra: string]: unknown;
}

export interface Counts {
  messages: number;
  screened: number;
  candidates: number;
  flags: Record<(typeof SEVERITIES)[number], number>;
  assessed: Record<(typeof LEVELS)[number], number>;
  fallbacks: number;
  drafts: number;
}

export function tally(messages: MessageRow[], flags: FlagRow[], drafts: number): Counts {
  const out: Counts = {
    messages: messages.length,
    screened: 0,
    candidates: 0,
    flags: { info: 0, warning: 0, high: 0 },
    assessed: { critical: 0, high: 0, medium: 0, low: 0 },
    fallbacks: 0,
    drafts,
  };
  for (const m of messages) {
    const s = m.screening as { candidate?: unknown; fallback?: unknown } | null;
    if (s) {
      out.screened++;
      if (s.candidate === true) out.candidates++;
      if (s.fallback === true) out.fallbacks++;
    }
    const lvl = m.urgencyLevel as (typeof LEVELS)[number] | null;
    if (lvl && lvl in out.assessed && !(s?.fallback === true)) out.assessed[lvl]++;
  }
  for (const f of flags) {
    const sev = f.severity as (typeof SEVERITIES)[number];
    if (sev in out.flags) out.flags[sev]++;
  }
  return out;
}

export interface SmokeOutcome {
  counts: Counts;
  collect: "ok" | "error";
  /** "none": no urgency.assess job was waiting, so no assessment run happened. */
  assess: "ok" | "error" | "none";
  errorKind?: string;
}

/** Counts only. Message text, names, emails, permalinks, excerpts and ids never reach the output. */
export function summarize(o: SmokeOutcome): string[] {
  const c = o.counts;
  return [
    `messages: ${c.messages}`,
    `screened: ${c.screened}`,
    `candidates: ${c.candidates}`,
    `flags: ${SEVERITIES.map((s) => `${s}=${c.flags[s]}`).join(" ")}`,
    `assessed: ${LEVELS.map((l) => `${l}=${c.assessed[l]}`).join(" ")}`,
    `fallback: ${c.fallbacks}`,
    `drafts: ${c.drafts}`,
    `run: collect=${o.collect} assess=${o.assess}${o.errorKind ? ` (${o.errorKind})` : ""}`,
  ];
}

async function main(): Promise<number> {
  let pages: number;
  try {
    ({ pages } = parseArgs(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  const dir = mkdtempSync(join(tmpdir(), "synapse-urgency-smoke-"));
  const onSignal = (code: number) => () => {
    cleanupDir(dir);
    process.exit(code);
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  let sqlite: { close(): void } | undefined;
  const outcome: SmokeOutcome = {
    counts: tally([], [], 0),
    collect: "ok",
    assess: "none",
  };
  try {
    const config = { ...loadConfig(process.env), dbPath: join(dir, "smoke.db") };
    // There is no desktop notifier: notifications are in-app rows in the temp database only.
    const c = createContainer(config);
    sqlite = c.sqlite;
    c.settings.set("urgency.maxAgeHours", 24);
    const source = new SlackConnectorSource({ orchestrator: c.orchestrator, clock: c.clock });
    const afterTs = String(Math.floor(c.clock.now().getTime() / 1000) - 86400);
    try {
      const r = await source.collect({ afterTs, maxPages: pages }, new AbortController().signal);
      for (const p of r.pages) c.inbox.persistPage("slack.messages", p);
    } catch (e) {
      outcome.collect = "error";
      outcome.errorKind = e instanceof JobError ? e.classified.kind : "unknown";
    }
    // Screening is an outbox consumer: drain it now instead of waiting for the dispatcher timer.
    for (let i = 0; i < 100; i++) {
      const d = c.dispatcher.dispatchOnce(500);
      if (d.delivered + d.failed === 0) break;
    }
    const pending = c.queue
      .list({ status: "PENDING" })
      .find((j): j is Job => j.type === "urgency.assess");
    const reg = c.handlers.get("urgency.assess");
    if (pending && reg) {
      try {
        await reg.handler(pending, {
          signal: new AbortController().signal,
          checkpoint: () => {},
          getCheckpoint: () => undefined,
        });
        outcome.assess = "ok";
      } catch (e) {
        outcome.assess = "error";
        outcome.errorKind ??= e instanceof JobError ? e.classified.kind : "unknown";
      }
    }
    const messages = c.db
      .select({
        screening: schema.slackMessages.screening,
        urgencyLevel: schema.slackMessages.urgencyLevel,
      })
      .from(schema.slackMessages)
      .all();
    const flags = c.db
      .select({ severity: schema.securityFlags.severity })
      .from(schema.securityFlags)
      .all();
    const drafts = c.db.select({ id: schema.messageDrafts.id }).from(schema.messageDrafts).all();
    outcome.counts = tally(messages, flags, drafts.length);
    for (const line of summarize(outcome)) console.log(line);
    return outcome.collect === "ok" && outcome.assess !== "error" ? 0 : 1;
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
