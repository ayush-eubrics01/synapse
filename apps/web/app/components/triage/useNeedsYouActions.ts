"use client";

import { useState } from "react";
import {
  acceptSuggestion,
  confirmSlackIdentity,
  decideApproval,
  discardFollowup,
  discardRecommendation,
  dismissSuggestion,
  evaluatePerson,
  type FlagReviewStatus,
  type ResolveDecisionDto,
  requestUrgentReply,
  resolveOutgoing,
  retryApply,
  reviewCommitment,
  reviewFlag,
  sendFollowup,
  setUrgentStatus,
  startBackfill,
} from "../../../lib/api";
import { decideThenRefresh } from "../../../lib/decide";
import { useDeferred } from "../../../lib/deferred";
import { flagKey } from "../../../lib/needs-you";
import { TOAST_MS, useToast } from "../ui/Toasts";
import type { NeedsYouHandlers } from "./NeedsYou";

const APPROVAL_REQUESTED = "Approval request created · nothing is sent until you approve";
const EVALUATION_QUEUED = "Evaluation queued · draft profile will appear in Needs you for approval";
const FLAG_TOAST: Record<FlagReviewStatus, string> = {
  acknowledged: "Red flag acknowledged",
  contacted: "Red flag marked as contacted",
  dismissed: "Red flag dismissed",
};
const RESOLVE_TOAST: Record<ResolveDecisionDto, string> = {
  mark_sent: "Marked as sent",
  resend: "Resend requested · nothing is sent until you approve",
  discard: "Send discarded",
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface NeedsYouActionsOptions {
  refresh: () => Promise<string | null>;
  setActionError: (error: string | null) => void;
  toggleHistory: (slackUserId: string) => void;
  seeAllPeople: () => void;
}

/**
 * The feed's actions. Reversible local decisions (flag review, commitment reject, suggestion
 * dismiss, draft discard) are deferred commits with Undo (spec D8): hidden at once, sent after
 * 5 s. Their keys stay hidden until the commit's refresh lands, so neither an SSE refresh nor the
 * commit itself can flash them back. A failed commit shows its error and the item reappears.
 * Everything that sends, approves, queues Claude or starts a backfill runs at once.
 */
export function useNeedsYouActions(opts: NeedsYouActionsOptions): {
  handlers: NeedsYouHandlers;
  hidden: Set<string>;
} {
  const { refresh, setActionError } = opts;
  const toast = useToast();
  const [committing, setCommitting] = useState<Set<string>>(() => new Set());
  const deferred = useDeferred(TOAST_MS, (e) => setActionError(message(e)));

  const defer = (key: string, label: string, commit: () => Promise<unknown>) => {
    setActionError(null);
    deferred.schedule(key, async () => {
      setCommitting((s) => new Set(s).add(key));
      try {
        await commit();
      } finally {
        await refresh();
        setCommitting((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    });
    toast.show(label, () => deferred.undo(key));
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
  const evaluate = (fn: () => Promise<{ queued: boolean; reason?: string }>) =>
    now(async () => {
      const r = await fn();
      if (!r.queued) throw new Error(`Not queued: ${r.reason ?? "unknown reason"}`);
    }, EVALUATION_QUEUED);

  // The decision's error is kept apart from the refresh's, so a good refresh can't hide a 409.
  const decide = async (id: string, decision: "approve" | "reject", reason?: string) => {
    setActionError(null);
    const out = await decideThenRefresh(() => decideApproval(id, decision, reason), refresh);
    setActionError(out.actionError);
    if (out.actionError === null) toast.show(decision === "approve" ? "Approved" : "Rejected");
  };

  const handlers: NeedsYouHandlers = {
    urgentStatus: (id, s) => void now(() => setUrgentStatus(id, s)),
    urgentReply: (id, text) => void now(() => requestUrgentReply(id, text), APPROVAL_REQUESTED),
    resolve: (id, d) => void now(() => resolveOutgoing(id, d), RESOLVE_TOAST[d]),
    decide: (id, d) => void decide(id, d),
    reviewFlag: (id, s) => defer(flagKey(id), FLAG_TOAST[s], () => reviewFlag(id, s)),
    toggleHistory: opts.toggleHistory,
    sendFollowup: (id, text) => void now(() => sendFollowup(id, text), APPROVAL_REQUESTED),
    discardFollowup: (id) => defer(`followup:${id}`, "Draft discarded", () => discardFollowup(id)),
    trackCommitment: (id, edits) =>
      void now(() => reviewCommitment(id, "accept", edits), "Commitment tracked"),
    rejectCommitment: (id) =>
      defer(`commitment:${id}`, "Marked as not a commitment", () => reviewCommitment(id, "reject")),
    recDecide: (d) => void decide(d.approvalId, d.decision, d.reason),
    recDismiss: (id) =>
      defer(`recommendation:${id}`, "Suggestion dismissed", () => dismissSuggestion(id)),
    recDiscard: (id) => void now(() => discardRecommendation(id), "Suggestion discarded"),
    recRetry: (id) => void now(() => retryApply(id), "New approval created for the profile"),
    recEvaluate: (id) => void evaluate(() => acceptSuggestion(id)),
    confirmIdentity: (u) => void now(() => confirmSlackIdentity(u), "Identity confirmed"),
    evaluatePerson: (u) => void evaluate(() => evaluatePerson(u)),
    seeAllPeople: opts.seeAllPeople,
    startBackfill: () =>
      void now(() => startBackfill(), "Backfill queued · runs in the background"),
  };

  return { handlers, hidden: new Set([...deferred.pending(), ...committing]) };
}
