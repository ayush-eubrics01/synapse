import {
  allBranchNames,
  type EnvironmentInput,
  type EnvironmentView,
  environmentCandidates,
  type PathRefusalReason,
  type RepositoryDrift,
  type RepositoryInspectFailure,
  type RepositoryInspection,
  type RepositoryProposal,
  type RepositoryProvider,
  type RepositoryRegisterInput,
  type RepositoryUpdateInput,
  type RepositoryView,
  repositoryInspectInputSchema,
  repositoryRegisterInputSchema,
  repositoryUpdateInputSchema,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, asc, eq, notInArray } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { EventPublisher } from "../../core/events/publisher";
import { computeDrift, type DriftFindings } from "./drift";

const { repositories, repositoryEnvironments, projects, projectRepositories, engineeringTasks } =
  schema;
/** Engineering task statuses after which a task no longer needs its repository (M4). */
const FINISHED_TASK_STATUSES = ["completed", "failed", "cancelled"] as const;
const MODULE = "engineering-brain";

export type ProposalFailure = PathRefusalReason | "git_failed";

export type RegistryErrorCode =
  | PathRefusalReason
  | "invalid_input"
  | "duplicate_name"
  | "duplicate_environment"
  | "unknown_tracked_branch"
  | "unknown_environment_branch"
  | "path_unavailable"
  | "repo_has_active_task"
  | "not_found";

/** A refused registry call. The message is the fixed code only: never a path, URL or branch. */
export class RegistryError extends Error {
  constructor(readonly code: RegistryErrorCode) {
    super(`repository registry: ${code}`);
    this.name = "RegistryError";
  }
}

export interface RegistryDeps {
  db: Db;
  clock: Clock;
  audit: Pick<AuditLogger, "record">;
  events: Pick<EventPublisher, "publish">;
  provider: RepositoryProvider;
}

type RepoRow = typeof repositories.$inferSelect;
type EnvRow = typeof repositoryEnvironments.$inferSelect;

function inspectFailure(reason: RepositoryInspectFailure): ProposalFailure {
  if (reason === "path_missing") return "not_found";
  if (reason === "not_a_repository") return "not_git_root";
  return "git_failed";
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? "";
}

/** One path is the other, or lies under it (C2's nesting rule, on stored realpaths). */
function nestedPaths(a: string, b: string): boolean {
  const x = a.replace(/\/+$/, "");
  const y = b.replace(/\/+$/, "");
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/**
 * The repository registry (C4, ADR-035). It lives only in the database and changes only through
 * these calls, which the user drives: `propose` saves nothing, `register` re-inspects and saves
 * the repository, its environments and a project in one transaction. Audit rows and events carry
 * ids only: never paths, remote URLs or branch names.
 */
export class RepositoryRegistry {
  constructor(private readonly deps: RegistryDeps) {}

  /** Path checks plus what git reports, as suggestions for the confirm form. Saves nothing. */
  async propose(
    path: string,
  ): Promise<{ ok: true; proposal: RepositoryProposal } | { ok: false; reason: ProposalFailure }> {
    if (typeof path !== "string" || !path.startsWith("/"))
      return { ok: false, reason: "not_absolute" };
    if (!repositoryInspectInputSchema.safeParse({ path }).success) {
      return { ok: false, reason: "unsafe_chars" };
    }
    const check = await this.deps.provider.checkPath(path, this.registeredPaths());
    if (!check.ok) return check;
    const inspected = await this.deps.provider.inspect(check.realpath);
    if (!inspected.ok) return { ok: false, reason: inspectFailure(inspected.reason) };
    const i = inspected.inspection;
    const branches = allBranchNames(i);
    return {
      ok: true,
      proposal: {
        realpath: check.realpath,
        suggestedName: basename(check.realpath),
        currentBranch: i.currentBranch,
        suggestedTrackedBranch: i.currentBranch,
        headSha: i.headSha,
        originUrl: i.remotes.origin?.fetch ?? null,
        upstreamUrl: i.remotes.upstream?.fetch ?? null,
        upstreamPushDisabled: i.upstreamPushDisabled,
        branches,
        environmentCandidates: environmentCandidates(branches),
      },
    };
  }

  /** Re-checks the path, re-inspects, validates the branches and saves (one transaction). */
  async register(raw: RepositoryRegisterInput): Promise<RepositoryView> {
    const parsed = repositoryRegisterInputSchema.safeParse(raw);
    if (!parsed.success) throw new RegistryError("invalid_input");
    const input = parsed.data;
    this.assertUniqueEnvironments(input.environments);

    const check = await this.deps.provider.checkPath(input.path, this.registeredPaths());
    if (!check.ok) throw new RegistryError(check.reason);
    const i = await this.inspectOrThrow(check.realpath);
    this.assertBranches(i, input.trackedBranch, input.environments);

    const { db, clock, audit, events } = this.deps;
    const now = isoNow(clock);
    const id = newId();
    const projectId = db.transaction(
      (tx) => {
        if (tx.select().from(repositories).where(eq(repositories.name, input.name)).get()) {
          throw new RegistryError("duplicate_name");
        }
        if (
          tx.select().from(repositories).where(eq(repositories.localPath, check.realpath)).get()
        ) {
          throw new RegistryError("already_registered");
        }
        // checkPath judged nesting before git ran; another registration may have landed since.
        const others = tx
          .select({ p: repositories.localPath })
          .from(repositories)
          .all()
          .map((r) => r.p);
        if (others.some((o) => nestedPaths(o, check.realpath))) {
          throw new RegistryError("nested");
        }
        tx.insert(repositories)
          .values({
            id,
            name: input.name,
            localPath: check.realpath,
            originUrl: i.remotes.origin?.fetch ?? null,
            upstreamUrl: i.remotes.upstream?.fetch ?? null,
            upstreamPushDisabled: i.upstreamPushDisabled,
            trackedBranch: input.trackedBranch,
            jiraProjectKeys: unique(input.jiraProjectKeys),
            notes: input.notes ?? null,
            headSha: i.headSha,
            inspectedHeadSha: null,
            inspectionWarning: null,
            drift: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        for (const env of input.environments) this.insertEnvironment(tx, id, env);
        // A project survives unregistering, so re-registering under the same name relinks it,
        // but only an orphan: a same-name project still linked to a repository (say, one the
        // user renamed) is someone else's, and is refused instead of silently merged.
        const existing = tx.select().from(projects).where(eq(projects.name, input.name)).get();
        if (
          existing &&
          tx
            .select()
            .from(projectRepositories)
            .where(eq(projectRepositories.projectId, existing.id))
            .get()
        ) {
          throw new RegistryError("duplicate_name");
        }
        const pid = existing?.id ?? newId();
        if (!existing) {
          tx.insert(projects)
            .values({ id: pid, name: input.name, summary: null, createdAt: now, updatedAt: now })
            .run();
        }
        tx.insert(projectRepositories).values({ projectId: pid, repositoryId: id }).run();
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "repo.registered",
          targetRef: id,
          result: "ok",
          details: { repositoryId: id, projectId: pid },
        });
        events.publish(tx, {
          type: "repo.registered",
          aggregateType: "repository",
          aggregateId: id,
          correlationId: newId(),
          payload: { repositoryId: id },
        });
        return pid;
      },
      { behavior: "immediate" },
    );
    const view = this.get(id);
    if (!view || view.projectId !== projectId) throw new Error("registered repository vanished");
    return view;
  }

  /** User edits (`PUT /api/repos/:id`), audited with the changed field names only. */
  async update(id: string, raw: RepositoryUpdateInput): Promise<RepositoryView> {
    const parsed = repositoryUpdateInputSchema.safeParse(raw);
    if (!parsed.success) throw new RegistryError("invalid_input");
    const patch = parsed.data;
    const row = this.row(id);
    if (!row) throw new RegistryError("not_found");
    if (patch.environments) this.assertUniqueEnvironments(patch.environments);
    if (patch.trackedBranch !== undefined || patch.environments !== undefined) {
      const i = await this.inspectOrThrow(row.localPath);
      this.assertBranches(i, patch.trackedBranch ?? null, patch.environments ?? []);
    }

    const fields = (Object.keys(patch) as (keyof RepositoryUpdateInput)[])
      .filter((k) => patch[k] !== undefined)
      .sort();
    const { db, clock, audit } = this.deps;
    db.transaction(
      (tx) => {
        const current = tx.select().from(repositories).where(eq(repositories.id, id)).get();
        if (!current) throw new RegistryError("not_found");
        if (patch.name !== undefined && patch.name !== current.name) {
          if (tx.select().from(repositories).where(eq(repositories.name, patch.name)).get()) {
            throw new RegistryError("duplicate_name");
          }
        }
        tx.update(repositories)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.trackedBranch !== undefined ? { trackedBranch: patch.trackedBranch } : {}),
            ...(patch.jiraProjectKeys !== undefined
              ? { jiraProjectKeys: unique(patch.jiraProjectKeys) }
              : {}),
            ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
            updatedAt: isoNow(clock),
          })
          .where(eq(repositories.id, id))
          .run();
        if (patch.environments) this.replaceEnvironments(tx, id, patch.environments);
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "repo.updated",
          targetRef: id,
          result: "ok",
          details: { repositoryId: id, fields },
        });
      },
      { behavior: "immediate" },
    );
    const view = this.get(id);
    if (!view) throw new RegistryError("not_found");
    return view;
  }

  /**
   * Resolves a `remotesChanged` drift by accepting what git now reports: stores the
   * credential-stripped origin and upstream fetch URLs and `upstreamPushDisabled`, then
   * re-evaluates the stored drift without notifying. `remotesChanged` clears, parts of the
   * drift that git no longer shows clear too, and parts that remain keep their `detectedAt`.
   * Findings that are new since the stored drift are not added here: the next drift check
   * records them and notifies, so accepting remotes can never swallow a notification.
   * Audited as `repo.remotes_accepted` (ids only).
   */
  async acceptCurrentRemotes(id: string): Promise<RepositoryView> {
    const row = this.row(id);
    if (!row) throw new RegistryError("not_found");
    const i = await this.inspectOrThrow(row.localPath);
    const remotes = {
      originUrl: i.remotes.origin?.fetch ?? null,
      upstreamUrl: i.remotes.upstream?.fetch ?? null,
      upstreamPushDisabled: i.upstreamPushDisabled,
    };
    const { db, clock, audit } = this.deps;
    db.transaction(
      (tx) => {
        const current = tx.select().from(repositories).where(eq(repositories.id, id)).get();
        if (!current) throw new RegistryError("not_found");
        const environmentBranches = tx
          .select({ branch: repositoryEnvironments.branch })
          .from(repositoryEnvironments)
          .where(eq(repositoryEnvironments.repositoryId, id))
          .all()
          .map((e) => e.branch);
        const now = computeDrift(
          { ...current, ...remotes, environmentBranches },
          { ok: true, inspection: i },
        );
        tx.update(repositories)
          .set({ ...remotes, drift: narrowDrift(current.drift, now), updatedAt: isoNow(clock) })
          .where(eq(repositories.id, id))
          .run();
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "repo.remotes_accepted",
          targetRef: id,
          result: "ok",
          details: { repositoryId: id },
        });
      },
      { behavior: "immediate" },
    );
    const view = this.get(id);
    if (!view) throw new RegistryError("not_found");
    return view;
  }

  /**
   * Removes the repository and its environments. Its project (and facts) stay. Audited. Refused
   * with `repo_has_active_task` while an engineering task of the repository is not finished
   * (M4): deleting the row would cascade the task away while it may hold the lock or a branch.
   */
  unregister(id: string): void {
    const { db, audit } = this.deps;
    db.transaction(
      (tx) => {
        const row = tx.select().from(repositories).where(eq(repositories.id, id)).get();
        if (!row) throw new RegistryError("not_found");
        const active = tx
          .select({ id: engineeringTasks.id })
          .from(engineeringTasks)
          .where(
            and(
              eq(engineeringTasks.repositoryId, id),
              notInArray(engineeringTasks.status, [...FINISHED_TASK_STATUSES]),
            ),
          )
          .limit(1)
          .get();
        if (active) throw new RegistryError("repo_has_active_task");
        tx.delete(repositories).where(eq(repositories.id, id)).run();
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "repo.unregistered",
          targetRef: id,
          result: "ok",
          details: { repositoryId: id },
        });
      },
      { behavior: "immediate" },
    );
  }

  list(): RepositoryView[] {
    const rows = this.deps.db.select().from(repositories).orderBy(asc(repositories.name)).all();
    return rows.map((r) => this.toView(this.deps.db, r));
  }

  get(id: string): RepositoryView | null {
    const r = this.row(id);
    return r ? this.toView(this.deps.db, r) : null;
  }

  private row(id: string): RepoRow | undefined {
    return this.deps.db.select().from(repositories).where(eq(repositories.id, id)).get();
  }

  private registeredPaths(): string[] {
    return this.deps.db
      .select({ p: repositories.localPath })
      .from(repositories)
      .all()
      .map((r) => r.p);
  }

  private async inspectOrThrow(realpath: string): Promise<RepositoryInspection> {
    const r = await this.deps.provider.inspect(realpath);
    if (!r.ok) throw new RegistryError("path_unavailable");
    return r.inspection;
  }

  private assertUniqueEnvironments(envs: readonly EnvironmentInput[]): void {
    if (new Set(envs.map((e) => e.name)).size !== envs.length) {
      throw new RegistryError("duplicate_environment");
    }
  }

  /** ADR-035: the tracked branch and every environment branch exist locally or on a remote. */
  private assertBranches(
    i: RepositoryInspection,
    trackedBranch: string | null,
    envs: readonly EnvironmentInput[],
  ): void {
    const branches = new Set(allBranchNames(i));
    if (trackedBranch !== null && !branches.has(trackedBranch)) {
      throw new RegistryError("unknown_tracked_branch");
    }
    if (envs.some((e) => !branches.has(e.branch))) {
      throw new RegistryError("unknown_environment_branch");
    }
  }

  private insertEnvironment(tx: DbOrTx, repositoryId: string, env: EnvironmentInput): void {
    tx.insert(repositoryEnvironments)
      .values({
        id: newId(),
        repositoryId,
        name: env.name,
        branch: env.branch,
        protected: env.protected,
        autoDeploysOnMerge: env.autoDeploysOnMerge,
        notes: env.notes ?? null,
      })
      .run();
  }

  /** Matched by name: kept environments keep their id, since milestones reference it. */
  private replaceEnvironments(tx: DbOrTx, repositoryId: string, envs: readonly EnvironmentInput[]) {
    const existing = tx
      .select()
      .from(repositoryEnvironments)
      .where(eq(repositoryEnvironments.repositoryId, repositoryId))
      .all();
    const wanted = new Map(envs.map((e) => [e.name, e]));
    for (const old of existing) {
      const next = wanted.get(old.name);
      if (!next) {
        tx.delete(repositoryEnvironments).where(eq(repositoryEnvironments.id, old.id)).run();
        continue;
      }
      tx.update(repositoryEnvironments)
        .set({
          branch: next.branch,
          protected: next.protected,
          autoDeploysOnMerge: next.autoDeploysOnMerge,
          notes: next.notes ?? null,
        })
        .where(eq(repositoryEnvironments.id, old.id))
        .run();
      wanted.delete(old.name);
    }
    for (const env of wanted.values()) this.insertEnvironment(tx, repositoryId, env);
  }

  private toView(tx: DbOrTx, r: RepoRow): RepositoryView {
    const envs = tx
      .select()
      .from(repositoryEnvironments)
      .where(eq(repositoryEnvironments.repositoryId, r.id))
      .orderBy(asc(repositoryEnvironments.name))
      .all();
    const link = tx
      .select({ projectId: projectRepositories.projectId })
      .from(projectRepositories)
      .where(eq(projectRepositories.repositoryId, r.id))
      .get();
    return {
      id: r.id,
      name: r.name,
      localPath: r.localPath,
      originUrl: r.originUrl,
      upstreamUrl: r.upstreamUrl,
      upstreamPushDisabled: r.upstreamPushDisabled,
      trackedBranch: r.trackedBranch,
      jiraProjectKeys: r.jiraProjectKeys,
      notes: r.notes,
      headSha: r.headSha,
      inspectedHeadSha: r.inspectedHeadSha,
      inspectionWarning: r.inspectionWarning ?? null,
      drift: r.drift ?? null,
      environments: envs.map(envView),
      projectId: link?.projectId ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

/**
 * The stored drift restricted to what a fresh evaluation still shows, minus `remotesChanged`
 * (just accepted). Never adds findings, keeps `detectedAt`, and is null when nothing is left.
 */
export function narrowDrift(
  stored: RepositoryDrift | null,
  fresh: DriftFindings | null | undefined,
): RepositoryDrift | null {
  if (!stored || !fresh) return null;
  const next: DriftFindings = {};
  if (stored.offTrackedBranch !== undefined && stored.offTrackedBranch === fresh.offTrackedBranch) {
    next.offTrackedBranch = stored.offTrackedBranch;
  }
  const still = new Set(fresh.missingEnvironmentBranches ?? []);
  const missing = (stored.missingEnvironmentBranches ?? []).filter((b) => still.has(b));
  if (missing.length > 0) next.missingEnvironmentBranches = missing;
  if (stored.pathMissing && fresh.pathMissing) next.pathMissing = true;
  return Object.keys(next).length > 0 ? { ...next, detectedAt: stored.detectedAt } : null;
}

function envView(e: EnvRow): EnvironmentView {
  return {
    id: e.id,
    name: e.name,
    branch: e.branch,
    protected: e.protected,
    autoDeploysOnMerge: e.autoDeploysOnMerge,
    ...(e.notes !== null ? { notes: e.notes } : {}),
  };
}
