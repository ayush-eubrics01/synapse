import {
  type ClassifiedError,
  type JiraIssueSource,
  JobError,
  retryDecision,
} from "@synapse/contracts";
import type { Db } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import type { HandlerRegistration } from "../../core/jobs/worker";
import type { SchedulerService } from "../../core/scheduler/scheduler";
import type { SyncStateService } from "../../modules/inbox/sync-state";
import type { JiraStore } from "../../modules/jira-tracking/store";

export interface JiraJobDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  sync: SyncStateService;
  store: JiraStore;
  queue: JobQueue;
  events: EventPublisher;
  scheduler: SchedulerService;
  handlers: Map<string, HandlerRegistration>;
  source: JiraIssueSource;
}

export type JiraStream = "jira.issues" | "jira.reconcile";

/** Fixed messages: a stored `lastError` never carries connector or Jira text. */
const FAILED: Record<JiraStream, string> = {
  "jira.issues": "jira sync failed",
  "jira.reconcile": "jira reconcile failed",
};

export interface Totals {
  inserted: number;
  duplicates: number;
  rejected: number;
}

/** Runs only while enabled and, for sync and reconcile, once the cloudId is known. */
export function gate(settings: SettingsService): { skipped: string } | { cloudId: string } {
  if (!settings.get("jira.enabled")) return { skipped: "disabled" };
  const cloudId = settings.get("jira.cloudId");
  if (cloudId === null) return { skipped: "no_cloud_id" };
  return { cloudId };
}

/**
 * Records the failure on `stream` (kind and a fixed message) and rethrows. Pauses (quota, auth)
 * are not failures: nothing is recorded (R53). A non-JobError becomes `unknown` with the fixed
 * message, so no stray text reaches the job's stored error either.
 */
export function fail(
  deps: Pick<JiraJobDeps, "db" | "sync" | "events">,
  stream: JiraStream,
  err: unknown,
): never {
  const e: ClassifiedError =
    err instanceof JobError ? err.classified : { kind: "unknown", message: FAILED[stream] };
  if (retryDecision(e.kind) !== "defer") {
    deps.db.transaction(
      (tx) => {
        deps.sync.update(tx, stream, { lastError: { kind: e.kind, message: FAILED[stream] } });
        deps.events.publish(tx, {
          type: "collection.failed",
          aggregateType: "integration",
          aggregateId: stream,
          correlationId: stream,
          payload: { stream, kind: e.kind },
        });
      },
      { behavior: "immediate" },
    );
  }
  if (err instanceof JobError) throw err;
  throw new JobError(e);
}

export interface PageRun {
  pages: number;
  totals: Totals;
  keys: string[];
  maxUpdated: string | null;
  /** Set when more pages remain after this run's budget. */
  nextPageToken: string | null;
}

/**
 * Fetches pages sequentially (one collector run each) up to `maxPages`, storing each as it
 * arrives. A failure records `lastError` on `stream` and rethrows; pages already stored stay
 * (upserts are idempotent), and the caller commits nothing.
 */
export async function runPages(
  deps: JiraJobDeps,
  stream: JiraStream,
  args: {
    cloudId: string;
    jql: string;
    nextPageToken: string | null;
    maxPages: number;
    setScope: boolean;
    signal: AbortSignal;
  },
): Promise<PageRun> {
  const out: PageRun = {
    pages: 0,
    totals: { inserted: 0, duplicates: 0, rejected: 0 },
    keys: [],
    maxUpdated: null,
    nextPageToken: args.nextPageToken,
  };
  const maxResults = deps.settings.get("jira.pageSize");
  do {
    let page: Awaited<ReturnType<JiraJobDeps["source"]["searchPage"]>>;
    try {
      page = await deps.source.searchPage(
        {
          cloudId: args.cloudId,
          jql: args.jql,
          maxResults,
          ...(out.nextPageToken !== null ? { nextPageToken: out.nextPageToken } : {}),
        },
        args.signal,
      );
    } catch (err) {
      return fail(deps, stream, err);
    }
    const r = deps.store.upsertPage(page.issues, { setScope: args.setScope });
    out.pages++;
    out.totals.inserted += r.inserted;
    out.totals.duplicates += r.updated + r.unchanged;
    out.totals.rejected += r.dropped;
    out.keys.push(...r.keys);
    if (r.maxUpdated !== null && (out.maxUpdated === null || r.maxUpdated > out.maxUpdated)) {
      out.maxUpdated = r.maxUpdated;
    }
    out.nextPageToken = page.nextPageToken;
  } while (out.nextPageToken !== null && out.pages < args.maxPages);
  return out;
}

export const addTotals = (a: Totals, b: Totals): Totals => ({
  inserted: a.inserted + b.inserted,
  duplicates: a.duplicates + b.duplicates,
  rejected: a.rejected + b.rejected,
});

export const maxIso = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a > b ? a : b;
