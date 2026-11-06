import { z } from "zod";
import { isSafeTestCommand, TEST_RUNS, type TestRun } from "./patterns";

export {
  isSafeTestCommand,
  TEST_RUNS,
  type TestRun,
  taskBranchName,
  testResultLabel,
} from "./patterns";

export const engineeringSourceSchema = z.enum(["manual", "jira", "slack"]);
export type EngineeringSource = z.infer<typeof engineeringSourceSchema>;

export const engineeringTaskStatusSchema = z.enum([
  "proposed",
  "investigating",
  "planned",
  "approved",
  "queued",
  "in_progress",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "needs_attention",
]);
export type EngineeringTaskStatus = z.infer<typeof engineeringTaskStatusSchema>;

export const engineeringStepSchema = z.enum([
  "investigate",
  "branch",
  "develop",
  "commit",
  "update_parent",
  "merge_local",
  "push_pr",
  "merge_pr",
  "cleanup",
]);
export type EngineeringStep = z.infer<typeof engineeringStepSchema>;

export const engineeringStepStatusSchema = z.enum([
  "pending",
  "awaiting_approval",
  "running",
  "done",
  "failed",
  "skipped",
]);
export type EngineeringStepStatus = z.infer<typeof engineeringStepStatusSchema>;

/** A git ref name that is safe in argv and in a branch specifier. */
export const parentBranchSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine(
    (b) =>
      !b.startsWith("-") &&
      !b.includes("..") &&
      !b.includes("//") &&
      !b.endsWith("/") &&
      !b.endsWith(".lock"),
    "unsafe branch name",
  );

/** M1: `exact` (the confirmed command as is), `partial` (with extra arguments) or `none`. */
export const testRunSchema = z.enum(TEST_RUNS as [TestRun, ...TestRun[]]);

export const testCommandSchema = z.string().refine(isSafeTestCommand, "unsafe test command");

/** E3: the structured output of the investigation run. */
export const investigationOutputSchema = z.object({
  summary: z.string().max(800),
  plan: z
    .array(z.object({ step: z.string().min(1).max(200) }))
    .min(1)
    .max(12),
  filesLikelyTouched: z.array(z.string().min(1).max(300)).max(30),
  testCommand: z.string().max(120).optional(),
  risk: z.enum(["low", "medium", "high"]),
  size: z.enum(["xs", "s", "m", "l"]),
  unclear: z.array(z.string().max(300)).max(5),
});
export type InvestigationOutput = z.infer<typeof investigationOutputSchema>;

/** E9: the structured output of the develop run (test fields are overwritten from the tool_result). */
export const developOutputSchema = z.object({
  summary: z.string().max(2000),
  testsPassed: z.boolean(),
  testOutputTail: z.string().max(2000),
  notes: z.string().max(2000),
});
export type DevelopOutput = z.infer<typeof developOutputSchema>;

export const engineeringTaskCreateInputSchema = z.object({
  repositoryId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  draftDescription: z.string().min(1).max(8000),
});
export type EngineeringTaskCreateInput = z.infer<typeof engineeringTaskCreateInputSchema>;

/** E4/E5: the plan approval carries the confirmed parent branch and test command. */
export const planApprovalInputSchema = z.object({
  parentBranch: parentBranchSchema,
  testCommand: testCommandSchema,
  environmentId: z.string().min(1).optional(),
  rememberAsTracked: z.boolean().optional(),
});
export type PlanApprovalInput = z.infer<typeof planApprovalInputSchema>;

export const approveDescriptionInputSchema = z.object({ description: z.string().min(1).max(8000) });
export type ApproveDescriptionInput = z.infer<typeof approveDescriptionInputSchema>;

export interface EngineeringTaskView {
  id: string;
  repositoryId: string;
  environmentId: string | null;
  source: EngineeringSource;
  sourceRef: string | null;
  title: string;
  status: EngineeringTaskStatus;
  currentStep: EngineeringStep | null;
  parentBranch: string | null;
  taskBranch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  failure: string | null;
  /**
   * I1: the fixed code of the last pickup that could not run preflight for a passing reason
   * (`fetch_failed`, `git_timeout`): the task stays `queued` and is retried on the next tick.
   * Cleared by a successful pickup.
   */
  lastPickupError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EngineeringTaskStepView {
  id: string;
  step: EngineeringStep;
  status: EngineeringStepStatus;
  approvalId: string | null;
  claudeRunId: string | null;
  output: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface EngineeringTaskDetail extends EngineeringTaskView {
  draftDescription: string;
  approvedDescription: string | null;
  plan: InvestigationOutput | null;
  baseSha: string | null;
  mergeSha: string | null;
  steps: EngineeringTaskStepView[];
}

export interface LockView {
  held: boolean;
  taskId?: string;
  since?: string;
}
