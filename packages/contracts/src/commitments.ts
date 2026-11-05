import { z } from "zod";
import { strictSuspectedInjectionSchema } from "./urgency";

const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]+$/);

export const commitmentDirectionSchema = z.enum(["mine", "theirs"]);
export const commitmentStatusSchema = z.enum([
  "open",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
]);
export const commitmentReviewStatusSchema = z.enum(["pending_review", "accepted", "rejected"]);
export const followupOriginSchema = z.enum(["stalled", "spec_clarity", "urgent_reply", "manual"]);
export const followupStatusSchema = z.enum([
  "draft",
  "awaiting_approval",
  "sending",
  "sent",
  "needs_attention",
  "discarded",
  "failed",
]);

export type CommitmentDirection = z.infer<typeof commitmentDirectionSchema>;
export type CommitmentStatus = z.infer<typeof commitmentStatusSchema>;
export type CommitmentReviewStatus = z.infer<typeof commitmentReviewStatusSchema>;
export type FollowupOrigin = z.infer<typeof followupOriginSchema>;
export type FollowupStatus = z.infer<typeof followupStatusSchema>;

export const commitmentCandidateSchema = z
  .object({
    description: z.string().min(1).max(500),
    owner: slackUserIdSchema,
    counterparty: slackUserIdSchema.nullable(),
    dueAt: z.string().datetime({ offset: true }).nullable(),
    evidence: z.array(z.string()).min(1).max(5),
    kind: z.enum(["promise", "request_accepted", "completion"]),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();
export type CommitmentCandidate = z.infer<typeof commitmentCandidateSchema>;

export const commitmentExtractionOutputSchema = z
  .object({
    candidates: z.array(commitmentCandidateSchema).max(40),
    suspectedInjection: strictSuspectedInjectionSchema,
  })
  .strict();
export type CommitmentExtractionOutput = z.infer<typeof commitmentExtractionOutputSchema>;

export const followupDraftOutputSchema = z
  .object({
    draft: z.string().min(1).max(4000),
    confidence: z.number().min(0).max(1),
    suspectedInjection: strictSuspectedInjectionSchema,
  })
  .strict();
export type FollowupDraftOutput = z.infer<typeof followupDraftOutputSchema>;

export const specClarityOutputSchema = z
  .object({
    clear: z.boolean(),
    missing: z
      .array(z.enum(["expected_behaviour", "steps", "scope", "environment", "acceptance_criteria"]))
      .max(5),
    questions: z.array(z.string().min(1).max(300)).max(5),
    suspectedInjection: strictSuspectedInjectionSchema,
  })
  .strict();
export type SpecClarityOutput = z.infer<typeof specClarityOutputSchema>;

export const commitmentFilterSchema = z.enum([
  "all",
  "mine",
  "theirs",
  "open",
  "in_progress",
  "blocked",
  "overdue",
  "due_soon",
  "closed",
  "review",
]);
export type CommitmentFilter = z.infer<typeof commitmentFilterSchema>;

export const commitmentActionSchema = z.enum([
  "accept",
  "reject",
  "edit",
  "start",
  "block",
  "unblock",
  "complete",
  "cancel",
  "confirm_proposal",
]);
export type CommitmentAction = z.infer<typeof commitmentActionSchema>;

export interface CommitmentSourceView {
  sourceExternalRef: string;
  /** False once the message content expired or was removed; the ref stays. */
  messageAvailable: boolean;
  /** http(s) only, null when the message is unavailable. */
  permalink: string | null;
}

export interface PendingProposalView {
  updateId: string;
  sourceExternalRef: string;
  proposedAt: string;
}

export interface CommitmentFollowupSummary {
  id: string;
  origin: FollowupOrigin;
  status: FollowupStatus;
}

export interface CommitmentView {
  id: string;
  description: string;
  ownerSlackUserId: string;
  ownerName: string | null;
  counterpartySlackUserId: string | null;
  counterpartyName: string | null;
  direction: CommitmentDirection;
  status: CommitmentStatus;
  reviewStatus: CommitmentReviewStatus;
  dueAt: string | null;
  nextAction: string | null;
  completionEvidence: string | null;
  stalledAt: string | null;
  lastFollowupAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sources: CommitmentSourceView[];
  proposals: PendingProposalView[];
  followups: CommitmentFollowupSummary[];
  actions: CommitmentAction[];
}

export interface FollowupView {
  id: string;
  commitmentId: string | null;
  origin: FollowupOrigin;
  originMessageId: string | null;
  conversationId: string;
  threadTs: string | null;
  recipientSlackUserId: string | null;
  draftText: string | null;
  confidence: number | null;
  status: FollowupStatus;
  approvalId: string | null;
  outgoingId: string | null;
  createdAt: string;
  updatedAt: string;
}
