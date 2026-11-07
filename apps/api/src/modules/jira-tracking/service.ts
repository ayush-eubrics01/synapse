import type { JiraIssueView, JiraIssueViewKind, JiraStatusDto } from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { JobQueue } from "../../core/jobs/queue";
import type { SyncStateService } from "../inbox/sync-state";
import type { JiraStore } from "./store";

export const JIRA_JOB = {
  resolveCloudId: "jira.resolve_cloud_id",
  sync: "jira.sync_incremental",
  reconcile: "jira.reconcile",
  refreshAttention: "jira.refresh_attention",
} as const;
export type JiraJobType = (typeof JIRA_JOB)[keyof typeof JIRA_JOB];

/** Cloud-id problems the user fixes by hand (spec B4); shown as the status's `lastError`. */
export const CLOUD_ID_REASONS = ["multiple_sites", "no_sites"] as const;

/** `requestSync` while `jira.enabled` is false. The route maps it to 409. */
export class JiraDisabled extends Error {
  constructor() {
    super("jira is disabled");
    this.name = "JiraDisabled";
  }
}

/** `updateSettings` with a `cloudId` the stored candidate list does not offer. Mapped to 400. */
export class JiraUnknownSite extends Error {
  constructor() {
    super("unknown jira site");
    this.name = "JiraUnknownSite";
  }
}

export interface JiraSettingsPatch {
  cloudId?: string;
  enabled?: boolean;
  scopeJql?: string;
  excludedProjects?: string[];
}

export interface JiraServiceDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  sync: SyncStateService;
  store: JiraStore;
  queue: JobQueue;
  audit: AuditLogger;
}

const LIVE = ["PENDING", "RETRY", "RUNNING"] as const;

export class JiraService {
  constructor(private readonly deps: JiraServiceDeps) {}

  status(): JiraStatusDto {
    const { settings, sync, store } = this.deps;
    const issues = sync.get("jira.issues");
    const reconcile = sync.get("jira.reconcile");
    const err = issues.lastError ?? reconcile.lastError;
    return {
      enabled: settings.get("jira.enabled"),
      cloudIdSet: settings.get("jira.cloudId") !== null,
      lastSyncAt: issues.lastSuccessAt,
      lastReconcileAt: reconcile.lastSuccessAt,
      issueCount: store.inScopeCount(),
      // Kinds and fixed reasons only, never connector text.
      lastError:
        err === null
          ? null
          : err.kind === "needs_attention" &&
              (CLOUD_ID_REASONS as readonly string[]).includes(err.message)
            ? err.message
            : err.kind,
      scopeJql: settings.get("jira.scope.jql"),
      excludedProjects: settings.get("jira.excludedProjects"),
      sites: settings.get("jira.cloudId") === null ? settings.get("jira.cloudIdCandidates") : [],
    };
  }

  list(view: JiraIssueViewKind): JiraIssueView[] {
    return this.deps.store.list(view);
  }

  get(key: string): JiraIssueView | null {
    return this.deps.store.get(key);
  }

  /**
   * Queues an incremental sync now, or the cloudId lookup when none is set. A job of that type
   * already waiting or running is returned instead of a second one.
   */
  requestSync(): { jobId: string; type: JiraJobType; created: boolean } {
    const { db, settings } = this.deps;
    if (!settings.get("jira.enabled")) throw new JiraDisabled();
    return db.transaction(
      (tx) => {
        const type =
          settings.get("jira.cloudId") === null ? JIRA_JOB.resolveCloudId : JIRA_JOB.sync;
        return { type, ...this.enqueueOnce(tx, type, "manual") };
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Applies validated settings in one transaction (a bad value throws and nothing is written).
   * Turning Jira on queues the cloudId lookup, or a sync when the cloudId is known. A scope or
   * exclusion change resets the incremental checkpoint (the next sync takes the full window),
   * supersedes running chains, takes newly excluded projects out of scope and queues a reconcile.
   */
  updateSettings(patch: JiraSettingsPatch): JiraStatusDto {
    const { db, settings, sync, store, audit } = this.deps;
    db.transaction(
      (tx) => {
        const wasEnabled = settings.get("jira.enabled");
        const oldScope = settings.get("jira.scope.jql");
        const oldExcluded = settings.get("jira.excludedProjects");
        const oldCloudId = settings.get("jira.cloudId");
        const candidates = settings.get("jira.cloudIdCandidates");
        if (
          patch.cloudId !== undefined &&
          candidates.length > 0 &&
          !candidates.some((c) => c.id === patch.cloudId)
        ) {
          throw new JiraUnknownSite();
        }
        const siteChanged = patch.cloudId !== undefined && patch.cloudId !== oldCloudId;
        if (patch.cloudId !== undefined && siteChanged) {
          settings.setIn(tx, "jira.cloudId", patch.cloudId);
          settings.setIn(tx, "jira.cloudIdCandidates", [], { emit: false });
          sync.update(tx, "jira.issues", { lastError: null });
          // Keys only: a site name is never audited.
          audit.record(tx, {
            actor: "user",
            module: "jira",
            action: "settings.updated",
            result: "ok",
            details: { keys: ["jira.cloudId"] },
          });
        }
        if (patch.enabled !== undefined) settings.setIn(tx, "jira.enabled", patch.enabled);
        if (patch.scopeJql !== undefined) settings.setIn(tx, "jira.scope.jql", patch.scopeJql);
        if (patch.excludedProjects !== undefined) {
          settings.setIn(tx, "jira.excludedProjects", patch.excludedProjects);
        }
        const enabled = patch.enabled ?? wasEnabled;
        const scopeChanged = patch.scopeJql !== undefined && patch.scopeJql !== oldScope;
        const excluded = patch.excludedProjects ?? oldExcluded;
        const excludedChanged =
          patch.excludedProjects !== undefined &&
          JSON.stringify([...excluded].sort()) !== JSON.stringify([...oldExcluded].sort());
        const hasCloudId = settings.get("jira.cloudId") !== null;

        const scopeReset = scopeChanged || excludedChanged || (siteChanged && oldCloudId !== null);
        if (scopeReset) {
          sync.update(tx, "jira.issues", { checkpoint: null, generation: newId(), status: "idle" });
          sync.update(tx, "jira.reconcile", { generation: newId(), status: "idle" });
          if (excludedChanged) store.dropExcluded(tx, excluded);
          if (enabled && hasCloudId) this.enqueueOnce(tx, JIRA_JOB.reconcile, "settings", true);
        }
        if (siteChanged && enabled && wasEnabled) {
          this.enqueueOnce(tx, JIRA_JOB.sync, "site");
          if (sync.get("jira.issues", tx).checkpoint === null) {
            this.enqueueOnce(tx, JIRA_JOB.reconcile, "site");
          }
        }
        if (enabled && !wasEnabled) {
          if (hasCloudId) {
            this.enqueueOnce(tx, JIRA_JOB.sync, "enabled");
            // No checkpoint yet: a full reconcile settles every stored issue's scope flag.
            if (sync.get("jira.issues", tx).checkpoint === null) {
              this.enqueueOnce(tx, JIRA_JOB.reconcile, "enabled");
            }
          } else {
            this.enqueueOnce(tx, JIRA_JOB.resolveCloudId, "enabled");
          }
        }
      },
      { behavior: "immediate" },
    );
    return this.status();
  }

  private enqueueOnce(tx: Tx, type: JiraJobType, trigger: string, fresh = false) {
    return enqueueJiraJob(tx, this.deps.queue, this.deps.clock, type, trigger, fresh);
  }
}

/**
 * Enqueues `type` unless one is already pending or running (that job is returned). `fresh` is for
 * a reconcile that must run against a new scope: it cancels fresh jobs of that type still waiting
 * (PENDING or RETRY, null input: they have not started) and always enqueues a new one, so repeated
 * scope edits leave one waiting run. A running job or a continuation is superseded by its
 * generation instead.
 */
export function enqueueJiraJob(
  tx: Tx,
  queue: JobQueue,
  clock: Clock,
  type: JiraJobType,
  trigger: string,
  fresh = false,
): { jobId: string; created: boolean } {
  if (fresh) {
    tx.update(schema.jobs)
      .set({ status: "CANCELLED", finishedAt: isoNow(clock) })
      .where(
        and(
          eq(schema.jobs.type, type),
          inArray(schema.jobs.status, ["PENDING", "RETRY"]),
          isNull(schema.jobs.input),
        ),
      )
      .run();
  } else {
    const live = tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, type), inArray(schema.jobs.status, [...LIVE])))
      .limit(1)
      .get();
    if (live) return { jobId: live.id, created: false };
  }
  const r = queue.enqueue(tx, {
    type,
    idempotencyKey: `${type}:${trigger}:${isoNow(clock)}:${newId()}`,
  });
  return { jobId: r.id, created: r.created };
}
