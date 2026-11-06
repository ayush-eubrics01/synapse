import {
  type FactCreateInput,
  type FactStatus,
  factAcceptInputSchema,
  factCreateInputSchema,
  type JiraAttention,
  type MilestoneInput,
  type MilestoneStatus,
  type MilestoneUpdateInput,
  type MilestoneView,
  milestoneInputSchema,
  milestoneUpdateInputSchema,
  type ProjectDetail,
  type ProjectFactView,
  type ProjectUpdateInput,
  type ProjectView,
  projectUpdateInputSchema,
  type UpcomingMilestone,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { addDays, type Clock, isoNow, localDate, newId } from "@synapse/shared";
import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import { normaliseFactContent } from "./evidence";
import type { InspectionService, RequestInspectionResult } from "./inspection";
import type { RepositoryRegistry } from "./registry";

const {
  projects,
  projectFacts,
  projectMilestones,
  projectRepositories,
  repositoryEnvironments,
  jiraIssues,
} = schema;
const MODULE = "engineering-brain";
/** Most urgent first. */
const ATTENTION_ORDER: readonly JiraAttention[] = ["overdue", "blocked", "due_soon", "stale"];
const JIRA_TOP = 5;

export type BrainErrorCode =
  | "not_found"
  | "invalid_input"
  | "duplicate_name"
  | "invalid_environment"
  | "invalid_state";

/** A refused call. The message is the fixed code only: never fact text, names or paths. */
export class BrainError extends Error {
  constructor(readonly code: BrainErrorCode) {
    super(`engineering brain: ${code}`);
    this.name = "BrainError";
  }
}

export interface BrainServiceDeps {
  db: Db;
  clock: Clock;
  settings: Pick<SettingsService, "get">;
  audit: Pick<AuditLogger, "record">;
  events: Pick<EventPublisher, "publish">;
  registry: Pick<RepositoryRegistry, "get">;
  inspections: Pick<InspectionService, "requestInspection">;
  /** IANA zone for "today" and the upcoming horizon; undefined means the process zone. */
  timeZone?: string;
}

type FactRow = typeof projectFacts.$inferSelect;
type MilestoneRow = typeof projectMilestones.$inferSelect;

/**
 * Projects, fact review, milestones and the Jira association (C9 to C12). Facts and milestones
 * change only through these calls, which the user drives. Audit rows and events carry ids and
 * field names only: never fact text, names or paths.
 */
export class BrainService {
  constructor(private readonly deps: BrainServiceDeps) {}

  listProjects(): ProjectView[] {
    const { db } = this.deps;
    return db
      .select()
      .from(projects)
      .orderBy(asc(projects.name))
      .all()
      .map((p) => this.projectView(db, p));
  }

  getProject(id: string): ProjectDetail | null {
    const { db, registry } = this.deps;
    const p = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!p) return null;
    const view = this.projectView(db, p);
    const repos = view.repositoryIds.flatMap((rid) => registry.get(rid) ?? []);
    const facts = db
      .select()
      .from(projectFacts)
      .where(eq(projectFacts.projectId, id))
      .orderBy(desc(projectFacts.createdAt), asc(projectFacts.id))
      .all();
    return {
      ...view,
      repositories: repos,
      facts: facts.map(factView),
      milestones: this.milestonesOf(db, id),
      jira: this.jiraSummary(
        db,
        repos.flatMap((r) => r.jiraProjectKeys),
      ),
    };
  }

  updateProject(id: string, raw: ProjectUpdateInput): ProjectView {
    const parsed = projectUpdateInputSchema.safeParse(raw);
    if (!parsed.success) throw new BrainError("invalid_input");
    const patch = parsed.data;
    const { db, clock, audit } = this.deps;
    const fields = (Object.keys(patch) as (keyof ProjectUpdateInput)[])
      .filter((k) => patch[k] !== undefined)
      .sort();
    return db.transaction(
      (tx) => {
        const cur = tx.select().from(projects).where(eq(projects.id, id)).get();
        if (!cur) throw new BrainError("not_found");
        if (patch.name !== undefined && patch.name !== cur.name) {
          if (tx.select().from(projects).where(eq(projects.name, patch.name)).get()) {
            throw new BrainError("duplicate_name");
          }
        }
        tx.update(projects)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
            updatedAt: isoNow(clock),
          })
          .where(eq(projects.id, id))
          .run();
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "project.updated",
          targetRef: id,
          result: "ok",
          details: { projectId: id, fields },
        });
        const next = tx.select().from(projects).where(eq(projects.id, id)).get();
        if (!next) throw new BrainError("not_found");
        return this.projectView(tx, next);
      },
      { behavior: "immediate" },
    );
  }

  // ---- facts (C9) ----

  /** A user-added fact is approved at once and supersedes an approved equivalent. */
  addFact(projectId: string, raw: FactCreateInput): ProjectFactView {
    const parsed = factCreateInputSchema.safeParse(raw);
    if (!parsed.success) throw new BrainError("invalid_input");
    const input = parsed.data;
    const { db, clock } = this.deps;
    return db.transaction(
      (tx) => {
        if (!tx.select().from(projects).where(eq(projects.id, projectId)).get()) {
          throw new BrainError("not_found");
        }
        const now = isoNow(clock);
        const id = newId();
        const superseded = this.supersede(tx, projectId, id, input.kind, input.content, now);
        tx.insert(projectFacts)
          .values({
            id,
            projectId,
            kind: input.kind,
            content: input.content,
            evidence: input.evidence,
            status: "approved",
            source: "user",
            claudeRunId: null,
            supersedesId: superseded,
            headSha: null,
            createdAt: now,
            decidedAt: now,
          })
          .run();
        this.decided(tx, id, projectId, "approved", superseded, "fact.added");
        return this.factOrThrow(tx, id);
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Approves a `needs_review` fact (optionally with edited content). An approved fact of the same
   * kind and normalised content becomes `outdated`, and the new one records it in `supersedes_id`.
   */
  acceptFact(id: string, edited?: { content?: string }): ProjectFactView {
    const parsed = factAcceptInputSchema.safeParse(edited ?? {});
    if (!parsed.success) throw new BrainError("invalid_input");
    const { db, clock } = this.deps;
    return db.transaction(
      (tx) => {
        const cur = tx.select().from(projectFacts).where(eq(projectFacts.id, id)).get();
        if (!cur) throw new BrainError("not_found");
        if (cur.status !== "needs_review") throw new BrainError("invalid_state");
        const content = parsed.data.content ?? cur.content;
        const now = isoNow(clock);
        const superseded = this.supersede(tx, cur.projectId, id, cur.kind, content, now);
        tx.update(projectFacts)
          .set({ status: "approved", content, supersedesId: superseded, decidedAt: now })
          .where(eq(projectFacts.id, id))
          .run();
        this.decided(tx, id, cur.projectId, "approved", superseded, "fact.accepted", {
          edited: parsed.data.content !== undefined && parsed.data.content !== cur.content,
        });
        return this.factOrThrow(tx, id);
      },
      { behavior: "immediate" },
    );
  }

  rejectFact(id: string): ProjectFactView {
    const { db, clock } = this.deps;
    return db.transaction(
      (tx) => {
        const cur = tx.select().from(projectFacts).where(eq(projectFacts.id, id)).get();
        if (!cur) throw new BrainError("not_found");
        if (cur.status !== "needs_review") throw new BrainError("invalid_state");
        tx.update(projectFacts)
          .set({ status: "rejected", decidedAt: isoNow(clock) })
          .where(eq(projectFacts.id, id))
          .run();
        this.decided(tx, id, cur.projectId, "rejected", null, "fact.rejected");
        return this.factOrThrow(tx, id);
      },
      { behavior: "immediate" },
    );
  }

  /** Facts waiting for review across all projects (the overview count). */
  reviewCount(): number {
    return (
      this.deps.db
        .select({ n: count() })
        .from(projectFacts)
        .where(eq(projectFacts.status, "needs_review"))
        .get()?.n ?? 0
    );
  }

  // ---- milestones (C10) ----

  listMilestones(projectId: string): MilestoneView[] {
    const { db } = this.deps;
    if (!db.select().from(projects).where(eq(projects.id, projectId)).get()) {
      throw new BrainError("not_found");
    }
    return this.milestonesOf(db, projectId);
  }

  createMilestone(projectId: string, raw: MilestoneInput): MilestoneView {
    const parsed = milestoneInputSchema.safeParse(raw);
    if (!parsed.success) throw new BrainError("invalid_input");
    const input = parsed.data;
    const { db, clock, audit } = this.deps;
    return db.transaction(
      (tx) => {
        if (!tx.select().from(projects).where(eq(projects.id, projectId)).get()) {
          throw new BrainError("not_found");
        }
        this.assertEnvironment(tx, projectId, input.environmentId ?? null);
        const id = newId();
        const now = isoNow(clock);
        tx.insert(projectMilestones)
          .values({
            id,
            projectId,
            name: input.name,
            targetDate: input.targetDate,
            environmentId: input.environmentId ?? null,
            status: input.status,
            notes: input.notes ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "milestone.created",
          targetRef: id,
          result: "ok",
          details: { milestoneId: id, projectId },
        });
        return this.milestoneOrThrow(tx, id);
      },
      { behavior: "immediate" },
    );
  }

  updateMilestone(projectId: string, id: string, raw: MilestoneUpdateInput): MilestoneView {
    const parsed = milestoneUpdateInputSchema.safeParse(raw);
    if (!parsed.success) throw new BrainError("invalid_input");
    const patch = parsed.data;
    const { db, clock, audit } = this.deps;
    const fields = (Object.keys(patch) as (keyof MilestoneUpdateInput)[])
      .filter((k) => patch[k] !== undefined)
      .sort();
    return db.transaction(
      (tx) => {
        const cur = tx.select().from(projectMilestones).where(eq(projectMilestones.id, id)).get();
        if (!cur || cur.projectId !== projectId) throw new BrainError("not_found");
        if (patch.environmentId !== undefined) {
          this.assertEnvironment(tx, projectId, patch.environmentId);
        }
        tx.update(projectMilestones)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.targetDate !== undefined ? { targetDate: patch.targetDate } : {}),
            ...(patch.environmentId !== undefined ? { environmentId: patch.environmentId } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
            updatedAt: isoNow(clock),
          })
          .where(eq(projectMilestones.id, id))
          .run();
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "milestone.updated",
          targetRef: id,
          result: "ok",
          details: { milestoneId: id, projectId, fields },
        });
        return this.milestoneOrThrow(tx, id);
      },
      { behavior: "immediate" },
    );
  }

  deleteMilestone(projectId: string, id: string): void {
    const { db, audit } = this.deps;
    db.transaction(
      (tx) => {
        const cur = tx.select().from(projectMilestones).where(eq(projectMilestones.id, id)).get();
        if (!cur || cur.projectId !== projectId) throw new BrainError("not_found");
        tx.delete(projectMilestones).where(eq(projectMilestones.id, id)).run();
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "milestone.deleted",
          targetRef: id,
          result: "ok",
          details: { milestoneId: id, projectId },
        });
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Planned milestones due within `brain.upcoming.days` (or already overdue), by date, then
   * name. Done, slipped and cancelled milestones never appear.
   */
  upcoming(): UpcomingMilestone[] {
    const { db, settings } = this.deps;
    const today = this.today();
    const horizon = addDays(today, settings.get("brain.upcoming.days"));
    const rows = db
      .select()
      .from(projectMilestones)
      .where(eq(projectMilestones.status, "planned"))
      .orderBy(asc(projectMilestones.targetDate), asc(projectMilestones.name))
      .all()
      .filter((m) => m.targetDate <= horizon);
    const names = new Map(
      db
        .select()
        .from(projects)
        .all()
        .map((p) => [p.id, p.name]),
    );
    return rows.map((m) => ({
      ...this.milestoneView(db, m, today),
      projectName: names.get(m.projectId) ?? "",
    }));
  }

  requestInspection(repoId: string): RequestInspectionResult {
    return this.deps.inspections.requestInspection(repoId);
  }

  // ---- internals ----

  /** The local calendar date (M3, final review): milestone dates are calendar dates too. */
  private today(): string {
    return localDate(this.deps.clock.now(), this.deps.timeZone);
  }

  /**
   * Marks approved facts of the project with the same kind and normalised content (other than
   * `selfId`) outdated and returns the id of the first, which the new fact records.
   */
  private supersede(
    tx: DbOrTx,
    projectId: string,
    selfId: string,
    kind: FactRow["kind"],
    content: string,
    now: string,
  ): string | null {
    const key = normaliseFactContent(content);
    const same = tx
      .select()
      .from(projectFacts)
      .where(
        and(
          eq(projectFacts.projectId, projectId),
          eq(projectFacts.kind, kind),
          eq(projectFacts.status, "approved"),
        ),
      )
      .orderBy(asc(projectFacts.createdAt), asc(projectFacts.id))
      .all()
      .filter((f) => f.id !== selfId && normaliseFactContent(f.content) === key);
    for (const f of same) {
      tx.update(projectFacts)
        .set({ status: "outdated", decidedAt: now })
        .where(eq(projectFacts.id, f.id))
        .run();
    }
    return same[0]?.id ?? null;
  }

  private decided(
    tx: DbOrTx,
    factId: string,
    projectId: string,
    status: FactStatus,
    supersededId: string | null,
    action: string,
    extra: Record<string, unknown> = {},
  ): void {
    const { audit, events } = this.deps;
    audit.record(tx, {
      actor: "user",
      module: MODULE,
      action,
      targetRef: factId,
      result: "ok",
      details: { factId, projectId, status, supersededId, ...extra },
    });
    events.publish(tx, {
      type: "brain.fact_decided",
      aggregateType: "project",
      aggregateId: projectId,
      correlationId: newId(),
      payload: { factId, status },
    });
  }

  private assertEnvironment(tx: DbOrTx, projectId: string, environmentId: string | null): void {
    if (environmentId === null) return;
    const env = tx
      .select({ repositoryId: repositoryEnvironments.repositoryId })
      .from(repositoryEnvironments)
      .where(eq(repositoryEnvironments.id, environmentId))
      .get();
    const ok =
      env &&
      tx
        .select()
        .from(projectRepositories)
        .where(
          and(
            eq(projectRepositories.projectId, projectId),
            eq(projectRepositories.repositoryId, env.repositoryId),
          ),
        )
        .get();
    if (!ok) throw new BrainError("invalid_environment");
  }

  private projectView(tx: DbOrTx, p: typeof projects.$inferSelect): ProjectView {
    const repositoryIds = tx
      .select({ id: projectRepositories.repositoryId })
      .from(projectRepositories)
      .where(eq(projectRepositories.projectId, p.id))
      .all()
      .map((r) => r.id)
      .sort();
    const review =
      tx
        .select({ n: count() })
        .from(projectFacts)
        .where(and(eq(projectFacts.projectId, p.id), eq(projectFacts.status, "needs_review")))
        .get()?.n ?? 0;
    const next = tx
      .select()
      .from(projectMilestones)
      .where(and(eq(projectMilestones.projectId, p.id), eq(projectMilestones.status, "planned")))
      .orderBy(asc(projectMilestones.targetDate), asc(projectMilestones.name))
      .limit(1)
      .get();
    return {
      id: p.id,
      name: p.name,
      summary: p.summary,
      repositoryIds,
      factsNeedingReview: review,
      nextMilestone: next ? this.milestoneView(tx, next, this.today()) : null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  private milestonesOf(tx: DbOrTx, projectId: string): MilestoneView[] {
    const today = this.today();
    return tx
      .select()
      .from(projectMilestones)
      .where(eq(projectMilestones.projectId, projectId))
      .orderBy(asc(projectMilestones.targetDate), asc(projectMilestones.name))
      .all()
      .map((m) => this.milestoneView(tx, m, today));
  }

  private milestoneOrThrow(tx: DbOrTx, id: string): MilestoneView {
    const m = tx.select().from(projectMilestones).where(eq(projectMilestones.id, id)).get();
    if (!m) throw new BrainError("not_found");
    return this.milestoneView(tx, m, this.today());
  }

  private milestoneView(tx: DbOrTx, m: MilestoneRow, today: string): MilestoneView {
    const env = m.environmentId
      ? tx
          .select({ name: repositoryEnvironments.name })
          .from(repositoryEnvironments)
          .where(eq(repositoryEnvironments.id, m.environmentId))
          .get()
      : undefined;
    return {
      id: m.id,
      projectId: m.projectId,
      name: m.name,
      targetDate: m.targetDate,
      environmentId: m.environmentId,
      environmentName: env?.name ?? null,
      status: m.status as MilestoneStatus,
      notes: m.notes,
      overdue: m.status === "planned" && m.targetDate < today,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  private factOrThrow(tx: DbOrTx, id: string): ProjectFactView {
    const f = tx.select().from(projectFacts).where(eq(projectFacts.id, id)).get();
    if (!f) throw new BrainError("not_found");
    return factView(f);
  }

  /** C11: in-scope issues whose project key is one of the repositories' Jira keys. */
  private jiraSummary(tx: DbOrTx, keys: readonly string[]): ProjectDetail["jira"] {
    const byAttention: Record<JiraAttention, number> = {
      overdue: 0,
      blocked: 0,
      due_soon: 0,
      stale: 0,
    };
    const unique = [...new Set(keys)];
    if (unique.length === 0) return { byAttention, top: [] };
    const rows = tx
      .select({
        key: jiraIssues.key,
        summary: jiraIssues.summary,
        attention: jiraIssues.attention,
      })
      .from(jiraIssues)
      .where(
        and(
          eq(jiraIssues.inScope, true),
          inArray(jiraIssues.projectKey, unique),
          isNotNull(jiraIssues.attention),
        ),
      )
      .all();
    const issues = rows.flatMap((r) =>
      r.attention ? [{ key: r.key, summary: r.summary, attention: r.attention }] : [],
    );
    for (const i of issues) byAttention[i.attention]++;
    issues.sort(
      (a, b) =>
        ATTENTION_ORDER.indexOf(a.attention) - ATTENTION_ORDER.indexOf(b.attention) ||
        a.key.localeCompare(b.key),
    );
    return { byAttention, top: issues.slice(0, JIRA_TOP) };
  }
}

function factView(f: FactRow): ProjectFactView {
  return {
    id: f.id,
    projectId: f.projectId,
    kind: f.kind,
    content: f.content,
    evidence: f.evidence,
    status: f.status,
    source: f.source,
    claudeRunId: f.claudeRunId,
    supersedesId: f.supersedesId,
    headSha: f.headSha,
    createdAt: f.createdAt,
    decidedAt: f.decidedAt,
  };
}
