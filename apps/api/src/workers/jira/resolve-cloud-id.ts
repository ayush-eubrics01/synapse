import { type ErrorKind, type Job, JobError, retryDecision } from "@synapse/contracts";
import type { JobContext } from "../../core/jobs/worker";
import { enqueueJiraJob, JIRA_JOB } from "../../modules/jira-tracking/service";
import type { JiraJobDeps } from "./shared";

const CLOUD_ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const MAX_CANDIDATES = 20;
const MAX_NAME = 200;
const LOOKUP_FAILED = "jira cloud id lookup failed";

/**
 * Spec B4: one `getAccessibleAtlassianResources` run while enabled with no cloudId. Exactly one
 * site is stored and a sync queued (plus a reconcile while there is no checkpoint). Zero or several park the job in NEEDS_ATTENTION with the reason
 * `no_sites` / `multiple_sites`; the candidates are stored and the user picks one in the Jira section. Nothing is guessed.
 */
export function resolveCloudIdHandler(deps: JiraJobDeps) {
  const { db, clock, settings, sync, queue, source } = deps;
  /** Re-reads the cloudId inside the transaction: a user's choice made meanwhile wins. */
  const park = (reason: string, candidates: { id: string; name: string }[]): boolean =>
    db.transaction(
      (tx) => {
        if (settings.get("jira.cloudId") !== null) return false;
        sync.update(tx, "jira.issues", { lastError: { kind: "needs_attention", message: reason } });
        settings.setIn(tx, "jira.cloudIdCandidates", candidates, { emit: false });
        return true;
      },
      { behavior: "immediate" },
    );
  const record = (kind: ErrorKind, message: string) =>
    db.transaction((tx) => sync.update(tx, "jira.issues", { lastError: { kind, message } }), {
      behavior: "immediate",
    });

  return async (_job: Job, ctx: JobContext) => {
    if (!settings.get("jira.enabled")) return { skipped: "disabled" };
    if (settings.get("jira.cloudId") !== null) return { skipped: "already_set" };
    let sites: { id: string; name: string }[];
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
      // Candidates come only from the resolver's parsed tool result (ADR-026); names are clipped.
      const candidates =
        sites.length === 0
          ? []
          : [...new Map(sites.filter((s) => CLOUD_ID_RE.test(s.id)).map((s) => [s.id, s])).values()]
              .slice(0, MAX_CANDIDATES)
              .map((s) => ({ id: s.id, name: s.name.slice(0, MAX_NAME) }));
      if (!park(reason, candidates)) return { skipped: "already_set" };
      throw new JobError({ kind: "needs_attention", message: reason });
    }
    if (!CLOUD_ID_RE.test(only.id)) {
      record("parse_failed", LOOKUP_FAILED);
      throw new JobError({ kind: "parse_failed", message: "jira cloud id not recognised" });
    }
    const stored = db.transaction(
      (tx) => {
        if (settings.get("jira.cloudId") !== null) return false;
        settings.setIn(tx, "jira.cloudId", only.id);
        settings.setIn(tx, "jira.cloudIdCandidates", [], { emit: false });
        sync.update(tx, "jira.issues", { lastError: null });
        enqueueJiraJob(tx, queue, clock, JIRA_JOB.sync, "cloud_id");
        // No checkpoint yet: a full reconcile settles every stored issue's scope flag.
        if (sync.get("jira.issues", tx).checkpoint === null) {
          enqueueJiraJob(tx, queue, clock, JIRA_JOB.reconcile, "cloud_id");
        }
        return true;
      },
      { behavior: "immediate" },
    );
    if (!stored) return { skipped: "already_set" };
    return { stored: true };
  };
}
