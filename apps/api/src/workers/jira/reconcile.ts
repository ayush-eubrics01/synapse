import { type Job, JobError } from "@synapse/contracts";
import { isoNow, newId } from "@synapse/shared";
import { z } from "zod";
import type { JobContext } from "../../core/jobs/worker";
import { reconcileJql } from "../../modules/jira-tracking/jql";
import { JIRA_JOB } from "../../modules/jira-tracking/service";
import { addTotals, gate, type JiraJobDeps, runPages } from "./shared";

const STREAM = "jira.reconcile";
const continuation = z
  .object({
    generation: z.string().min(1),
    startedAt: z.string().min(1),
    cloudId: z.string().min(1),
    jql: z.string().min(1),
    nextPageToken: z.string().min(1),
    page: z.number().int().positive(),
    /** Issue keys seen so far (keys only, no text). */
    seen: z.array(z.string().min(1)),
    totals: z.object({
      inserted: z.number().int().nonnegative(),
      duplicates: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
    }),
  })
  .strict();
type Continuation = z.infer<typeof continuation>;

/**
 * Spec B6: `jira.reconcile` runs the full scope JQL across every page (continuations carry the
 * token and the keys seen). Pages are stored without touching existing scope flags. If and only if
 * the last page completes under the current generation, seen issues go in scope and unseen ones
 * out; a failed or superseded run changes no flag.
 */
export function reconcileHandler(deps: JiraJobDeps) {
  const { db, clock, settings, sync, store, queue, events } = deps;

  return async (job: Job, ctx: JobContext) => {
    const g = gate(settings);
    if ("skipped" in g) return g;
    let state: Continuation;
    if (job.input === null || job.input === undefined) {
      state = db.transaction(
        (tx) => {
          const generation = newId();
          sync.update(tx, STREAM, { generation, status: "running" });
          return {
            generation,
            startedAt: isoNow(clock),
            cloudId: g.cloudId,
            jql: reconcileJql(
              settings.get("jira.scope.jql"),
              settings.get("jira.excludedProjects"),
            ),
            nextPageToken: "",
            page: 0,
            seen: [],
            totals: { inserted: 0, duplicates: 0, rejected: 0 },
          };
        },
        { behavior: "immediate" },
      );
    } else {
      const parsed = continuation.safeParse(job.input);
      if (!parsed.success) {
        throw new JobError({ kind: "invalid_input", message: "invalid jira reconcile input" });
      }
      state = parsed.data;
      if (sync.get(STREAM).generation !== state.generation) return { skipped: "superseded" };
    }

    const run = await runPages(deps, STREAM, {
      cloudId: state.cloudId,
      jql: state.jql,
      nextPageToken: state.nextPageToken === "" ? null : state.nextPageToken,
      maxPages: settings.get("jira.maxPagesPerRun"),
      setScope: false,
      signal: ctx.signal,
    });
    const page = state.page + run.pages;
    const seen = [...new Set([...state.seen, ...run.keys])];
    const sum = addTotals(state.totals, run.totals);

    return db.transaction(
      (tx) => {
        const cur = sync.get(STREAM, tx);
        if (cur.generation !== state.generation) return { pages: run.pages, superseded: true };
        if (run.nextPageToken !== null) {
          const next: Continuation = {
            ...state,
            nextPageToken: run.nextPageToken,
            page,
            seen,
            totals: sum,
          };
          queue.enqueue(tx, {
            type: JIRA_JOB.reconcile,
            input: next,
            idempotencyKey: `${JIRA_JOB.reconcile}:${state.generation}:${page}`,
          });
          return { pages: run.pages, complete: false };
        }
        const scope = store.markScope(seen, state.startedAt, tx);
        store.refreshAttention(tx);
        sync.update(tx, STREAM, { status: "idle", lastSuccessAt: isoNow(clock), lastError: null });
        events.publish(tx, {
          type: "collection.completed",
          aggregateType: "integration",
          aggregateId: STREAM,
          correlationId: STREAM,
          payload: { stream: STREAM, pages: page, ...sum },
        });
        return { pages: run.pages, complete: true, ...scope };
      },
      { behavior: "immediate" },
    );
  };
}
