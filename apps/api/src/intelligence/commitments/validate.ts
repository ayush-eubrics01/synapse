import { createHash } from "node:crypto";
import type { CommitmentCandidate } from "@synapse/contracts";

/** A batch message as the validator needs it. `authorRef` is the author's Slack user id. */
/** Content-free counts of why candidates were dropped (job result and smoke output only). */
export type DropReason =
  | "no_evidence"
  | "low_confidence"
  | "owner_not_participant"
  | "counterparty_invalid"
  | "not_involving_user"
  | "empty_description";

export interface BatchMessage {
  messageId: string;
  authorRef: string;
  sentAt: string;
  text: string;
  conversationId: string;
  /** `<conversation external id>:<ts>`; kept on the commitment after the message expires. */
  sourceRef: string;
  /** R8: in an `im` conversation, the non-self participant; null elsewhere or when unknown. */
  dmPartner?: string | null;
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
 * cited message, a Slack id mentioned in one (the user counts as an author when they wrote it), or
 * the DM partner of a cited message's `im` conversation (R8). At least one of them must be the user
 * (R10 d): other people's commitments to each other are not tracked.
 * The due date is kept only when plausible; the description is trimmed.
 */
export function validateCandidates(
  candidates: CommitmentCandidate[],
  batch: BatchMessage[],
  selfUserId: string,
): { valid: ValidCandidate[]; dropped: number; dropReasons: Record<DropReason, number> } {
  const byId = new Map(batch.map((m) => [m.messageId, m]));
  const valid: ValidCandidate[] = [];
  const dropReasons: Record<DropReason, number> = {
    no_evidence: 0,
    low_confidence: 0,
    owner_not_participant: 0,
    counterparty_invalid: 0,
    not_involving_user: 0,
    empty_description: 0,
  };
  const drop = (r: DropReason) => {
    dropReasons[r] += 1;
  };
  for (const c of candidates) {
    const evidence = [...new Set(c.evidence.filter((id) => byId.has(id)))];
    if (evidence.length === 0) {
      drop("no_evidence");
      continue;
    }
    if (c.confidence === "low") {
      drop("low_confidence");
      continue;
    }
    const cited = evidence.map((id) => byId.get(id) as BatchMessage);
    const people = new Set<string>();
    // An `im` has exactly two participants. The user is always the other one, so they may be the
    // counterparty without writing a cited message; as owner they still need a message of their own.
    const counterparties = new Set<string>();
    for (const m of cited) {
      people.add(m.authorRef);
      if (m.dmPartner) {
        people.add(m.dmPartner);
        counterparties.add(selfUserId);
      }
      for (const id of mentionedIds(m.text)) people.add(id);
    }
    for (const p of people) counterparties.add(p);
    if (!people.has(c.owner)) {
      drop("owner_not_participant");
      continue;
    }
    // In one 1:1 DM, a commitment between the two participants is owed to the other one.
    let counterparty = c.counterparty;
    const partners = new Set(cited.map((m) => m.dmPartner ?? null));
    if (counterparty === null && partners.size === 1 && !partners.has(null)) {
      const partner = [...partners][0] as string;
      if (c.owner === partner) counterparty = selfUserId;
      else if (c.owner === selfUserId) counterparty = partner;
    }
    if (counterparty !== null && (!counterparties.has(counterparty) || counterparty === c.owner)) {
      drop("counterparty_invalid");
      continue;
    }
    if (c.owner !== selfUserId && counterparty !== selfUserId) {
      drop("not_involving_user");
      continue;
    }
    const description = c.description.trim();
    if (description === "") {
      drop("empty_description");
      continue;
    }
    const latest = cited
      .map((m) => m.sentAt)
      .reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    valid.push({
      description,
      owner: c.owner,
      counterparty,
      dueAt: sanitizeDueAt(c.dueAt, latest),
      kind: c.kind,
      evidence,
      confidence: c.confidence,
    });
  }
  return { valid, dropped: candidates.length - valid.length, dropReasons };
}
