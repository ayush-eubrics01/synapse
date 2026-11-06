import {
  allBranchNames,
  type RepositoryDrift,
  type RepositoryInspectResult,
  type RepositoryProvider,
} from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import type { EventPublisher } from "../../core/events/publisher";
import type { NotificationService } from "../../core/notifications/notifications";

const { repositories, repositoryEnvironments } = schema;

export const DRIFT_NOTIFICATION_KIND = "repo.drift";

export type DriftFindings = Omit<RepositoryDrift, "detectedAt">;

export interface DriftBaseline {
  trackedBranch: string;
  originUrl: string | null;
  upstreamUrl: string | null;
  upstreamPushDisabled: boolean;
  environmentBranches: readonly string[];
}

/**
 * C5: compares what git reports with the registered values. Returns null when nothing drifted,
 * or `undefined` when git failed (the stored drift is then left as it is). Pure.
 */
export function computeDrift(
  base: DriftBaseline,
  result: RepositoryInspectResult,
): DriftFindings | null | undefined {
  if (!result.ok) {
    return result.reason === "git_failed" ? undefined : { pathMissing: true };
  }
  const i = result.inspection;
  const d: DriftFindings = {};
  if (i.currentBranch !== base.trackedBranch) d.offTrackedBranch = i.currentBranch ?? "HEAD";
  const present = new Set(allBranchNames(i));
  const missing = [...new Set(base.environmentBranches)].filter((b) => !present.has(b)).sort();
  if (missing.length > 0) d.missingEnvironmentBranches = missing;
  if (
    (i.remotes.origin?.fetch ?? null) !== base.originUrl ||
    (i.remotes.upstream?.fetch ?? null) !== base.upstreamUrl ||
    i.upstreamPushDisabled !== base.upstreamPushDisabled
  ) {
    d.remotesChanged = true;
  }
  return Object.keys(d).length > 0 ? d : null;
}

/** A drift's identity: everything except `detectedAt`, in a fixed key order. */
export function driftIdentity(d: DriftFindings | RepositoryDrift | null | undefined): string {
  if (!d) return "null";
  return JSON.stringify([
    d.offTrackedBranch ?? null,
    d.missingEnvironmentBranches ?? null,
    d.remotesChanged ?? null,
    d.pathMissing ?? null,
  ]);
}

export interface DriftCheckDeps {
  db: Db;
  clock: Clock;
  events: Pick<EventPublisher, "publish">;
  notifications: Pick<NotificationService, "notify">;
  provider: RepositoryProvider;
}

export interface DriftCheckSummary {
  checked: number;
  drifted: number;
  notified: number;
  failed: number;
}

/**
 * `brain.drift_check` (C5, ADR-035): reports drift and never updates the registry. Only the
 * `drift` column is written. A drift whose identity is new raises one in-app and desktop
 * notification (title only: "Repository drift: <name>") and publishes `repo.drift_detected`;
 * the same drift on later runs stays quiet, and a resolved drift is cleared.
 */
export class DriftCheck {
  constructor(private readonly deps: DriftCheckDeps) {}

  async run(): Promise<DriftCheckSummary> {
    const { db, clock, events, notifications, provider } = this.deps;
    const summary: DriftCheckSummary = { checked: 0, drifted: 0, notified: 0, failed: 0 };
    const repos = db.select().from(repositories).all();
    for (const repo of repos) {
      summary.checked++;
      const environmentBranches = db
        .select({ branch: repositoryEnvironments.branch })
        .from(repositoryEnvironments)
        .where(eq(repositoryEnvironments.repositoryId, repo.id))
        .all()
        .map((e) => e.branch);
      const findings = computeDrift(
        { ...repo, environmentBranches },
        await provider.inspect(repo.localPath),
      );
      if (findings === undefined) {
        summary.failed++;
        continue;
      }
      db.transaction(
        (tx) => {
          const current = tx.select().from(repositories).where(eq(repositories.id, repo.id)).get();
          if (!current) return; // unregistered while git ran
          if (findings) summary.drifted++;
          if (driftIdentity(findings) === driftIdentity(current.drift)) return;
          const drift: RepositoryDrift | null = findings
            ? { ...findings, detectedAt: isoNow(clock) }
            : null;
          tx.update(repositories).set({ drift }).where(eq(repositories.id, repo.id)).run();
          if (!drift) return;
          notifications.notify(tx, {
            kind: DRIFT_NOTIFICATION_KIND,
            severity: "warning",
            title: `Repository drift: ${current.name}`,
            ref: `repo:${repo.id}`,
          });
          events.publish(tx, {
            type: "repo.drift_detected",
            aggregateType: "repository",
            aggregateId: repo.id,
            correlationId: newId(),
            payload: { repositoryId: repo.id },
          });
          summary.notified++;
        },
        { behavior: "immediate" },
      );
    }
    return summary;
  }
}
