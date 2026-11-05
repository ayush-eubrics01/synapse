import type {
  CommitmentAction,
  CommitmentFilter,
  CommitmentStatus,
  CommitmentView,
} from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import { safePermalink } from "../inbox/permalink";
import { PROPOSED_REASON_PREFIX } from "./store";

const { commitments, commitmentSources, commitmentUpdates, followups, slackMessages, slackUsers } =
  schema;

export type ReviewDecision = "accept" | "reject";

export interface ReviewEdits {
  description?: string;
  /** Offset ISO date-time (stored as UTC), or null to clear the due date. */
  dueAt?: string | null;
  owner?: string;
  counterparty?: string | null;
}

export class UnknownCommitment extends Error {
  constructor() {
    super("unknown commitment");
    this.name = "UnknownCommitment";
  }
}
/** Accept or reject of a commitment that is not pending review. */
export class InvalidReview extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidReview";
  }
}
/** An edit value failed validation. */
export class InvalidCommitmentEdit extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidCommitmentEdit";
  }
}
export class InvalidCommitmentTransition extends Error {
  constructor(from: string, to: string, detail?: string) {
    super(detail ?? `cannot move a commitment from ${from} to ${to}`);
    this.name = "InvalidCommitmentTransition";
  }
}
/** Unknown update, not an AI completion proposal, or already decided. */
export class InvalidProposal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidProposal";
  }
}

/** No update row with that id (404). */
export class UnknownProposal extends InvalidProposal {
  constructor() {
    super("unknown proposal");
    this.name = "UnknownProposal";
  }
}

const TRANSITIONS: Record<CommitmentStatus, CommitmentStatus[]> = {
  open: ["in_progress", "blocked", "completed", "cancelled"],
  in_progress: ["blocked", "completed", "cancelled"],
  blocked: ["open", "in_progress", "cancelled", "completed"],
  completed: [],
  cancelled: [],
};
const isTerminal = (s: CommitmentStatus) => s === "completed" || s === "cancelled";

/** Decision rows on a proposal (user actor, `field: status`); their reason ends in the proposal's update id. */
/** `field` of a proposal decision row, so a decision never reads as a status change. */
export const PROPOSAL_FIELD = "proposal";
export const CONFIRMED_PROPOSAL_PREFIX = "confirmed_proposal:";
export const REJECTED_PROPOSAL_PREFIX = "rejected_proposal:";

export const DEFAULT_VIEW_LIMIT = 200;
export const MAX_VIEW_LIMIT = 500;

const SLACK_ID = /^[UW][A-Z0-9]+$/;
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface CommitmentLifecycleDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  events: EventPublisher;
}

type Row = typeof commitments.$inferSelect;
type UpdateRow = typeof commitmentUpdates.$inferSelect;

/**
 * The user's side of commitments: review, status lifecycle with history, proposal decisions and
 * the list views. No AI. Events carry ids and enums only; no commitment text leaves the tables.
 */
/** `commitment_updates.field` of the user's review decision (`to_value` accepted or rejected). */
export const REVIEW_STATUS_FIELD = "review_status";

export class CommitmentLifecycle {
  constructor(private readonly deps: CommitmentLifecycleDeps) {}

  review(id: string, decision: ReviewDecision, edits?: ReviewEdits): void {
    const { db, events } = this.deps;
    db.transaction((tx) => {
      const row = this.load(tx, id);
      if (row.reviewStatus !== "pending_review") {
        throw new InvalidReview("commitment is not pending review");
      }
      const hasEdits = edits !== undefined && Object.keys(edits).length > 0;
      if (decision === "reject" && hasEdits) throw new InvalidReview("a rejection takes no edits");
      const now = isoNow(this.deps.clock);
      const patch = hasEdits ? this.validateEdits(row, edits) : { set: {}, changes: {} };
      for (const [field, change] of Object.entries(patch.changes)) {
        this.writeUpdate(tx, row.id, "user", field, change.from, change.to, null, now);
      }
      const reviewStatus = decision === "accept" ? "accepted" : "rejected";
      // The user's decision is recorded (content-free): drafting treats a description as
      // user-approved only when this row exists.
      this.writeUpdate(
        tx,
        row.id,
        "user",
        REVIEW_STATUS_FIELD,
        row.reviewStatus,
        reviewStatus,
        null,
        now,
      );
      tx.update(commitments)
        .set({ ...patch.set, reviewStatus, updatedAt: now })
        .where(eq(commitments.id, id))
        .run();
      events.publish(tx, {
        type: "commitment.reviewed",
        aggregateType: "commitment",
        aggregateId: id,
        correlationId: newId(),
        payload: { commitmentId: id, reviewStatus },
      });
    });
  }

  setStatus(id: string, status: CommitmentStatus, reason?: string): void {
    if (
      reason !== undefined &&
      (reason.startsWith(CONFIRMED_PROPOSAL_PREFIX) || reason.startsWith(REJECTED_PROPOSAL_PREFIX))
    ) {
      throw new InvalidCommitmentEdit("reason uses a reserved prefix");
    }
    this.deps.db.transaction((tx) => {
      const row = this.load(tx, id);
      this.applyStatus(tx, row, status, "user", reason ?? null, null);
    });
  }

  /**
   * Decides a pending AI completion proposal. Accepting completes the commitment through the
   * normal transition rules with the proposal's source ref as evidence; rejecting only records
   * the decision (also allowed on a closed commitment). Either way a decision row (`field: proposal`) (`confirmed_proposal:<id>` / `rejected_proposal:<id>`)
   * marks the proposal decided, so it cannot be decided twice.
   */
  confirmProposal(updateId: string, accept: boolean): void {
    this.deps.db.transaction((tx) => {
      const proposal = tx
        .select()
        .from(commitmentUpdates)
        .where(eq(commitmentUpdates.id, updateId))
        .get();
      if (!proposal) throw new UnknownProposal();
      if (!isProposal(proposal)) throw new InvalidProposal("not a pending proposal");
      const history = tx
        .select()
        .from(commitmentUpdates)
        .where(eq(commitmentUpdates.commitmentId, proposal.commitmentId))
        .all();
      if (decidedIds(history).has(updateId)) throw new InvalidProposal("proposal already decided");
      const row = this.load(tx, proposal.commitmentId);
      if (accept) {
        const evidence = (proposal.reason ?? "").slice(PROPOSED_REASON_PREFIX.length);
        this.applyStatus(tx, row, "completed", "user", `accepted_proposal:${updateId}`, evidence);
        this.writeUpdate(
          tx,
          row.id,
          "user",
          PROPOSAL_FIELD,
          null,
          null,
          `${CONFIRMED_PROPOSAL_PREFIX}${updateId}`,
          isoNow(this.deps.clock),
        );
      } else {
        this.writeUpdate(
          tx,
          row.id,
          "user",
          PROPOSAL_FIELD,
          null,
          null,
          `${REJECTED_PROPOSAL_PREFIX}${updateId}`,
          isoNow(this.deps.clock),
        );
      }
    });
  }

  listViews(filter: CommitmentFilter, limit = DEFAULT_VIEW_LIMIT): CommitmentView[] {
    const { db, clock, settings } = this.deps;
    const nowMs = clock.now().getTime();
    const soonMs = nowMs + settings.get("commitments.reminder.dueSoonHours") * 3_600_000;
    const all = db.select().from(commitments).orderBy(desc(commitments.createdAt)).all();
    const dueMs = (r: Row) => (r.dueAt === null ? null : Date.parse(r.dueAt));
    const isOverdue = (r: Row) => {
      const d = dueMs(r);
      return d !== null && d < nowMs && !isTerminal(r.status);
    };
    const accepted = all.filter((r) => r.reviewStatus === "accepted");
    const live = accepted.filter((r) => !isTerminal(r.status));
    const rows = (() => {
      switch (filter) {
        case "review":
          return all.filter((r) => r.reviewStatus !== "accepted");
        case "all":
          return accepted;
        case "mine":
          return live.filter((r) => r.direction === "mine");
        case "theirs":
          return live.filter((r) => r.direction === "theirs");
        case "open":
        case "in_progress":
        case "blocked":
          return accepted.filter((r) => r.status === filter);
        case "overdue":
          return accepted.filter(isOverdue);
        case "due_soon":
          return live.filter((r) => {
            const d = dueMs(r);
            return d !== null && d >= nowMs && d <= soonMs;
          });
        case "closed":
          return accepted.filter((r) => isTerminal(r.status));
      }
    })();
    rows.sort((a, b) => {
      const oa = isOverdue(a);
      const ob = isOverdue(b);
      if (oa !== ob) return oa ? -1 : 1;
      const da = dueMs(a);
      const dbm = dueMs(b);
      if (da !== null && dbm !== null && da !== dbm) return da - dbm;
      if ((da === null) !== (dbm === null)) return da === null ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });
    const cap = Math.min(Math.max(Math.trunc(limit) || DEFAULT_VIEW_LIMIT, 1), MAX_VIEW_LIMIT);
    return this.toViews(rows.slice(0, cap));
  }

  private load(tx: Tx, id: string): Row {
    const row = tx.select().from(commitments).where(eq(commitments.id, id)).get();
    if (!row) throw new UnknownCommitment();
    return row;
  }

  private writeUpdate(
    tx: Tx,
    commitmentId: string,
    actor: "user" | "system" | "ai",
    field: string,
    from: string | null,
    to: string | null,
    reason: string | null,
    now: string,
  ) {
    tx.insert(commitmentUpdates)
      .values({
        id: newId(),
        commitmentId,
        actor,
        field,
        fromValue: from,
        toValue: to,
        reason,
        createdAt: now,
      })
      .run();
  }

  private applyStatus(
    tx: Tx,
    row: Row,
    to: CommitmentStatus,
    actor: "user",
    reason: string | null,
    evidence: string | null,
  ) {
    if (row.reviewStatus !== "accepted") {
      throw new InvalidCommitmentTransition(row.status, to, "commitment is not accepted");
    }
    if (!TRANSITIONS[row.status].includes(to))
      throw new InvalidCommitmentTransition(row.status, to);
    const now = isoNow(this.deps.clock);
    this.writeUpdate(tx, row.id, actor, "status", row.status, to, reason, now);
    tx.update(commitments)
      .set({
        status: to,
        updatedAt: now,
        ...(isTerminal(to) ? { closedAt: now } : {}),
        ...(evidence !== null ? { completionEvidence: evidence } : {}),
      })
      .where(eq(commitments.id, row.id))
      .run();
    this.deps.events.publish(tx, {
      type: "commitment.status_changed",
      aggregateType: "commitment",
      aggregateId: row.id,
      correlationId: newId(),
      payload: { commitmentId: row.id, status: to },
    });
  }

  private validateEdits(row: Row, edits: ReviewEdits) {
    const set: Partial<Row> = {};
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    const change = (field: string, from: string | null, to: string | null) => {
      if (from !== to) changes[field] = { from, to };
    };
    if (edits.description !== undefined) {
      const d = edits.description.trim();
      if (d.length < 1 || d.length > 500) {
        throw new InvalidCommitmentEdit("description must be 1 to 500 characters");
      }
      set.description = d;
      change("description", row.description, d);
    }
    if (edits.dueAt !== undefined) {
      if (
        edits.dueAt !== null &&
        !(OFFSET_ISO.test(edits.dueAt) && !Number.isNaN(Date.parse(edits.dueAt)))
      ) {
        throw new InvalidCommitmentEdit("dueAt must be an ISO date-time with a UTC offset");
      }
      const due = edits.dueAt === null ? null : new Date(edits.dueAt).toISOString();
      set.dueAt = due;
      change("due_at", row.dueAt, due);
    }
    if (edits.owner !== undefined || edits.counterparty !== undefined) {
      const self = this.deps.settings.get("slack.selfUserId");
      const owner = edits.owner ?? row.ownerSlackUserId;
      const counterparty =
        edits.counterparty !== undefined ? edits.counterparty : row.counterpartySlackUserId;
      if (!SLACK_ID.test(owner) || (counterparty !== null && !SLACK_ID.test(counterparty))) {
        throw new InvalidCommitmentEdit("owner and counterparty must be Slack user ids");
      }
      if (owner === counterparty) {
        throw new InvalidCommitmentEdit("owner and counterparty must differ");
      }
      if (self === null || (owner !== self && counterparty !== self)) {
        throw new InvalidCommitmentEdit("the user must be the owner or the counterparty");
      }
      set.ownerSlackUserId = owner;
      set.counterpartySlackUserId = counterparty;
      const direction = owner === self ? "mine" : "theirs";
      set.direction = direction;
      change("owner", row.ownerSlackUserId, owner);
      change("counterparty", row.counterpartySlackUserId, counterparty);
      change("direction", row.direction, direction);
    }
    return { set, changes };
  }

  private toViews(rows: Row[]): CommitmentView[] {
    if (rows.length === 0) return [];
    const { db } = this.deps;
    const ids = rows.map((r) => r.id);
    const sources = db
      .select({
        commitmentId: commitmentSources.commitmentId,
        ref: commitmentSources.sourceExternalRef,
        messageId: slackMessages.id,
        text: slackMessages.text,
        permalink: slackMessages.permalink,
      })
      .from(commitmentSources)
      .leftJoin(slackMessages, eq(slackMessages.id, commitmentSources.messageId))
      .where(inArray(commitmentSources.commitmentId, ids))
      .orderBy(asc(commitmentSources.createdAt), asc(commitmentSources.id))
      .all();
    const updates = db
      .select()
      .from(commitmentUpdates)
      .where(inArray(commitmentUpdates.commitmentId, ids))
      .orderBy(asc(commitmentUpdates.createdAt), asc(commitmentUpdates.id))
      .all();
    const fups = db
      .select({
        commitmentId: followups.commitmentId,
        id: followups.id,
        origin: followups.origin,
        status: followups.status,
      })
      .from(followups)
      .where(inArray(followups.commitmentId, ids))
      .orderBy(asc(followups.createdAt), asc(followups.id))
      .all();
    const group = <T extends { commitmentId: string | null }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of list) {
        if (x.commitmentId === null) continue;
        const l = m.get(x.commitmentId);
        if (l) l.push(x);
        else m.set(x.commitmentId, [x]);
      }
      return m;
    };
    const sourcesBy = group(sources);
    const updatesBy = group(updates);
    const followupsBy = group(fups);
    const slackIds = [
      ...new Set(rows.flatMap((r) => [r.ownerSlackUserId, r.counterpartySlackUserId ?? ""])),
    ].filter((x) => x !== "");
    const people = new Map(
      db
        .select({ externalId: slackUsers.externalId, name: slackUsers.name })
        .from(slackUsers)
        .where(inArray(slackUsers.externalId, slackIds))
        .all()
        .map((u) => [u.externalId, u.name]),
    );
    return rows.map((r) => {
      const mine = updatesBy.get(r.id) ?? [];
      const decided = decidedIds(mine);
      const proposals = isTerminal(r.status)
        ? []
        : mine
            .filter((u) => isProposal(u) && !decided.has(u.id))
            .map((u) => ({
              updateId: u.id,
              sourceExternalRef: (u.reason ?? "").slice(PROPOSED_REASON_PREFIX.length),
              proposedAt: u.createdAt,
            }));
      return {
        id: r.id,
        description: r.description,
        ownerSlackUserId: r.ownerSlackUserId,
        ownerName: people.get(r.ownerSlackUserId) ?? null,
        counterpartySlackUserId: r.counterpartySlackUserId,
        counterpartyName:
          r.counterpartySlackUserId === null
            ? null
            : (people.get(r.counterpartySlackUserId) ?? null),
        direction: r.direction,
        status: r.status,
        reviewStatus: r.reviewStatus,
        dueAt: r.dueAt,
        nextAction: r.nextAction,
        stalledAt: r.stalledAt,
        lastFollowupAt: r.lastFollowupAt,
        completionEvidence: r.completionEvidence,
        closedAt: r.closedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        sources: (sourcesBy.get(r.id) ?? []).map((s) => {
          const messageAvailable = s.messageId !== null && s.text !== null;
          return {
            sourceExternalRef: s.ref,
            messageAvailable,
            permalink: messageAvailable ? safePermalink(s.permalink) : null,
          };
        }),
        proposals,
        followups: (followupsBy.get(r.id) ?? []).map((f) => ({
          id: f.id,
          origin: f.origin,
          status: f.status,
        })),
        actions: actionsFor(r, proposals.length > 0),
      };
    });
  }
}

function isProposal(u: UpdateRow): boolean {
  return (
    u.actor === "ai" &&
    u.field === "status" &&
    u.toValue === "completed" &&
    (u.reason ?? "").startsWith(PROPOSED_REASON_PREFIX)
  );
}

/** Update ids of proposals that have a user decision row. */
function decidedIds(history: UpdateRow[]): Set<string> {
  const out = new Set<string>();
  for (const u of history) {
    if (u.actor !== "user" || u.field !== PROPOSAL_FIELD || u.reason === null) continue;
    for (const p of [CONFIRMED_PROPOSAL_PREFIX, REJECTED_PROPOSAL_PREFIX]) {
      if (u.reason.startsWith(p)) out.add(u.reason.slice(p.length));
    }
  }
  return out;
}

function actionsFor(r: Row, hasProposals: boolean): CommitmentAction[] {
  if (r.reviewStatus === "pending_review") return ["accept", "reject", "edit"];
  if (r.reviewStatus === "rejected" || isTerminal(r.status)) return [];
  const byStatus: Record<string, CommitmentAction[]> = {
    open: ["start", "block", "complete", "cancel"],
    in_progress: ["block", "complete", "cancel"],
    blocked: ["unblock", "start", "complete", "cancel"],
  };
  const actions = [...(byStatus[r.status] ?? [])];
  if (hasProposals) actions.push("confirm_proposal");
  // A manual follow-up draft: only for something owed to the user (mirrors requestManualDraft).
  if (r.direction === "theirs") actions.push("draft_followup");
  return actions;
}
