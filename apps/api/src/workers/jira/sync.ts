import { type Job, JobError } from "@synapse/contracts";
import { isoNow, newId } from "@synapse/shared";
import { z } from "zod";
import type { JobContext } from "../../core/jobs/worker";
import { incrementalJql, syncMinutes } from "../../modules/jira-tracking/jql";
import { JIRA_JOB } from "../../modules/jira-tracking/service";
import { addTotals, gate, type JiraJobDeps, maxIso, runPages } from "./shared";

const STREAM = "jira.issues";
const totals = z.object({
  inserted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});
/** A continuation carries the exact JQL and cloudId its token belongs to. */
const continuation = z
  .object({
    generation: z.string().min(1),
    cloudId: z.string().min(1),
    jql: z.string().min(1),
    nextPageToken: z.string().min(1),
    page: z.number().int().positive(),
    maxUpdated: z.string().nullable(),
    totals,
  })
  .strict();
type Continuation = z.infer<typeof continuation>;

/**
 * Spec B5: `jira.sync_incremental`. A fresh run computes the window from the checkpoint and opens
 * a new generation; pages run sequentially up to `maxPagesPerRun`, and a remainder is queued as a
 * continuation carrying `nextPageToken`. The checkpoint (max `updated` seen, never moving back) is
 * committed only after the last page, and only while the generation is current: a scope change or
 * a newer run supersedes the chain.
 */
export function syncHandler(deps: JiraJobDeps) {
  const { db, clock, settings, sync, store, queue, events } = deps;

  return async (job: Job, ctx: JobContext) => {
    const g = gate(settings);
    if ("skipped" in g) return g;
    let state: Continuation;
    if (job.input === null || job.input === undefined) {
      state = db.transaction(
        (tx) => {
          const cur = sync.get(STREAM, tx);
          const minutes = syncMinutes(cur.checkpoint, clock.now(), settings.get("jira.windowDays"));
          const generation = newId();
          sync.update(tx, STREAM, { generation, status: "running" });
          return {
            generation,
            cloudId: g.cloudId,
            jql: incrementalJql(
              settings.get("jira.scope.jql"),
              settings.get("jira.excludedProjects"),
              minutes,
            ),
            nextPageToken: "",
            page: 0,
            maxUpdated: null,
            totals: { inserted: 0, duplicates: 0, rejected: 0 },
          };
        },
        { behavior: "immediate" },
      );
    } else {
      const parsed = continuation.safeParse(job.input);
      if (!parsed.success) {
        throw new JobError({ kind: "invalid_input", message: "invalid jira sync input" });
      }
      state = parsed.data;
      if (sync.get(STREAM).generation !== state.generation) return { skipped: "superseded" };
    }

    const run = await runPages(deps, STREAM, {
      cloudId: state.cloudId,
      jql: state.jql,
      nextPageToken: state.nextPageToken === "" ? null : state.nextPageToken,
      maxPages: settings.get("jira.maxPagesPerRun"),
      setScope: true,
      signal: ctx.signal,
    });
    const page = state.page + run.pages;
    const maxUpdated = maxIso(state.maxUpdated, run.maxUpdated);
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
            maxUpdated,
            totals: sum,
          };
          queue.enqueue(tx, {
            type: JIRA_JOB.sync,
            input: next,
            idempotencyKey: `${JIRA_JOB.sync}:${state.generation}:${page}`,
          });
          return { pages: run.pages, complete: false };
        }
        sync.update(tx, STREAM, {
          checkpoint: maxIso(cur.checkpoint, maxUpdated),
          status: "idle",
          lastSuccessAt: isoNow(clock),
          lastError: null,
        });
        store.refreshAttention(tx);
        events.publish(tx, {
          type: "collection.completed",
          aggregateType: "integration",
          aggregateId: STREAM,
          correlationId: STREAM,
          payload: { stream: STREAM, pages: page, ...sum },
        });
        return { pages: run.pages, complete: true };
      },
      { behavior: "immediate" },
    );
  };
}
