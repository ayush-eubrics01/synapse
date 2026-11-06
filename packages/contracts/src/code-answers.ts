import { z } from "zod";
import { type flagSeveritySchema, strictSuspectedInjectionSchema } from "./urgency";

export const CODE_ANSWER_MAX_ANSWER = 1500;
export const CODE_ANSWER_MAX_EVIDENCE = 8;
export const CODE_ANSWER_MAX_PATH = 300;
export const CODE_ANSWER_MAX_REASON = 200;
export const CODE_ANSWER_MAX_QUESTION = 4000;
export const CODE_ANSWER_MAX_CONTEXT_MESSAGES = 5;
export const CODE_ANSWER_MAX_CONTEXT_CHARS = 1000;
export const CODE_ANSWER_MAX_FACTS = 20;

export const codeAnswerStatusSchema = z.enum([
  "queued",
  "running",
  "ready",
  "not_answerable",
  "unverified",
  "failed",
  "held",
  "sent",
  "dismissed",
]);
export type CodeAnswerStatus = z.infer<typeof codeAnswerStatusSchema>;

export const codeAnswerTriggerSchema = z.enum(["user", "away"]);
export type CodeAnswerTrigger = z.infer<typeof codeAnswerTriggerSchema>;

export const codeAnswerEvidenceSchema = z
  .object({
    path: z.string().max(CODE_ANSWER_MAX_PATH),
    line: z.number().int().min(1).optional(),
  })
  .strict();
export type CodeAnswerEvidence = z.infer<typeof codeAnswerEvidenceSchema>;

/** C3: the reader run's output contract. */
export const codeAnswerOutputSchema = z
  .object({
    answerable: z.boolean(),
    answer: z.string().max(CODE_ANSWER_MAX_ANSWER),
    confidence: z.number().min(0).max(1),
    evidence: z.array(codeAnswerEvidenceSchema).max(CODE_ANSWER_MAX_EVIDENCE),
    notAnswerableReason: z.string().max(CODE_ANSWER_MAX_REASON).optional(),
    suspectedInjection: strictSuspectedInjectionSchema,
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.answerable) {
      if (o.answer.length < 1) {
        ctx.addIssue({ code: "custom", path: ["answer"], message: "answer required" });
      }
      if (o.evidence.length < 1) {
        ctx.addIssue({ code: "custom", path: ["evidence"], message: "evidence required" });
      }
    } else if (o.answer !== "") {
      ctx.addIssue({ code: "custom", path: ["answer"], message: "answer must be empty" });
    }
  });
export type CodeAnswerOutput = z.infer<typeof codeAnswerOutputSchema>;

export interface CodeAnswerView {
  id: string;
  messageId: string;
  repositoryId: string | null;
  repositoryName: string | null;
  trigger: CodeAnswerTrigger;
  status: CodeAnswerStatus;
  answer: string | null;
  confidence: number | null;
  evidence: CodeAnswerEvidence[];
  droppedEvidenceCount: number;
  notAnswerableReason: string | null;
  failure: string | null;
  suspectedInjection: {
    detected: boolean;
    severity: z.infer<typeof flagSeveritySchema>;
    reason: string;
  } | null;
  /** Set once the away decision (C7) recorded its `auto_replies` row. */
  autoReplyId: string | null;
  outgoingId: string | null;
  outgoingStatus: string | null;
  createdAt: string;
  updatedAt: string;
}
