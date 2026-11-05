import { z } from "zod";
import type { ApprovalStatus } from "./approvals";
import { flagSeveritySchema } from "./urgency";

export const profileSectionSchema = z.enum([
  "professionalContext",
  "communication",
  "responseGuidelines",
]);
export type ProfileSection = z.infer<typeof profileSectionSchema>;
const sectionSchema = profileSectionSchema;

/** Strict variant for people outputs: no extra key (a priority, say) may ride along. */
const strictInjectionSchema = z
  .object({
    detected: z.boolean(),
    severity: flagSeveritySchema,
    quote: z.string().max(300),
    reason: z.string().max(300),
  })
  .strict();

export const confidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof confidenceSchema>;

/** One evidence-cited observation. Strict: no AI output may carry a priority or any other key. */
export const observationSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
    text: z.string().min(1).max(500),
    evidence: z.array(z.string()).min(1).max(10),
    confidence: confidenceSchema,
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;

export const profileContentSchema = z
  .object({
    professionalContext: z.array(observationSchema).max(20),
    communication: z.array(observationSchema).max(20),
    responseGuidelines: z.array(observationSchema).max(20),
  })
  .strict();
export type ProfileContent = z.infer<typeof profileContentSchema>;

export const initialProfileOutputSchema = z
  .object({ profile: profileContentSchema, suspectedInjection: strictInjectionSchema })
  .strict();
export type InitialProfileOutput = z.infer<typeof initialProfileOutputSchema>;

/** A modify is a remove plus an add with the same key. */
export const profileUpdateOutputSchema = z
  .object({
    add: z.array(observationSchema.extend({ section: sectionSchema })).max(20),
    remove: z
      .array(
        z
          .object({
            section: sectionSchema,
            key: z.string(),
            evidence: z.array(z.string()).min(1).max(10),
          })
          .strict(),
      )
      .max(20),
    suspectedInjection: strictInjectionSchema,
  })
  .strict();
export type ProfileUpdateOutput = z.infer<typeof profileUpdateOutputSchema>;

export const unknownAssessmentOutputSchema = z
  .object({
    assessments: z
      .array(
        z
          .object({
            slackUserId: z.string(),
            worthProfile: z.boolean(),
            reason: z.string().min(1).max(300),
          })
          .strict(),
      )
      .min(1),
    suspectedInjection: strictInjectionSchema,
  })
  .strict();
export type UnknownAssessmentOutput = z.infer<typeof unknownAssessmentOutputSchema>;

export type RecommendationKind = "initial" | "update" | "suggest_evaluation";
export type RecommendationStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "superseded"
  | "applied";
export type PersonPriority = "normal" | "high" | "critical";

/** One evidence reference. The source message may have expired locally; the ref is always kept. */
export interface EvidenceView {
  observationKey: string;
  sourceExternalRef: string;
  /** False once the source message was removed by retention. */
  messageAvailable: boolean;
  confidence: Confidence;
  permalink: string | null;
}

/** Actions the server allows on an item; the UI renders buttons from this list only. */
export type PeopleAction = "approve" | "reject" | "retry" | "evaluate" | "dismiss";

/** A candidate for evaluation, ranked by interaction score. */
export interface ContactCandidate {
  slackUserId: string;
  name: string | null;
  score: number;
  messageCount: number;
  hasProfile: boolean;
  hasPendingRecommendation: boolean;
  isTemporary: boolean;
}

/** `GET /api/people/candidates`. */
export interface CandidatesResponse {
  /** True while `slack.selfUserId` is unconfirmed: no ranking is possible and evaluation is refused. */
  identityRequired: boolean;
  candidates: (ContactCandidate & { actions: PeopleAction[] })[];
}

/** `POST /api/people/:slackUserId/evaluate` and `.../accept-suggestion`. */
export interface EvaluateResult {
  queued: boolean;
  reason?: "pending_recommendation" | "identity_required" | "already_run_today";
}

export interface PersonSummary {
  slackUserId: string;
  name: string | null;
  title: string | null;
  team: string | null;
  priority: PersonPriority;
  hasProfile: boolean;
  profileVersion: number | null;
  hasPendingRecommendation: boolean;
}

/** `GET /api/people/:slackUserId/profile`. */
export interface PersonDetail extends PersonSummary {
  email: string | null;
  rationale: string | null;
  extraAttention: boolean;
  profile: {
    version: number;
    content: ProfileContent;
    evidence: EvidenceView[];
    updatedAt: string;
  } | null;
  versions: { version: number; createdAt: string; approvalId: string | null }[];
  temporaryContact: {
    firstSeenAt: string;
    lastSeenAt: string;
    messageCount: number;
    expiresAt: string;
  } | null;
  flagCount: number;
  actions: PeopleAction[];
}

/** One observation with the evidence that supports it. */
export interface ObservationView {
  section: ProfileSection;
  key: string;
  text: string;
  confidence: Confidence;
  evidence: EvidenceView[];
}

/** A removed observation: `text` is the current profile's wording, null when it is not found. */
export interface RemovedObservationView {
  section: ProfileSection;
  key: string;
  text: string | null;
  evidence: EvidenceView[];
}

/** `GET /api/people/recommendations`. */
export interface RecommendationView {
  id: string;
  kind: RecommendationKind;
  status: RecommendationStatus;
  person: { slackUserId: string; name: string | null };
  baseVersion: number | null;
  /** Initial recommendations: the proposed observations. */
  proposed: ObservationView[] | null;
  /** Update recommendations: what the new version adds and removes. */
  diff: { added: ObservationView[]; removed: RemovedObservationView[] } | null;
  approvalId: string | null;
  approvalStatus: ApprovalStatus | null;
  actions: PeopleAction[];
  /** Why a `suggest_evaluation` was raised. */
  reason: string | null;
  createdAt: string;
}
