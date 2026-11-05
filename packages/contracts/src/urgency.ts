import { z } from "zod";

export const urgencyLevelSchema = z.enum(["critical", "high", "medium", "low"]);
export type UrgencyLevel = z.infer<typeof urgencyLevelSchema>;

export const urgencyStatusSchema = z.enum([
  "new",
  "acknowledged",
  "in_progress",
  "resolved",
  "dismissed",
]);
export type UrgencyStatus = z.infer<typeof urgencyStatusSchema>;

export const flagSeveritySchema = z.enum(["info", "warning", "high"]);
export type FlagSeverity = z.infer<typeof flagSeveritySchema>;

/** Stored in `slack_messages.screening`. */
export interface ScreeningRecord {
  version: 1;
  candidate: boolean;
  score: number;
  ruleLevel: UrgencyLevel;
  matchedRules: string[];
  urgencySignals: string[];
  route: "assess" | "batch" | "skip";
  skipReason?: "own" | "expired" | "too_old";
  assessed: boolean;
  fallback?: boolean;
  notified?: boolean;
  error?: true;
}

export const suspectedInjectionSchema = z.object({
  detected: z.boolean(),
  severity: flagSeveritySchema,
  quote: z.string().max(300),
  reason: z.string().max(300),
});
export type SuspectedInjection = z.infer<typeof suspectedInjectionSchema>;

export const urgencyAssessmentSchema = z.object({
  assessments: z
    .array(
      z.object({
        messageId: z.string(),
        level: urgencyLevelSchema,
        reason: z.string().min(1).max(300),
        suspectedInjection: suspectedInjectionSchema,
      }),
    )
    .min(1),
});
export type UrgencyAssessment = z.infer<typeof urgencyAssessmentSchema>;

export const suggestedResponseSchema = z.object({
  draft: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  suspectedInjection: suspectedInjectionSchema,
});
export type SuggestedResponse = z.infer<typeof suggestedResponseSchema>;
