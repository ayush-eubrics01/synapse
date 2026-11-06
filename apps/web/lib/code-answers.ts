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
      return v.sendable
        ? "Reply not sent · you can request it again"
        : "Reply requested · waiting for your approval in Needs you";
    case "dismissed":
      return "Dismissed";
  }
}

/** The answer text is shown for a ready or held row, and for a sent row whose send failed. */
export function showsAnswerText(v: CodeAnswerView): boolean {
  if (v.answer === null) return false;
  return v.status === "ready" || v.status === "held" || (v.status === "sent" && v.sendable);
}

/**
 * "Use as reply" is offered when the backend says the row is sendable (no linked send, or one that
 * was rejected, expired or cancelled before spawn), and for a suspected injection only after
 * "Use anyway". The backend enforces the same rule when the send is requested.
 */
export function canUseAsReply(v: CodeAnswerView, useAnyway: boolean): boolean {
  if (!v.sendable || !showsAnswerText(v)) return false;
  return !v.suspectedInjection?.detected || useAnyway;
}

const TRIGGER_ERRORS: Record<string, string> = {
  already_running: "An answer is already being prepared for this message",
  already_answered: "This message already has an answer. Dismiss it to ask again",
  invalid_repository: "That repository is no longer registered",
  not_found: "That message or answer no longer exists",
  invalid_state: "That answer can no longer be used. Refresh and try again",
  injection_unacknowledged: "Use anyway first: this answer has a suspected injection",
  invalid_text: "The reply must be between 1 and 4000 characters",
};

/** A friendly text for a refused trigger or send; fixed codes only, never the raw error. */
export function codeAnswerErrorText(
  e: unknown,
  fallback = "Could not start the code answer",
): string {
  if (e instanceof ApiError && e.code && TRIGGER_ERRORS[e.code])
    return TRIGGER_ERRORS[e.code] as string;
  return fallback;
}

/** The `code_answer.status_changed` event's message id, or null when the payload names none. */
export function codeAnswerEventMessageId(data: unknown): string | null {
  try {
    const d = (typeof data === "string" ? JSON.parse(data) : data) as {
      messageId?: unknown;
      payload?: { messageId?: unknown };
    } | null;
    const id = d?.payload?.messageId ?? d?.messageId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}
