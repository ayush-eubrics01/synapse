import { z } from "zod";
import type { ClassifiedError } from "./errors";
import type { HealthStatus } from "./health";

export type WorkerProfile = "collector" | "intelligence" | "engineering";

export type PriorityClass = "urgent" | "send" | "collection" | "engineering" | "batch" | "backfill";

/**
 * `policy_approved`: authorised by a deterministic policy (ADR-033 away-mode auto-replies), not by
 * the user; validator rule K allows it only in a send run.
 */
export interface PromptPart {
  provenance: "untrusted" | "user_approved" | "policy_approved" | "system";
  source?: string;
  content: string;
}

/**
 * J2: the provider adds a per-run PreToolUse hook on `toolName` that blocks the call unless the
 * sha256 of its canonical `tool_input` (keys sorted recursively, undefined dropped) equals
 * `expectedInputSha256` (64 lowercase hex).
 */
export interface SendGuard {
  toolName: string;
  expectedInputSha256: string;
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
  sendGuard?: SendGuard;
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
  sendGuard?: SendGuard;
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
  /** Absent when the event omitted it or gave a non-positive or out-of-range value. */
  resetsAt?: string;
}

/** Each window is independent: an event may carry only one of them. */
export interface QuotaSnapshot {
  observedAt: string;
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
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
  /** Tool names from the system/init event; names only, present on every status. */
  availableTools: string[];
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
  provenance: z.enum(["untrusted", "user_approved", "policy_approved", "system"]),
  source: z.string().optional(),
  content: z.string(),
});

export const sendGuardSchema = z.object({
  toolName: z.string().regex(/^[A-Za-z0-9_]+$/),
  expectedInputSha256: z.string().regex(/^[0-9a-f]{64}$/),
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
  sendGuard: sendGuardSchema.optional(),
});
