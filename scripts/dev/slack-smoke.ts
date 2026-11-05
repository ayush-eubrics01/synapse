import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobError, type MessagePage } from "@synapse/contracts";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";
import { SlackConnectorSource } from "../../apps/api/src/integrations/slack/connector-source";

export const USAGE = `Usage: bun scripts/dev/slack-smoke.ts [--pages N]

Runs ONE real incremental Slack collection (after = now - 1 day) through Claude on a
temporary database, persists the pages, and prints counts only. Spends a little Claude
quota and reads real Slack; run deliberately. Never prints message text, names, emails,
conversation names, permalinks or ids. The temporary database is deleted afterwards.

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

export interface SmokeOutcome {
  pages: MessagePage[];
  persisted: { inserted: number; duplicates: number; threadFetches: number }[];
  searches: number;
  status: "ok" | "error";
  errorKind?: string;
}

/** Counts only. Message text, names, emails, permalinks and ids never reach the output. */
export function summarize(o: SmokeOutcome): string[] {
  const seen = new Map<string, string>();
  for (const p of o.pages)
    for (const m of p.messages) seen.set(m.conversationId, m.conversationType);
  const by = { channel: 0, im: 0, mpim: 0 };
  for (const t of seen.values()) by[t as keyof typeof by]++;
  const sum = (f: (x: SmokeOutcome["persisted"][number]) => number) =>
    o.persisted.reduce((n, x) => n + f(x), 0);
  return [
    `pages: ${o.pages.length}`,
    `inserted: ${sum((x) => x.inserted)}`,
    `duplicates: ${sum((x) => x.duplicates)}`,
    `rejected: ${o.pages.reduce((n, p) => n + p.rejected, 0)}`,
    `conversations: channel=${by.channel} im=${by.im} mpim=${by.mpim}`,
    `threadsEnqueued: ${sum((x) => x.threadFetches)}`,
    `searches: ${o.searches}`,
    `run: ${o.status}${o.errorKind ? ` (${o.errorKind})` : ""}`,
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
  const dir = mkdtempSync(join(tmpdir(), "synapse-slack-smoke-"));
  const config = { ...loadConfig(process.env), dbPath: join(dir, "smoke.db") };
  const c = createContainer(config);
  const outcome: SmokeOutcome = { pages: [], persisted: [], searches: 0, status: "ok" };
  try {
    const source = new SlackConnectorSource({ orchestrator: c.orchestrator, clock: c.clock });
    const afterTs = String(Math.floor(c.clock.now().getTime() / 1000) - 86400);
    try {
      const r = await source.collect({ afterTs, maxPages: pages }, new AbortController().signal);
      outcome.pages = r.pages;
      outcome.searches = r.searches;
      for (const p of r.pages) outcome.persisted.push(c.inbox.persistPage("slack.messages", p));
    } catch (e) {
      outcome.status = "error";
      outcome.errorKind = e instanceof JobError ? e.classified.kind : "unknown";
    }
    for (const line of summarize(outcome)) console.log(line);
    return outcome.status === "ok" ? 0 : 1;
  } finally {
    c.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
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
