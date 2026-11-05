import { z } from "zod";
import type { ClassifiedError } from "./errors";
import type { HealthStatus } from "./health";

export type WorkerProfile = "collector" | "intelligence" | "engineering";

export type PriorityClass = "urgent" | "send" | "collection" | "engineering" | "batch" | "backfill";

export interface PromptPart {
  provenance: "untrusted" | "user_approved" | "system";
  source?: string;
  content: string;
}

/** What modules submit; the orchestrator fills the rest. */
export interface ClaudeJobRequest {
  jobId?: string;
  workerProfile: WorkerProfile;
  priorityClass: PriorityClass;
  instructions: string;
  parts?: PromptPart[];
  systemPrompt?: string;
  allowedTools: string[];
  expectedToolNames?: string[];
  maxTurns: number;
  model?: string;
  timeoutMs?: number;
  workingDirectory?: string;
}

export interface AIExecutionRequest {
  runId: string;
  jobId: string | null;
  workerProfile: WorkerProfile;
  model: string;
  systemPrompt: string;
  prompt: string;
  promptParts: PromptPart[];
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns: number;
  timeoutMs: number;
  workingDirectory: string;
  expectedToolNames?: string[];
}

export interface RawToolResult {
  toolUseId: string;
  toolName: string;
  input: unknown;
  isError: boolean;
  content: string;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsdEquivalent: number;
}

export interface QuotaWindow {
  utilization: number;
  status: "allowed" | "allowed_warning" | "rejected" | (string & {});
  resetsAt: string;
}

export interface QuotaSnapshot {
  observedAt: string;
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
}

export interface ConnectorStatus {
  name: string;
  status: string;
}

export interface AIExecutionResult {
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  toolResults: RawToolResult[];
  finalText: string;
  numTurns: number;
  durationMs: number;
  usage: AIUsage;
  quota?: QuotaSnapshot;
  permissionDenials: string[];
  connectors: ConnectorStatus[];
  exitCode: number | null;
  error?: ClassifiedError;
}

export interface AIProvider {
  execute(request: AIExecutionRequest, signal: AbortSignal): Promise<AIExecutionResult>;
  getHealth(): Promise<{ status: HealthStatus; detail?: string; version?: string }>;
}

export const workerProfileSchema = z.enum(["collector", "intelligence", "engineering"]);

export const priorityClassSchema = z.enum([
  "urgent",
  "send",
  "collection",
  "engineering",
  "batch",
  "backfill",
]);

export const promptPartSchema = z.object({
  provenance: z.enum(["untrusted", "user_approved", "system"]),
  source: z.string().optional(),
  content: z.string(),
});

export const claudeJobRequestSchema = z.object({
  jobId: z.string().optional(),
  workerProfile: workerProfileSchema,
  priorityClass: priorityClassSchema,
  instructions: z.string(),
  parts: z.array(promptPartSchema).optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).nonempty(),
  expectedToolNames: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(50),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  workingDirectory: z.string().optional(),
});
