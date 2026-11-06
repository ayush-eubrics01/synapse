import type {
  CommitmentEditsDto,
  FlagReviewStatus,
  ResolveDecisionDto,
  UrgencyStatusDto,
} from "./api";
import * as apiModule from "./api";
import { decideThenRefresh } from "./decide";
import type { Deferred } from "./deferred";
import { flagKey } from "./needs-you";
import type { Decision } from "./people-decision";

/** What the Needs-you cards can do. */
export interface NeedsYouHandlers {
  urgentStatus: (messageId: string, status: UrgencyStatusDto) => void;
  urgentReply: (messageId: string, text: string) => void;
  resolve: (outgoingId: string, decision: ResolveDecisionDto) => void;
  decide: (approvalId: string, decision: "approve" | "reject") => void;
  reviewFlag: (flagId: string, status: FlagReviewStatus) => void;
  toggleHistory: (slackUserId: string) => void;
  sendFollowup: (id: string, text: string) => void;
  discardFollowup: (id: string) => void;
  trackCommitment: (id: string, edits?: CommitmentEditsDto) => void;
  rejectCommitment: (id: string) => void;
  recDecide: (d: Decision) => void;
  recDismiss: (id: string) => void;
  recDiscard: (id: string) => void;
  recRetry: (id: string) => void;
  recEvaluate: (id: string) => void;
  confirmIdentity: (slackUserId: string) => void;
  evaluatePerson: (slackUserId: string) => void;
  seeAllPeople: () => void;
  startBackfill: () => void;
  dismissAwayDigest: (sessionId: string) => void;
  setAway: (on: boolean) => void;
  syncJira: () => void;
  enableJira: (setup: { scopeJql: string; excludedProjects: string[] }) => void;
  seeAllJira: () => void;
}

/** The `lib/api.ts` calls the feed uses; injectable so the routing can be tested. */
export type NeedsYouApi = Pick<
  typeof apiModule,
  | "setUrgentStatus"
  | "requestUrgentReply"
  | "resolveOutgoing"
  | "decideApproval"
  | "reviewFlag"
  | "sendFollowup"
  | "discardFollowup"
  | "reviewCommitment"
  | "dismissSuggestion"
  | "discardRecommendation"
  | "retryApply"
  | "acceptSuggestion"
  | "confirmSlackIdentity"
  | "evaluatePerson"
  | "startBackfill"
  | "dismissAwayDigest"
  | "setAway"
  | "requestJiraSync"
  | "updateJiraSettings"
>;

export const realNeedsYouApi: NeedsYouApi = apiModule;

/**
 * How long a reversible decision waits before its API call (spec D8). The Undo toast
 * (`TOAST_MS`, 4.5 s) closes before this, so Undo is never offered once the commit may have begun.
 */
export const UNDO_DELAY_MS = 5000;

export const TOASTS = {
  tooLateToUndo: "Too late to undo",
  approvalRequested: "Approval request created · nothing is sent until you approve",
  evaluationQueued: "Evaluation queued · draft profile will appear in Needs you for approval",
  backfillQueued: "Backfill queued · runs in the background",
  awayOn: "Away mode on",
  awayOff: "Away mode off",
  jiraSyncQueued: "Jira sync queued · runs in the background",
  jiraEnabled: "Jira tracking on · first sync queued",
  draftDiscarded: "Draft discarded",
  notACommitment: "Marked as not a commitment",
  suggestionDismissed: "Suggestion dismissed",
  flag: {
    acknowledged: "Red flag acknowledged",
    contacted: "Red flag marked as contacted",
    dismissed: "Red flag dismissed",
  } satisfies Record<FlagReviewStatus, string>,
  resolve: {
    mark_sent: "Marked as sent",
    resend: "Resend requested · nothing is sent until you approve",
    discard: "Send discarded",
  } satisfies Record<ResolveDecisionDto, string>,
} as const;

export interface NeedsYouActionsDeps {
  api: NeedsYouApi;
  deferred: Deferred;
  toast: { show(text: string, undo?: () => void): void };
  refresh: () => Promise<string | null>;
  /** The immediate-action error channel; each immediate action clears it when it starts. */
  setActionError: (error: string | null) => void;
  /** A deferred commit's failure; never cleared by another action, only by Dismiss. */
  setDeferredError: (error: string) => void;
  /** Keys whose deferred commit has started; hidden until its refresh lands. */
  committing: { add(key: string): void; delete(key: string): void };
  toggleHistory: (slackUserId: string) => void;
  seeAllPeople: () => void;
  seeAllJira: () => void;
  /** A person whose evaluation was queued: added to the session's queued set People shares. */
  onEvaluationQueued?: (slackUserId: string) => void;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The feed's action routing (spec D8). Reversible local decisions (flag review, commitment
 * reject, suggestion dismiss, draft discard) are deferred commits with Undo: hidden at once,
 * called after the delay, kept hidden while committing so nothing flashes back. A failed commit
 * reports its error on the deferred channel (which no later action clears) and the refresh brings
 * the item back. Everything that sends, approves,
 * queues Claude or starts a backfill calls the API at once.
 */
export function createNeedsYouActions(d: NeedsYouActionsDeps): NeedsYouHandlers {
  const { api, deferred, toast, refresh, setActionError, setDeferredError, committing } = d;

  const defer = (key: string, label: string, commit: () => Promise<unknown>) => {
    setActionError(null);
    deferred.schedule(key, async () => {
      committing.add(key);
      try {
        await commit();
      } catch (e) {
        setDeferredError(message(e));
      } finally {
        await refresh();
        committing.delete(key);
      }
    });
    // A commit that already started can't be taken back: say so instead of failing silently.
    toast.show(label, () => {
      if (!deferred.undo(key)) toast.show(TOASTS.tooLateToUndo);
    });
  };

  const now = async (fn: () => Promise<unknown>, success?: string) => {
    setActionError(null);
    try {
      await fn();
      if (success) toast.show(success);
    } catch (e) {
      setActionError(message(e));
    }
    await refresh();
  };

  // A refusal (no identity, already queued) is a normal result; show it as a notice.
  const evaluate = (
    fn: () => Promise<{ queued: boolean; reason?: string }>,
    onQueued?: () => void,
  ) =>
    now(async () => {
      const r = await fn();
      if (!r.queued) throw new Error(`Not queued: ${r.reason ?? "unknown reason"}`);
      onQueued?.();
    }, TOASTS.evaluationQueued);

  // The decision's error is kept apart from the refresh's, so a good refresh can't hide a 409.
  const decide = async (id: string, decision: "approve" | "reject", reason?: string) => {
    setActionError(null);
    const out = await decideThenRefresh(() => api.decideApproval(id, decision, reason), refresh);
    setActionError(out.actionError);
    if (out.actionError === null) toast.show(decision === "approve" ? "Approved" : "Rejected");
  };

  return {
    urgentStatus: (id, s) => void now(() => api.setUrgentStatus(id, s)),
    urgentReply: (id, text) =>
      void now(() => api.requestUrgentReply(id, text), TOASTS.approvalRequested),
    resolve: (id, dec) => void now(() => api.resolveOutgoing(id, dec), TOASTS.resolve[dec]),
    decide: (id, dec) => void decide(id, dec),
    reviewFlag: (id, s) => defer(flagKey(id), TOASTS.flag[s], () => api.reviewFlag(id, s)),
    toggleHistory: d.toggleHistory,
    sendFollowup: (id, text) =>
      void now(() => api.sendFollowup(id, text), TOASTS.approvalRequested),
    discardFollowup: (id) =>
      defer(`followup:${id}`, TOASTS.draftDiscarded, () => api.discardFollowup(id)),
    trackCommitment: (id, edits) =>
      void now(() => api.reviewCommitment(id, "accept", edits), "Commitment tracked"),
    rejectCommitment: (id) =>
      defer(`commitment:${id}`, TOASTS.notACommitment, () => api.reviewCommitment(id, "reject")),
    recDecide: (r) => void decide(r.approvalId, r.decision, r.reason),
    recDismiss: (id) =>
      defer(`recommendation:${id}`, TOASTS.suggestionDismissed, () => api.dismissSuggestion(id)),
    recDiscard: (id) => void now(() => api.discardRecommendation(id), "Suggestion discarded"),
    recRetry: (id) => void now(() => api.retryApply(id), "New approval created for the profile"),
    recEvaluate: (id) => void evaluate(() => api.acceptSuggestion(id)),
    confirmIdentity: (u) => void now(() => api.confirmSlackIdentity(u), "Identity confirmed"),
    evaluatePerson: (u) =>
      void evaluate(
        () => api.evaluatePerson(u),
        () => d.onEvaluationQueued?.(u),
      ),
    seeAllPeople: d.seeAllPeople,
    startBackfill: () => void now(() => api.startBackfill(), TOASTS.backfillQueued),
    // Immediate, never deferred: dismissing is cheap and the digest has nothing to undo.
    dismissAwayDigest: (id) => void now(() => api.dismissAwayDigest(id)),
    // Immediate: both are local settings or a read-only sync, nothing external is written.
    syncJira: () => void now(() => api.requestJiraSync(), TOASTS.jiraSyncQueued),
    enableJira: (setup) =>
      void now(() => api.updateJiraSettings({ enabled: true, ...setup }), TOASTS.jiraEnabled),
    seeAllJira: d.seeAllJira,
    setAway: (on) => void now(() => api.setAway(on), on ? TOASTS.awayOn : TOASTS.awayOff),
  };
}
