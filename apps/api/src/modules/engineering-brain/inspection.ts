import { realpathSync } from "node:fs";
import {
  type FactKind,
  INSPECTION_MAX_FACTS,
  isSafeAbsolutePath,
  type RawToolResult,
  type RepositoryProvider,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import type { RawInspection } from "../../intelligence/brain/inspect-prompt";
import { type DropReason, normaliseFactContent, observedPaths, verifyFacts } from "./evidence";

const { repositories, projectRepositories, projectFacts, jobs } = schema;
const MODULE = "engineering-brain";

export const INSPECT_JOB = "brain.inspect_repository";
export const INSPECT_WEEKLY_JOB = "brain.inspect_weekly";
/** C6 idempotency key. A repository with no commit yet uses `none`. */
export const inspectKey = (repoId: string, headSha: string | null) =>
  `brain.inspect:${repoId}:${headSha ?? "none"}`;

const LIVE = ["PENDING", "RETRY", "RUNNING"] as const;
/** Statuses that block a new proposal with the same kind and normalised content (C9). */
const DEDUPE_STATUSES = ["approved", "rejected", "needs_review"] as const;

export type RequestInspectionResult =
  | { status: "enqueued"; jobId: string }
  | { status: "already_queued"; jobId: string }
  | { status: "not_found" };

export interface InspectionTarget {
  repositoryId: string;
  name: string;
  localPath: string;
  projectId: string;
  headSha: string | null;
}

export type PrepareResult =
  | { ok: true; target: InspectionTarget }
  | { ok: false; reason: "not_found" | "no_project" | "path_unavailable" };

export interface InspectionSummary {
  proposed: number;
  inserted: number;
  duplicates: number;
  unknowns: number;
  dropped: Partial<Record<DropReason, number>>;
}

export interface WeeklySummary {
  checked: number;
  enqueued: number;
  skipped: number;
  failed: number;
}

export interface InspectionServiceDeps {
  db: Db;
  clock: Clock;
  queue: Pick<JobQueue, "enqueue">;
  events: Pick<EventPublisher, "publish">;
  audit: Pick<AuditLogger, "record">;
  provider: RepositoryProvider;
}

/**
 * Repository inspection bookkeeping (C6, C9): when to inspect, and what to keep from a run.
 * Fact text is never logged; audit rows and events carry ids and counts only.
 */
export class InspectionService {
  constructor(private readonly deps: InspectionServiceDeps) {}

  /**
   * "Inspect now" (C12). Reports a queued or running inspection of the repository instead of
   * adding another. Otherwise enqueues one at the stored head; when that head was already
   * inspected (its key is taken by a finished job), a fresh key forces a new run.
   */
  requestInspection(repoId: string): RequestInspectionResult {
    return this.deps.db.transaction(
      (tx) => {
        const repo = tx
          .select({ id: repositories.id, headSha: repositories.headSha })
          .from(repositories)
          .where(eq(repositories.id, repoId))
          .get();
        if (!repo) return { status: "not_found" as const };
        const live = this.liveJob(tx, repoId);
        if (live) return { status: "already_queued" as const, jobId: live };
        const key = inspectKey(repoId, repo.headSha);
        const first = this.enqueue(tx, repoId, key);
        if (first.created) return { status: "enqueued" as const, jobId: first.id };
        const forced = this.enqueue(tx, repoId, `${key}:manual:${newId()}`);
        return { status: "enqueued" as const, jobId: forced.id };
      },
      { behavior: "immediate" },
    );
  }

  /**
   * `repo.registered` consumer: the first inspection, at the head seen on registration, unless an
   * inspection of the repository is already queued or running.
   */
  onRegistered(tx: DbOrTx, repoId: string): void {
    const repo = tx
      .select({ headSha: repositories.headSha })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .get();
    if (!repo) return; // unregistered before the event was dispatched
    if (this.liveJob(tx, repoId)) return;
    this.enqueue(tx, repoId, inspectKey(repoId, repo.headSha));
  }

  /**
   * Weekly (C6): reads each repository's current HEAD, stores it as `head_sha`, and enqueues an
   * inspection when it differs from `inspected_head_sha` and none is queued or running. A
   * repository whose stored drift says the path is missing, or whose inspection fails now, is
   * skipped. Never changes the registry
   * otherwise.
   */
  async weeklyCheck(): Promise<WeeklySummary> {
    const { db, provider } = this.deps;
    const summary: WeeklySummary = { checked: 0, enqueued: 0, skipped: 0, failed: 0 };
    for (const repo of db.select().from(repositories).all()) {
      summary.checked++;
      if (repo.drift?.pathMissing) {
        summary.skipped++;
        continue;
      }
      const r = await provider.inspect(repo.localPath);
      if (!r.ok) {
        summary.failed++;
        continue;
      }
      const head = r.inspection.headSha;
      const enqueued = db.transaction(
        (tx) => {
          const current = tx
            .select({ inspected: repositories.inspectedHeadSha, head: repositories.headSha })
            .from(repositories)
            .where(eq(repositories.id, repo.id))
            .get();
          if (!current) return false; // unregistered while git ran
          if (current.head !== head) {
            tx.update(repositories)
              .set({ headSha: head })
              .where(eq(repositories.id, repo.id))
              .run();
          }
          if (head === null || head === current.inspected) return false;
          if (this.liveJob(tx, repo.id)) return false;
          return this.enqueue(tx, repo.id, inspectKey(repo.id, head)).created;
        },
        { behavior: "immediate" },
      );
      if (enqueued) summary.enqueued++;
    }
    return summary;
  }

  /**
   * What an inspection run needs, or why it must not run: the repository is gone, has no project,
   * or its registered path no longer resolves to itself as a git top level.
   */
  async prepare(repoId: string): Promise<PrepareResult> {
    const { db, provider } = this.deps;
    const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
    if (!repo) return { ok: false, reason: "not_found" };
    const link = db
      .select({ projectId: projectRepositories.projectId })
      .from(projectRepositories)
      .where(eq(projectRepositories.repositoryId, repoId))
      .get();
    if (!link) return { ok: false, reason: "no_project" };
    if (!isSafeAbsolutePath(repo.localPath) || realpathOrNull(repo.localPath) !== repo.localPath) {
      return { ok: false, reason: "path_unavailable" };
    }
    const r = await provider.inspect(repo.localPath);
    if (!r.ok || r.inspection.topLevel !== repo.localPath) {
      return { ok: false, reason: "path_unavailable" };
    }
    return {
      ok: true,
      target: {
        repositoryId: repo.id,
        name: repo.name,
        localPath: repo.localPath,
        projectId: link.projectId,
        headSha: r.inspection.headSha,
      },
    };
  }

  /**
   * Verifies the run's facts against the repository and against the run's own tool results
   * (evidence the run never observed is dropped; ADR-026), inserts the survivors as `needs_review`
   * (skipping any whose kind and normalised content match an approved, rejected or pending fact of
   * the project), at most 40, sets `inspected_head_sha` and publishes `brain.facts_proposed`.
   * Approved facts are never touched (C9). One transaction, which first re-checks that the
   * repository is still registered and linked to the project: if not, nothing is written.
   */
  record(input: {
    target: InspectionTarget;
    output: RawInspection;
    claudeRunId: string | null;
    permissionDenials: readonly string[];
    /** The run's raw tool results: the only record of what it actually read. */
    toolResults: readonly RawToolResult[];
  }): InspectionSummary | { skipped: "unregistered" } {
    const { db, clock, events, audit } = this.deps;
    const { target, output } = input;
    const verified = verifyFacts(
      target.localPath,
      output.facts,
      observedPaths(target.localPath, input.toolResults),
    );
    const kept = verified.kept.slice(0, INSPECTION_MAX_FACTS);
    return db.transaction(
      (tx) => {
        const linked = tx
          .select({ id: projectRepositories.repositoryId })
          .from(projectRepositories)
          .innerJoin(repositories, eq(repositories.id, projectRepositories.repositoryId))
          .where(
            and(
              eq(projectRepositories.repositoryId, target.repositoryId),
              eq(projectRepositories.projectId, target.projectId),
            ),
          )
          .get();
        if (!linked) return { skipped: "unregistered" as const };
        const seen = new Set(
          tx
            .select({ kind: projectFacts.kind, content: projectFacts.content })
            .from(projectFacts)
            .where(
              and(
                eq(projectFacts.projectId, target.projectId),
                inArray(projectFacts.status, [...DEDUPE_STATUSES]),
              ),
            )
            .all()
            .map((f) => dedupeKey(f.kind, f.content)),
        );
        const now = isoNow(clock);
        let inserted = 0;
        let duplicates = 0;
        for (const f of kept) {
          const key = dedupeKey(f.kind, f.content);
          if (seen.has(key)) {
            duplicates++;
            continue;
          }
          seen.add(key);
          tx.insert(projectFacts)
            .values({
              id: newId(),
              projectId: target.projectId,
              kind: f.kind,
              content: f.content,
              evidence: f.evidence,
              status: "needs_review",
              source: "inspection",
              claudeRunId: input.claudeRunId,
              supersedesId: null,
              headSha: target.headSha,
              createdAt: now,
              decidedAt: null,
            })
            .run();
          inserted++;
        }
        tx.update(repositories)
          .set({
            inspectedHeadSha: target.headSha,
            inspectionWarning: input.permissionDenials.length > 0 ? "permission_denied" : null,
          })
          .where(eq(repositories.id, target.repositoryId))
          .run();
        const summary: InspectionSummary = {
          proposed: output.facts.length,
          inserted,
          duplicates,
          unknowns: output.unknowns.length,
          dropped: verified.dropped,
        };
        audit.record(tx, {
          actor: "system",
          module: MODULE,
          action: "brain.inspected",
          workerProfile: "engineering",
          targetRef: target.repositoryId,
          result: "ok",
          details: {
            repositoryId: target.repositoryId,
            projectId: target.projectId,
            ...summary,
            // Tool names only: a denial means the run tried to step outside its scope.
            permissionDenials: [...new Set(input.permissionDenials)].sort(),
          },
        });
        if (inserted > 0) {
          events.publish(tx, {
            type: "brain.facts_proposed",
            aggregateType: "project",
            aggregateId: target.projectId,
            correlationId: newId(),
            payload: { projectId: target.projectId, count: inserted },
          });
        }
        return summary;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * A run that stopped (max turns, timeout) or failed: audited with the repository id and the
   * kind only.
   */
  recordFailure(repositoryId: string, kind: string): void {
    this.deps.db.transaction((tx) => {
      this.deps.audit.record(tx, {
        actor: "system",
        module: MODULE,
        action: "brain.inspect_failed",
        workerProfile: "engineering",
        targetRef: repositoryId,
        result: "failed",
        details: { repositoryId, kind },
      });
    });
  }

  /** One attempt only: an inspection is an expensive run, and a retry rarely fixes it. */
  private enqueue(tx: DbOrTx, repoId: string, key: string) {
    return this.deps.queue.enqueue(tx, {
      type: INSPECT_JOB,
      input: { repositoryId: repoId },
      idempotencyKey: key,
      maxAttempts: 1,
    });
  }

  private liveJob(tx: DbOrTx, repoId: string): string | null {
    const row = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, INSPECT_JOB),
          inArray(jobs.status, [...LIVE]),
          sql`json_extract(${jobs.input}, '$.repositoryId') = ${repoId}`,
        ),
      )
      .limit(1)
      .get();
    return row?.id ?? null;
  }
}

function dedupeKey(kind: FactKind, content: string): string {
  return `${kind}\u0000${normaliseFactContent(content)}`;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
