import { createHash } from "node:crypto";
import type { CommitmentCandidate } from "@synapse/contracts";

/** A batch message as the validator needs it. `authorRef` is the author's Slack user id. */
export interface BatchMessage {
  messageId: string;
  authorRef: string;
  sentAt: string;
  text: string;
  conversationId: string;
  /** `<conversation external id>:<ts>`; kept on the commitment after the message expires. */
  sourceRef: string;
}

export interface ValidCandidate {
  description: string;
  owner: string;
  counterparty: string | null;
  dueAt: string | null;
  kind: CommitmentCandidate["kind"];
  /** Batch message ids only, in the order given, without duplicates. */
  evidence: string[];
  confidence: CommitmentCandidate["confidence"];
}

const YEAR_MS = 365 * 86_400_000;
const MENTION = /(?:<|&lt;)@([UW][A-Z0-9]+)(?:\|[^>&]*)?(?:>|&gt;)/g;

/** Slack ids mentioned as `<@ID>`, `<@ID|name>` or the escaped form. */
export function mentionedIds(text: string): string[] {
  return [...text.matchAll(MENTION)].map((m) => m[1] as string);
}

/** Lowercase, punctuation removed, whitespace collapsed. */
export const normalizeDescription = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** sha256 hex of `owner|counterparty|normalized description`. */
export const dedupKey = (owner: string, counterparty: string | null, description: string): string =>
  createHash("sha256")
    .update(`${owner}|${counterparty ?? ""}|${normalizeDescription(description)}`)
    .digest("hex");

/** The due date as a canonical ISO string when it is after `sentAt` and within a year of it. */
export function sanitizeDueAt(dueAt: string | null, sentAt: string): string | null {
  if (dueAt === null) return null;
  const due = Date.parse(dueAt);
  const sent = Date.parse(sentAt);
  if (Number.isNaN(due) || Number.isNaN(sent)) return null;
  return due > sent && due <= sent + YEAR_MS ? new Date(due).toISOString() : null;
}

/**
 * Hallucination guard. A candidate survives only when it cites at least one batch message (other
 * ids are removed), is not low confidence, and its owner and counterparty are each the author of a
 * cited message or a Slack id mentioned in one (the user counts as an author when they wrote it).
 * The due date is kept only when plausible; the description is trimmed.
 */
export function validateCandidates(
  candidates: CommitmentCandidate[],
  batch: BatchMessage[],
): { valid: ValidCandidate[]; dropped: number } {
  const byId = new Map(batch.map((m) => [m.messageId, m]));
  const valid: ValidCandidate[] = [];
  for (const c of candidates) {
    const evidence = [...new Set(c.evidence.filter((id) => byId.has(id)))];
    if (evidence.length === 0 || c.confidence === "low") continue;
    const cited = evidence.map((id) => byId.get(id) as BatchMessage);
    const people = new Set<string>();
    for (const m of cited) {
      people.add(m.authorRef);
      for (const id of mentionedIds(m.text)) people.add(id);
    }
    if (!people.has(c.owner)) continue;
    if (c.counterparty !== null && (!people.has(c.counterparty) || c.counterparty === c.owner)) {
      continue;
    }
    const description = c.description.trim();
    if (description === "") continue;
    const latest = cited
      .map((m) => m.sentAt)
      .reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    valid.push({
      description,
      owner: c.owner,
      counterparty: c.counterparty,
      dueAt: sanitizeDueAt(c.dueAt, latest),
      kind: c.kind,
      evidence,
      confidence: c.confidence,
    });
  }
  return { valid, dropped: candidates.length - valid.length };
}
