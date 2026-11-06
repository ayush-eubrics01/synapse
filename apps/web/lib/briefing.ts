import type { DashboardOverview } from "@synapse/contracts";
import { relMinutes } from "./format";

export interface BriefingOptions {
  /** False only when Slack status loaded and the 90-day backfill has never been started. */
  backfillStarted: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function join(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The one-paragraph briefing under the greeting (spec Header). */
export function briefing(o: DashboardOverview, now: Date, opts: BriefingOptions): string {
  const c = o.counts;
  const setup =
    (o.self.slackUserId === null ? 1 : 0) +
    (c.peopleToEvaluate > 0 ? 1 : 0) +
    (opts.backfillStarted ? 0 : 1);
  const parts: string[] = [];
  const add = (n: number, text: string) => {
    if (n > 0) parts.push(text);
  };
  add(c.approvals, `${plural(c.approvals, "message", "messages")} awaiting approval`);
  add(
    c.outgoingAttention,
    `${c.outgoingAttention} ${c.outgoingAttention === 1 ? "send needs" : "sends need"} attention`,
  );
  add(c.redFlags, plural(c.redFlags, "red flag", "red flags"));
  add(c.followupDrafts, plural(c.followupDrafts, "follow-up draft", "follow-up drafts"));
  add(
    c.commitmentsToReview,
    plural(c.commitmentsToReview, "possible commitment", "possible commitments"),
  );
  add(
    c.profileRecommendations,
    plural(c.profileRecommendations, "profile suggestion", "profile suggestions"),
  );
  add(setup, plural(setup, "setup step", "setup steps"));

  const urgent =
    c.urgent > 0 ? `${plural(c.urgent, "urgent item", "urgent items")}.` : "Nothing urgent.";
  const todo = parts.length > 0 ? `${join(parts)} waiting on you.` : "You're all caught up.";
  const sync =
    o.lastSlackSyncAt === null
      ? "Slack hasn't synced yet."
      : `Slack synced ${relMinutes(o.lastSlackSyncAt, now)}.`;
  return `${urgent} ${todo} ${sync}`;
}
