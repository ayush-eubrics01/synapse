import type { DashboardOverview, HealthReport } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { and, count, countDistinct, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { ApprovalEngine } from "../../core/approvals/approvals";
import type { SettingsService } from "../../core/config/settings";
import type { FollowupService } from "../commitments/followups";
import type { CommitmentLifecycle } from "../commitments/lifecycle";
import type { SyncStateService } from "../inbox/sync-state";
import type { UrgentInbox } from "../inbox/urgent";
import type { PeopleViews } from "../people/views";
import type { SecurityFlagsService } from "../security-flags/service";
import { HEALTH_HINTS, HEALTH_LABELS } from "./health-hints";
import { pipelineStages } from "./pipeline";

export interface DashboardDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  urgent: UrgentInbox;
  approvals: ApprovalEngine;
  securityFlags: SecurityFlagsService;
  commitmentLifecycle: CommitmentLifecycle;
  followups: FollowupService;
  peopleViews: PeopleViews;
  sync: SyncStateService;
  health: { report(): Promise<HealthReport> };
}

const DAY_MS = 86_400_000;
/** The same default the candidates endpoint applies. */
const CANDIDATE_LIMIT = 50;

/** Read-only aggregate behind `GET /api/dashboard/overview`. Counts reuse the list endpoints' own methods. */
export class DashboardService {
  constructor(private readonly deps: DashboardDeps) {}

  async overview(): Promise<DashboardOverview> {
    const { db, clock, settings } = this.deps;
    const now = clock.now();
    const selfId = settings.get("slack.selfUserId");
    const report = await this.deps.health.report();
    const incremental = this.deps.sync.get("slack.messages");
    const backfill = this.deps.sync.get("slack.backfill");

    const urgent = this.deps.urgent.listUrgent({ status: "open" }).length;
    const approvals = this.deps.approvals.listPending().length;
    const redFlags = this.deps.securityFlags
      .listGroupedByPerson({
        minSeverity: settings.get("security.flags.widgetMinSeverity"),
        includeReviewed: false,
      })
      .reduce((n, g) => n + g.openCount, 0);

    const today = now.toISOString().slice(0, 10);
    const searches = (s: { searchCountDate: string | null; searchCount: number }) =>
      s.searchCountDate === today ? s.searchCount : 0;

    const problem = (name: string) => report.checks[name]?.status !== "ok";
    const assess = this.assessJobs(now);

    return {
      generatedAt: now.toISOString(),
      self: { slackUserId: selfId, name: selfId === null ? null : this.nameOf(selfId) },
      counts: {
        urgent,
        approvals,
        outgoingAttention:
          db
            .select({ n: count() })
            .from(schema.outgoingMessages)
            .where(eq(schema.outgoingMessages.status, "needs_attention"))
            .get()?.n ?? 0,
        redFlags,
        commitmentsToReview: this.deps.commitmentLifecycle.listViews("review").length,
        followupDrafts: this.deps.followups.listViews("draft").length,
        profileRecommendations: this.deps.peopleViews.listRecommendations("pending").length,
        peopleToEvaluate: this.deps.peopleViews.candidates(CANDIDATE_LIMIT).candidates.length,
        conversations:
          db
            .select({ n: countDistinct(schema.slackMessages.conversationId) })
            .from(schema.slackMessages)
            .get()?.n ?? 0,
      },
      lastSlackSyncAt: incremental.lastSuccessAt,
      health: {
        status: report.status,
        issues: Object.entries(report.checks)
          .filter(([, check]) => check.status !== "ok")
          .map(([check, r]) => ({
            check,
            label: HEALTH_LABELS[check] ?? check,
            status: r.status,
            detail: r.detail ?? null,
            hint: HEALTH_HINTS[check] ?? null,
          })),
      },
      pipeline: pipelineStages(
        {
          slack: {
            lastSuccessAt: incremental.lastSuccessAt,
            error: incremental.lastError !== null,
            stalled: incremental.status === "error",
            searchesToday: searches(incremental) + searches(backfill),
          },
          rulesOk: !problem("screening-rules") && !problem("security-rules"),
          openRedFlags: redFlags,
          assess,
          openUrgent: urgent,
          pendingApprovals: approvals,
        },
        now,
      ),
      engineeringLock: null,
    };
  }

  private nameOf(slackUserId: string): string | null {
    const { db } = this.deps;
    const person = db
      .select({ name: schema.people.name })
      .from(schema.people)
      .where(eq(schema.people.slackUserId, slackUserId))
      .get();
    if (person?.name) return person.name;
    return (
      db
        .select({ name: schema.slackUsers.name })
        .from(schema.slackUsers)
        .where(eq(schema.slackUsers.externalId, slackUserId))
        .get()?.name ?? null
    );
  }

  private assessJobs(now: Date): { duePending: number; running: number; failedRecent: number } {
    const { jobs } = schema;
    const n = (cond: ReturnType<typeof and>) =>
      this.deps.db.select({ n: count() }).from(jobs).where(cond).get()?.n ?? 0;
    const type = eq(jobs.type, "urgency.assess");
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    return {
      duePending: n(and(type, eq(jobs.status, "PENDING"), lte(jobs.runAfter, now.toISOString()))),
      running: n(and(type, eq(jobs.status, "RUNNING"))),
      failedRecent: n(
        and(
          type,
          inArray(jobs.status, ["FAILED", "NEEDS_ATTENTION"]),
          gte(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`, since),
        ),
      ),
    };
  }
}
