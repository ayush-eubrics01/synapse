/**
 * Work-in-progress reminders (A10). Local notifications to the user only: nothing is sent to
 * anyone else. The branch name may appear in the notification body, but never in logs, audit
 * details, events or errors.
 */
import type { PullRequestProvider } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow } from "@synapse/shared";
import { and, eq, gte, isNull } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { NotificationService } from "../../core/notifications/notifications";

export const REMINDER_KIND = "claude_activity.reminder";
export const REMINDERS_JOB = "claude_activity.reminders";

const DAY_MS = 86_400_000;
const ACTIVE_WITHIN_DAYS = 14;
const DEDUPE_DAYS = 7;
const DUE_MINUTES = 9 * 60 + 30;
const EXCLUDED_BRANCHES = new Set(["main", "master", "HEAD"]);

export interface ReminderSummary {
  staleBranches: number;
  openPrs: number;
  skippedDedupe: number;
  prErrors: number;
}

export type RunIfDueResult = ReminderSummary | { skipped: "not_due" | "done_today" | "disabled" };

export interface WipRemindersDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  notifications: Pick<NotificationService, "notify">;
  prs: Pick<PullRequestProvider, "view">;
  localTime?: (now: Date) => { date: string; minutes: number };
}

const p2 = (n: number) => String(n).padStart(2, "0");
const processLocalTime = (now: Date) => ({
  date: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`,
  minutes: now.getHours() * 60 + now.getMinutes(),
});

export class WipReminders {
  private readonly localTime: (now: Date) => { date: string; minutes: number };

  constructor(private readonly deps: WipRemindersDeps) {
    this.localTime = deps.localTime ?? processLocalTime;
  }

  async runIfDue(): Promise<RunIfDueResult> {
    const { settings, clock } = this.deps;
    if (!settings.get("claudeActivity.enabled")) return { skipped: "disabled" };
    const local = this.localTime(clock.now());
    if (local.minutes < DUE_MINUTES) return { skipped: "not_due" };
    if (settings.get("claudeActivity.reminders.lastRunDate") === local.date) {
      return { skipped: "done_today" };
    }
    const summary = await this.run();
    settings.set("claudeActivity.reminders.lastRunDate", local.date);
    return summary;
  }

  async run(): Promise<ReminderSummary> {
    const { db, clock, settings, notifications, prs } = this.deps;
    const now = clock.now().getTime();
    const nowIso = isoNow(clock);
    const summary: ReminderSummary = {
      staleBranches: 0,
      openPrs: 0,
      skippedDedupe: 0,
      prErrors: 0,
    };
    const staleMs = settings.get("claudeActivity.staleBranchDays") * DAY_MS;
    const prMs = settings.get("claudeActivity.openPrReminderDays") * DAY_MS;
    const dedupeSince = new Date(now - DEDUPE_DAYS * DAY_MS).toISOString();

    const reminded = (ref: string): boolean =>
      db
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.kind, REMINDER_KIND),
            eq(schema.notifications.ref, ref),
            gte(schema.notifications.createdAt, dedupeSince),
          ),
        )
        .get() !== undefined;

    const repos = new Map(
      db
        .select()
        .from(schema.repositories)
        .all()
        .map((r) => [r.id, r]),
    );
    const envBranches = new Map<string, Set<string>>();
    for (const e of db.select().from(schema.repositoryEnvironments).all()) {
      const set = envBranches.get(e.repositoryId) ?? new Set<string>();
      set.add(e.branch);
      envBranches.set(e.repositoryId, set);
    }
    const withPr = new Set(
      db
        .select()
        .from(schema.claudeSessionPrs)
        .all()
        .filter((r) => r.gitBranch !== null)
        .map((r) => `${r.repositoryId}\0${r.gitBranch}`),
    );

    // (a) branches worked on for a while with no pull request seen.
    const groups = new Map<
      string,
      { repoId: string; branch: string; first: number; last: number }
    >();
    for (const s of db.select().from(schema.claudeSessions).all()) {
      if (s.gitBranch === null) continue;
      const key = `${s.repositoryId}\0${s.gitBranch}`;
      const first = Date.parse(s.firstAt);
      const last = Date.parse(s.lastAt);
      const g = groups.get(key);
      if (g) {
        g.first = Math.min(g.first, first);
        g.last = Math.max(g.last, last);
      } else {
        groups.set(key, { repoId: s.repositoryId, branch: s.gitBranch, first, last });
      }
    }
    for (const [key, g] of groups) {
      const repo = repos.get(g.repoId);
      if (!repo) continue;
      if (g.first > now - staleMs) continue;
      if (g.last < now - ACTIVE_WITHIN_DAYS * DAY_MS) continue;
      if (withPr.has(key)) continue;
      if (EXCLUDED_BRANCHES.has(g.branch) || g.branch === repo.trackedBranch) continue;
      if (envBranches.get(g.repoId)?.has(g.branch)) continue;
      const ref = `wip:${g.repoId}:${g.branch}`;
      if (reminded(ref)) {
        summary.skippedDedupe++;
        continue;
      }
      const days = Math.floor((now - g.first) / DAY_MS);
      notifications.notify(db, {
        kind: REMINDER_KIND,
        severity: "info",
        title: `Branch without a PR in ${repo.name}`,
        body: `You worked on ${g.branch} in Claude Code for ${days} days and no pull request was seen.`,
        ref,
      });
      summary.staleBranches++;
    }

    // (b) pull requests seen a while ago that are still open.
    const rows = db
      .select()
      .from(schema.claudeSessionPrs)
      .where(isNull(schema.claudeSessionPrs.remindedAt))
      .all();
    for (const pr of rows) {
      const seen = Date.parse(pr.firstSeenAt);
      if (seen > now - prMs) continue;
      const ref = `pr:${pr.prUrl}`;
      if (reminded(ref)) {
        summary.skippedDedupe++;
        continue;
      }
      let state: string;
      try {
        state = (await prs.view(pr.prUrl)).state;
      } catch {
        summary.prErrors++;
        continue;
      }
      if (state !== "OPEN") continue;
      const repoName = repos.get(pr.repositoryId)?.name ?? "repository";
      const days = Math.floor((now - seen) / DAY_MS);
      notifications.notify(db, {
        kind: REMINDER_KIND,
        severity: "info",
        title: `Pull request still open in ${repoName}`,
        body: `#${pr.prNumber} (${pr.prRepository}) has been open for ${days} days.`,
        ref,
      });
      db.update(schema.claudeSessionPrs)
        .set({ remindedAt: nowIso })
        .where(eq(schema.claudeSessionPrs.id, pr.id))
        .run();
      summary.openPrs++;
    }
    return summary;
  }
}
