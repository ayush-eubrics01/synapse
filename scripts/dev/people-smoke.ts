import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Job, JobError } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";
import { NoopDesktopNotifier } from "../../apps/api/src/infrastructure/notifier";
import { SlackConnectorSource } from "../../apps/api/src/integrations/slack/connector-source";

export const USAGE = `Usage: bun scripts/dev/people-smoke.ts [--pages N] [--self Uxxxx]

Runs ONE real incremental Slack collection (after = now - 30 days) through Claude on a
temporary database, ranks contacts without AI, then runs the people.generate_initial_profile
handler ONCE for the top candidate (at most one real Claude run, model haiku) and prints
counts only. Spends a little Claude quota and reads real Slack; run deliberately. Never
prints message text, names, ids, observation text or reasons. The temporary database is
deleted afterwards. No desktop notification is shown.

  --pages N     pages to collect, 1..3 (default 1)
  --self Uxxxx  your Slack user id; otherwise the identity suggestion is used. With neither,
                the script prints "identity: none" and exits 0 after the collection counts.`;

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

const SECTIONS = ["professionalContext", "communication", "responseGuidelines"] as const;

/** Inputs may carry content (ids, names, observation text); only the listed fields are read. */
export interface SmokeInput {
  messages: number;
  candidates: number;
  /** "none": no usable identity, so no profile run happened. */
  identity: "set" | "none";
  history: number;
  dropped: number;
  /** Recommendation content (observation text lives here); only array lengths are read. */
  content: Record<string, unknown> | null;
  evidenceRows: number;
  recommendation: boolean;
  collect: "ok" | "error";
  /** "none": no job ran. */
  run: string;
  errorKind?: string;
  [extra: string]: unknown;
}

const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** Counts only. Names, ids, text, observation text and reasons never reach the output. */
export function summarize(o: SmokeInput): string[] {
  const lines = [`messages: ${o.messages}`, `candidates: ${o.candidates}`];
  if (o.identity === "none") {
    lines.push("identity: none");
    lines.push(`run: collect=${o.collect}${o.errorKind ? ` (${o.errorKind})` : ""}`);
    return lines;
  }
  const bySection = SECTIONS.map((s) => `${s}=${len(o.content?.[s])}`).join(" ");
  lines.push(
    `history items: ${o.history}`,
    `observations: ${bySection}`,
    `observations dropped: ${o.dropped}`,
    `evidence rows: ${o.evidenceRows}`,
    `recommendation created: ${o.recommendation ? "yes" : "no"}`,
    `run: collect=${o.collect} initial=${o.run}${o.errorKind ? ` (${o.errorKind})` : ""}`,
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
  const dir = mkdtempSync(join(tmpdir(), "synapse-people-smoke-"));
  const onSignal = (code: number) => () => {
    cleanupDir(dir);
    process.exit(code);
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  let sqlite: { close(): void } | undefined;
  const out: SmokeInput = {
    messages: 0,
    candidates: 0,
    identity: "none",
    history: 0,
    dropped: 0,
    content: null,
    evidenceRows: 0,
    recommendation: false,
    collect: "ok",
    run: "none",
  };
  try {
    const config = { ...loadConfig(process.env), dbPath: join(dir, "smoke.db") };
    // No-op desktop notifier: the smoke run must never pop real notifications naming senders.
    const c = createContainer(config, { notifier: new NoopDesktopNotifier() });
    sqlite = c.sqlite;
    // Quota: the initial profile run uses haiku here.
    c.settings.set("people.models.initial", "haiku");
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
    // Outbox consumers (screening, temporary contacts) run now instead of on the dispatcher timer.
    const drain = () => {
      for (let i = 0; i < 100; i++) {
        const d = c.dispatcher.dispatchOnce(500);
        if (d.delivered + d.failed === 0) break;
      }
    };
    drain();
    out.messages = c.db
      .select({ id: schema.slackMessages.id })
      .from(schema.slackMessages)
      .all().length;

    const self = args.self ?? c.people.suggestSelfUserId();
    if (self) {
      c.settings.set("slack.selfUserId", self);
      out.identity = "set";
    }
    out.candidates = self ? c.discovery.listContactCandidates({ limit: 50 }).length : 0;
    const top = self ? c.discovery.listContactCandidates({ limit: 1 })[0] : undefined;
    if (!self || !top) {
      for (const line of summarize(out)) console.log(line);
      return out.collect === "ok" ? 0 : 1;
    }

    c.profiles.requestInitialProfile(top.slackUserId);
    const pending = c.queue
      .list({ status: "PENDING" })
      .find((j): j is Job => j.type === "people.generate_initial_profile");
    const reg = c.handlers.get("people.generate_initial_profile");
    out.run = "none";
    if (pending && reg) {
      try {
        const result = (await reg.handler(pending, {
          signal: new AbortController().signal,
          checkpoint: () => {},
          getCheckpoint: () => undefined,
        })) as { history?: number; dropped?: number } | undefined;
        out.run = "ok";
        out.history = result?.history ?? 0;
        out.dropped = result?.dropped ?? 0;
      } catch (e) {
        out.run = "error";
        out.errorKind ??= e instanceof JobError ? e.classified.kind : "unknown";
      }
    }
    const rec = c.db
      .select({
        id: schema.peopleProfileRecommendations.id,
        content: schema.peopleProfileRecommendations.content,
        kind: schema.peopleProfileRecommendations.kind,
      })
      .from(schema.peopleProfileRecommendations)
      .all()
      .find((r) => r.kind === "initial");
    out.recommendation = rec !== undefined;
    out.content = (rec?.content as Record<string, unknown> | null | undefined) ?? null;
    out.evidenceRows = c.db
      .select({ id: schema.peopleProfileEvidence.id })
      .from(schema.peopleProfileEvidence)
      .all().length;
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
