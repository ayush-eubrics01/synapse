import { z } from "zod";
import type { ClassifiedError } from "./errors";
import type { HealthStatus } from "./health";

export type WorkerProfile = "collector" | "intelligence" | "engineering" | "reader";

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
 * sha256 of the canonical JSON of its normalised `tool_input` equals `expectedInputSha256` (64
 * lowercase hex). Canonical: keys sorted recursively, undefined dropped. Normalised: an
 * `unfurl_app_links: false` key is dropped and `message` is trimEnd-ed.
 */
export interface SendGuard {
  toolName: string;
  expectedInputSha256: string;
}

/**
 * ADR-040: run the test command inside the Claude Code sandbox. The provider merges the fixed
 * sandbox settings into `--settings`: `denyRead` is masked (followed by `SANDBOX_MASKED_ROOTS`),
 * `tmpDir` is re-allowed, created 0700 before the spawn and set as the child's `TMPDIR`. Validator
 * rule M requires it on any engineering run that grants Bash and forbids it on other profiles.
 */
export interface SandboxSpec {
  tmpDir: string;
  denyRead: string[];
}

/**
 * The paths the sandbox always masks after the request's `denyRead` (F1.2): they hide the Docker
 * socket, the runtime dir (SSH agent, D-Bus, Wayland), X11 and other sessions' temp files. A
 * repository at or under one of them would be hidden from its own run.
 */
export const SANDBOX_MASKED_ROOTS = ["/run", "/var/run", "/tmp"] as const;

/**
 * ADR-040: matches a sandbox that could not start, tested against the CLI's stderr head, an error
 * result's text and (fix round 2) a develop run's Bash tool_result content; only the match is
 * used. Phrases from Claude Code 2.1.319:
 * - stderr: "sandbox.failIfUnavailable is set — refusing to start without a working sandbox."
 * - message: "Sandbox required but unavailable[: <detail>]. Set sandbox.failIfUnavailable=false …"
 * - Bash tool_result (observed on the real CLI): "Sandbox is required but failed to initialize:
 *   Failed to create bridge sockets after 5 attempts. Restart to retry. …"
 * plus a generic "sandbox … unavailable / not available / failed to start|initialise" on one line.
 * A bare mention of the sandbox (a `<sandbox_violations>` notice, "denied by sandbox") does not
 * match. Wording may change between CLI versions: a miss is reported as an ordinary failure.
 */
export const SANDBOX_FAILURE_RE =
  /sandbox\.failIfUnavailable|without a working sandbox|sandbox is required but failed to initiali[sz]e|sandbox[^\n]{0,80}?\b(unavailable|not available|failed to (start|initiali[sz]e))/i;

/**
 * A develop run's Bash tool_result is repository-controlled test output, so only the CLI's own
 * in-run message counts, anchored at the start of the content (optionally after an
 * "Exit code N" line): "Sandbox is required but failed to initialize: ...". The generic
 * SANDBOX_FAILURE_RE is for stderr and the result text only.
 */
export const SANDBOX_TOOL_RESULT_RE =
  /^\s*(?:Exit code \d+\r?\n\s*)?Sandbox is required but failed to initiali[sz]e/i;

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
  sandbox?: SandboxSpec;
}

/**
 * Per-call options for `orchestrator.run`. Not part of the request: the request is zod-validated
 * data, and a function would be dropped.
 */
export interface RunOptions {
  /**
   * Called after the Claude slot is acquired and the quota re-checked, immediately before the
   * provider runs. false (or a throw) fails the run with a not-spawned `cancelled_before_spawn`.
   */
  beforeSpawn?: () => boolean;
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
  sandbox?: SandboxSpec;
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
  /**
   * True when the user's Claude Code settings (read once at startup) widen file or shell scope
   * beyond what a run allows. The orchestrator refuses engineering and reader runs (the profiles
   * with path-scoped filesystem tools) while it is true.
   */
  readonly userPermissionsWidenScope?: boolean;
  /**
   * Connector server names (`mcp__<server>`) of the user's `permissions.allow` entries, read at
   * the same startup. The orchestrator refuses reader runs while any is not a known server (a
   * reader denies every known server; an unknown one would stay allowed). Names only.
   */
  readonly userAllowedConnectorServers?: readonly string[];
}

export const workerProfileSchema = z.enum(["collector", "intelligence", "engineering", "reader"]);

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

export const sandboxSpecSchema = z.strictObject({
  tmpDir: z.string().min(1),
  denyRead: z.array(z.string().min(1)).max(64),
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
  sandbox: sandboxSpecSchema.optional(),
});
