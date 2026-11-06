import type { DashboardOverview, HealthReport } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { and, count, countDistinct, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { ApprovalEngine } from "../../core/approvals/approvals";
import type { SettingsService } from "../../core/config/settings";
import type { FollowupService } from "../commitments/followups";
import type { CommitmentLifecycle } from "../commitments/lifecycle";
import type { BrainService } from "../engineering-brain/service";
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
  brain: Pick<BrainService, "reviewCount" | "upcoming">;
}

const DAY_MS = 86_400_000;
/** The same default the candidates endpoint applies. */
const CANDIDATE_LIMIT = 50;

/**
 * Read-only aggregate behind `GET /api/dashboard/overview`. Counts reuse the list endpoints' own
 * methods and apply the Needs-you feed's rules, so each count matches the cards the user sees.
 */
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
    const recommendations = this.deps.peopleViews.listRecommendations("pending");
    // Mirrors the Needs-you feed: a profile approval is decided on its recommendation card.
    const onRecommendation = new Set(
      recommendations.map((r) => r.approvalId).filter((id): id is string => id !== null),
    );
    const approvals = this.deps.approvals
      .listPending()
      .filter((a) => !onRecommendation.has(a.id)).length;
    const candidates = this.deps.peopleViews.candidates(CANDIDATE_LIMIT);
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
        // The review filter also returns rejected rows; only pending ones can be accepted.
        commitmentsToReview: this.deps.commitmentLifecycle
          .listViews("review")
          .filter((v) => v.reviewStatus === "pending_review").length,
        followupDrafts: this.deps.followups.listViews("draft").length,
        profileRecommendations: recommendations.length,
        peopleToEvaluate: candidates.identityRequired
          ? 0
          : candidates.candidates.filter((x) => x.actions.includes("evaluate")).length,
        conversations:
          db
            .select({ n: countDistinct(schema.slackMessages.conversationId) })
            .from(schema.slackMessages)
            .get()?.n ?? 0,
        // Nothing to act on while tracking is off, whatever rows remain from before.
        jiraAttention: !settings.get("jira.enabled")
          ? 0
          : (db
              .select({ n: count() })
              .from(schema.jiraIssues)
              .where(
                and(eq(schema.jiraIssues.inScope, true), isNotNull(schema.jiraIssues.attention)),
              )
              .get()?.n ?? 0),
        brainReview: this.deps.brain.reviewCount(),
      },
      away: {
        on: settings.get("autoReply.awayMode"),
        highPriorityCount: this.highPriorityCount(selfId),
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
      upcoming: this.deps.brain.upcoming().slice(0, 3),
      engineeringLock: null,
    };
  }

  /** People the away policy can reply to: priority high or critical, never the user. */
  private highPriorityCount(selfId: string | null): number {
    const { people, peoplePrioritySettings: ps } = schema;
    const cond = and(
      inArray(ps.priority, ["high", "critical"]),
      selfId === null ? undefined : ne(people.slackUserId, selfId),
    );
    return (
      this.deps.db
        .select({ n: count() })
        .from(ps)
        .innerJoin(people, eq(ps.personId, people.id))
        .where(cond)
        .get()?.n ?? 0
    );
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

  private assessJobs(now: Date): {
    duePending: number;
    running: number;
    retrying: number;
    failedRecent: number;
  } {
    const { jobs } = schema;
    const n = (cond: ReturnType<typeof and>) =>
      this.deps.db.select({ n: count() }).from(jobs).where(cond).get()?.n ?? 0;
    const type = eq(jobs.type, "urgency.assess");
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    return {
      duePending: n(and(type, eq(jobs.status, "PENDING"), lte(jobs.runAfter, now.toISOString()))),
      running: n(and(type, eq(jobs.status, "RUNNING"))),
      // A job backing off before its next attempt is still waiting, whatever its runAfter.
      retrying: n(and(type, eq(jobs.status, "RETRY"))),
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
