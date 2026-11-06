import { type ErrorKind, type Job, JobError, retryDecision } from "@synapse/contracts";
import type { JobContext } from "../../core/jobs/worker";
import { enqueueJiraJob, JIRA_JOB } from "../../modules/jira-tracking/service";
import type { JiraJobDeps } from "./shared";

const CLOUD_ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const LOOKUP_FAILED = "jira cloud id lookup failed";

/**
 * Spec B4: one `getAccessibleAtlassianResources` run while enabled with no cloudId. Exactly one
 * site is stored and a sync queued. Zero or several park the job in NEEDS_ATTENTION with the reason
 * `no_sites` / `multiple_sites`; the user then sets `jira.cloudId` by hand. Nothing is guessed.
 */
export function resolveCloudIdHandler(deps: JiraJobDeps) {
  const { db, clock, settings, sync, queue, source } = deps;
  const record = (kind: ErrorKind, message: string) =>
    db.transaction((tx) => sync.update(tx, "jira.issues", { lastError: { kind, message } }), {
      behavior: "immediate",
    });

  return async (_job: Job, ctx: JobContext) => {
    if (!settings.get("jira.enabled")) return { skipped: "disabled" };
    if (settings.get("jira.cloudId") !== null) return { skipped: "already_set" };
    let sites: { id: string }[];
    try {
      sites = await source.resolveCloudId(ctx.signal);
    } catch (err) {
      const e =
        err instanceof JobError ? err : new JobError({ kind: "unknown", message: LOOKUP_FAILED });
      // Pauses (quota, auth) are not failures (R53).
      if (retryDecision(e.classified.kind) !== "defer") record(e.classified.kind, LOOKUP_FAILED);
      throw e;
    }
    const [only] = sites;
    if (sites.length !== 1 || !only) {
      const reason = sites.length === 0 ? "no_sites" : "multiple_sites";
      record("needs_attention", reason);
      throw new JobError({ kind: "needs_attention", message: reason });
    }
    if (!CLOUD_ID_RE.test(only.id)) {
      record("parse_failed", LOOKUP_FAILED);
      throw new JobError({ kind: "parse_failed", message: "jira cloud id not recognised" });
    }
    db.transaction(
      (tx) => {
        settings.setIn(tx, "jira.cloudId", only.id);
        sync.update(tx, "jira.issues", { lastError: null });
        enqueueJiraJob(tx, queue, clock, JIRA_JOB.sync, "cloud_id");
      },
      { behavior: "immediate" },
    );
    return { stored: true };
  };
}
