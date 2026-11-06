import type { CodeAnswerEvidence, CodeAnswerView, RepositoryView } from "@synapse/contracts";
import { ApiError } from "./api";

/** The only repository when exactly one is registered; otherwise the user chooses. */
export function preselectRepository(repos: RepositoryView[]): string | null {
  return repos.length === 1 ? (repos[0]?.id ?? null) : null;
}

/** `path:line`, or `path` without a line. Plain text, never a link. */
export function formatEvidence(e: CodeAnswerEvidence): string {
  return e.line === undefined ? e.path : `${e.path}:${e.line}`;
}

/** One line for the status of a row; model-written reasons are shown as plain text by the caller. */
export function codeAnswerStatusText(v: CodeAnswerView): string {
  switch (v.status) {
    case "queued":
      return "Queued · runs in the background";
    case "running":
      return "Reading the code…";
    case "ready":
      return "Answer ready · review it before using it";
    case "held":
      return "Held for your review";
    case "not_answerable":
      return `Not answerable from the code${v.notAnswerableReason ? `: ${v.notAnswerableReason}` : ""}`;
    case "unverified":
      return "No verified evidence found, so no answer is shown";
    case "failed":
      return `Failed${v.failure ? `: ${v.failure}` : ""}`;
    case "sent":
      return "Reply requested · waiting for your approval in Needs you";
    case "dismissed":
      return "Dismissed";
  }
}

/**
 * "Use as reply" is offered for a ready or held answer, and for a suspected injection only after
 * "Use anyway". The backend enforces the same rule when the send is requested.
 */
export function canUseAsReply(v: CodeAnswerView, useAnyway: boolean): boolean {
  if ((v.status !== "ready" && v.status !== "held") || v.answer === null) return false;
  return !v.suspectedInjection?.detected || useAnyway;
}

const TRIGGER_ERRORS: Record<string, string> = {
  already_running: "An answer is already being prepared for this message",
  already_answered: "This message already has an answer. Dismiss it to ask again",
  invalid_repository: "That repository is no longer registered",
  not_found: "That message no longer exists",
};

/** A friendly text for a refused trigger; fixed codes only. */
export function codeAnswerErrorText(e: unknown): string {
  if (e instanceof ApiError && e.code && TRIGGER_ERRORS[e.code])
    return TRIGGER_ERRORS[e.code] as string;
  return "Could not start the code answer";
}
