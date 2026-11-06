import {
  allBranchNames,
  type EnvironmentInput,
  type EnvironmentView,
  environmentCandidates,
  type PathRefusalReason,
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
import { asc, eq } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { EventPublisher } from "../../core/events/publisher";

const { repositories, repositoryEnvironments, projects, projectRepositories } = schema;
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
            drift: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        for (const env of input.environments) this.insertEnvironment(tx, id, env);
        // A project survives unregistering, so re-registering under the same name relinks it.
        const existing = tx.select().from(projects).where(eq(projects.name, input.name)).get();
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

  /** Removes the repository and its environments. Its project (and facts) stay. Audited. */
  unregister(id: string): void {
    const { db, audit } = this.deps;
    db.transaction(
      (tx) => {
        const row = tx.select().from(repositories).where(eq(repositories.id, id)).get();
        if (!row) throw new RegistryError("not_found");
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
      drift: r.drift ?? null,
      environments: envs.map(envView),
      projectId: link?.projectId ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
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
