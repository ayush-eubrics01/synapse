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

const classify = (stream: JiraStream, err: unknown): ClassifiedError =>
  err instanceof JobError ? err.classified : { kind: "unknown", message: FAILED[stream] };

/**
 * Records a failure on `stream`: `lastError` (kind and a fixed message), status `error` and
 * `collection.failed`. Pauses (quota, auth) are not failures: nothing is recorded (R53).
 */
function record(
  deps: Pick<JiraJobDeps, "db" | "sync" | "events">,
  stream: JiraStream,
  e: ClassifiedError,
): void {
  if (retryDecision(e.kind) === "defer") return;
  deps.db.transaction(
    (tx) => {
      deps.sync.update(tx, stream, {
        status: "error",
        lastError: { kind: e.kind, message: FAILED[stream] },
      });
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

/**
 * Records the failure on `stream` and rethrows. A non-JobError becomes `unknown` with the fixed
 * message, so no stray text reaches the job's stored error either.
 */
export function fail(
  deps: Pick<JiraJobDeps, "db" | "sync" | "events">,
  stream: JiraStream,
  err: unknown,
): never {
  const e = classify(stream, err);
  record(deps, stream, e);
  if (err instanceof JobError) throw err;
  throw new JobError(e);
}

/** A failure worth resuming from the last good page: it may pass on its own (retry or pause). */
const resumable = (e: ClassifiedError): boolean => {
  const d = retryDecision(e.kind);
  return d === "retry" || d === "defer";
};

export interface PageRun {
  pages: number;
  totals: Totals;
  keys: string[];
  maxUpdated: string | null;
  /** The token after the last stored page; set when more pages remain (or a resume is due). */
  nextPageToken: string | null;
  /** The chain's generation is no longer current: the caller must commit nothing. */
  superseded: boolean;
  /**
   * A resumable failure after at least one page of this run was stored. It is already recorded;
   * the caller queues a continuation from `nextPageToken` instead of restarting the chain.
   */
  failed: ClassifiedError | null;
}

/**
 * Fetches pages sequentially (one collector run each) up to `maxPages`, storing each as it
 * arrives. Before each store it checks the chain's generation and stops, storing nothing more,
 * once it is superseded. A failure records `lastError` on `stream`; pages already stored stay
 * (upserts are idempotent) and the caller commits nothing. A retryable failure after a stored
 * page returns `failed` (resume from the last good token); otherwise it rethrows.
 *
 * Bounds: a page whose next token equals the token that produced it, or a chain that would need
 * more than `jira.maxPagesPerChain` pages, fails as `parse_failed`. Neither is resumed.
 */
export async function runPages(
  deps: JiraJobDeps,
  stream: JiraStream,
  args: {
    generation: string;
    cloudId: string;
    jql: string;
    nextPageToken: string | null;
    /** Pages the chain stored before this run. */
    pagesSoFar: number;
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
    superseded: false,
    failed: null,
  };
  const maxResults = deps.settings.get("jira.pageSize");
  const maxChain = deps.settings.get("jira.maxPagesPerChain");
  const current = () => deps.sync.get(stream).generation === args.generation;
  do {
    const token = out.nextPageToken;
    let page: Awaited<ReturnType<JiraJobDeps["source"]["searchPage"]>>;
    try {
      page = await deps.source.searchPage(
        {
          cloudId: args.cloudId,
          jql: args.jql,
          maxResults,
          ...(token !== null ? { nextPageToken: token } : {}),
        },
        args.signal,
      );
    } catch (err) {
      // A superseded chain's failure is not the stream's failure.
      if (!current()) return { ...out, superseded: true };
      const e = classify(stream, err);
      if (out.pages > 0 && resumable(e)) {
        record(deps, stream, e);
        return { ...out, failed: e };
      }
      return fail(deps, stream, err);
    }
    if (!current()) return { ...out, superseded: true };
    if (page.nextPageToken !== null && page.nextPageToken === token) {
      return fail(
        deps,
        stream,
        new JobError({ kind: "parse_failed", message: "jira page token repeated" }),
      );
    }
    const r = deps.store.upsertPage(page.issues, { setScope: args.setScope });
    out.pages++;
    out.totals.inserted += r.inserted;
    out.totals.duplicates += r.updated + r.unchanged;
    out.totals.rejected += r.dropped;
    out.keys.push(...r.keys);
    out.maxUpdated = maxIso(out.maxUpdated, r.maxUpdated);
    out.nextPageToken = page.nextPageToken;
    if (out.nextPageToken !== null && args.pagesSoFar + out.pages >= maxChain) {
      return fail(
        deps,
        stream,
        new JobError({ kind: "parse_failed", message: "jira page chain too long" }),
      );
    }
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
