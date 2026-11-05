import { z } from "zod";
import { suspectedInjectionSchema } from "./urgency";

export const profileSectionSchema = z.enum([
  "professionalContext",
  "communication",
  "responseGuidelines",
]);
export type ProfileSection = z.infer<typeof profileSectionSchema>;
const sectionSchema = profileSectionSchema;

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
  .object({ profile: profileContentSchema, suspectedInjection: suspectedInjectionSchema })
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
    suspectedInjection: suspectedInjectionSchema,
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
    suspectedInjection: suspectedInjectionSchema,
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

/** A candidate for evaluation, ranked by interaction score (`GET /api/people/candidates`). */
export interface ContactCandidate {
  slackUserId: string;
  name: string | null;
  score: number;
  messageCount: number;
  hasProfile: boolean;
  hasPendingRecommendation: boolean;
  isTemporary: boolean;
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
}

/** `GET /api/people/recommendations`. `content` is the full profile (initial) or the diff (update). */
export interface RecommendationView {
  id: string;
  kind: RecommendationKind;
  status: RecommendationStatus;
  person: { slackUserId: string; name: string | null };
  baseVersion: number | null;
  content: ProfileContent | ProfileUpdateOutput | null;
  evidence: EvidenceView[];
  approvalId: string | null;
  /** Why a `suggest_evaluation` was raised. */
  reason: string | null;
  createdAt: string;
}
