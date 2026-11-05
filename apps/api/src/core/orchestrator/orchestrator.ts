import {
  type AIExecutionRequest,
  type AIExecutionResult,
  type AIProvider,
  type ClassifiedError,
  type ClaudeJobRequest,
  claudeJobRequestSchema,
  JobError,
  type QuotaSnapshot,
  type WorkerProfile,
} from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { desc, eq, sql } from "drizzle-orm";
import type { ZodType } from "zod";
import type { AuditLogger } from "../audit/audit";
import type { SettingsService } from "../config/settings";
import type { EventPublisher } from "../events/publisher";
import type { AuthMonitor } from "./auth";
import { assemblePrompt } from "./prompt";
import { decideQuota, quotaLevel, thresholdsFromSettings } from "./quota-gate";
import { parseStructured } from "./structured";
import { buildDenylist } from "./tool-catalog";
import { validateRequest } from "./validator";

export const DEFAULT_SYSTEM_PROMPTS: Record<WorkerProfile, string> = {
  collector:
    "You are a read-only data collection worker. Call only the tools you are told to, with the exact arguments given. Never send or modify anything.",
  intelligence:
    "You are an analysis worker. Use only the tools you are given, which are read-only. Reply with exactly the JSON the instructions ask for.",
  engineering:
    "You are an engineering worker operating only inside the given repository and only within the approved task.",
};

export interface OrchestratorDeps {
  db: Db;
  clock: Clock;
  provider: AIProvider;
  settings: SettingsService;
  events: EventPublisher;
  audit: AuditLogger;
  auth: AuthMonitor;
  scratchDir: string;
  /** Boundary generator (16 hex chars); injectable for tests. */
  random?: () => string;
}

const QUOTA_RETRY_MS = 15 * 60_000;
// Provider messages for these kinds are generic by design (Task 5); others never echo content.
const SAFE_MESSAGE_KINDS = new Set<string>([
  "provider_error",
  "timeout",
  "quota_exhausted",
  "auth_failed",
  "connector_not_ready",
  "incomplete_ai_output",
]);

const defaultBoundary = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export function connectorToServer(name: string): string {
  return `mcp__${name.replace(/^claude\.ai /, "claude_ai_").replace(/[^A-Za-z0-9]/g, "_")}`;
}

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  async acquire(max: () => number): Promise<void> {
    while (this.active >= max()) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
  }

  release(): void {
    this.active--;
    this.waiters.shift()?.();
  }
}

function genericMessage(kind: string): string {
  return `claude run failed (${kind})`;
}

export class ClaudeOrchestrator {
  private readonly semaphore = new Semaphore();
  private readonly random: () => string;

  constructor(private readonly deps: OrchestratorDeps) {
    this.random = deps.random ?? defaultBoundary;
  }

  async run(req: ClaudeJobRequest, signal?: AbortSignal): Promise<AIExecutionResult> {
    const { db, clock, settings, events, audit, provider } = this.deps;

    const parsed = claudeJobRequestSchema.safeParse(req);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      throw new JobError({ kind: "invalid_input", message: `invalid claude request: ${paths}` });
    }
    const request = parsed.data as ClaudeJobRequest;

    // Quota gate
    const thresholds = thresholdsFromSettings(settings);
    const now = clock.now();
    const decision = quotaLevel(this.latestSnapshot(), thresholds, now);
    if (!decideQuota(decision.level, request.priorityClass)) {
      throw new JobError({
        kind: "quota_exhausted",
        message: `quota level ${decision.level}: ${request.priorityClass} work deferred`,
        retryAfter: decision.resetsAt ?? new Date(now.getTime() + QUOTA_RETRY_MS).toISOString(),
      });
    }

    // Build the execution request
    const profile = request.workerProfile;
    const parts = request.parts ?? [];
    const boundary = this.random();
    const allowedTools = [...request.allowedTools];
    if (allowedTools.some((t) => t.startsWith("mcp__")) && !allowedTools.includes("ToolSearch")) {
      allowedTools.push("ToolSearch");
    }
    const knownServers = settings.get("orchestrator.knownServers");
    const runId = newId();
    const execReq: AIExecutionRequest = {
      runId,
      jobId: request.jobId ?? null,
      workerProfile: profile,
      model: request.model ?? settings.get(`orchestrator.models.${profile}`),
      systemPrompt: request.systemPrompt ?? DEFAULT_SYSTEM_PROMPTS[profile],
      prompt: assemblePrompt(request.instructions, parts, boundary),
      promptParts: parts,
      allowedTools,
      disallowedTools: buildDenylist(allowedTools, knownServers, profile),
      maxTurns: request.maxTurns,
      timeoutMs: request.timeoutMs ?? settings.get(`orchestrator.timeouts.${profile}`) * 1000,
      workingDirectory: request.workingDirectory ?? this.deps.scratchDir,
      ...(request.expectedToolNames ? { expectedToolNames: request.expectedToolNames } : {}),
    };

    const verdict = validateRequest(execReq, knownServers, {
      instructions: request.instructions,
      boundary,
    });
    if (!verdict.ok) {
      db.transaction((tx) => {
        audit.record(tx, {
          actor: "system",
          module: "orchestrator",
          action: "claude.request_rejected",
          workerProfile: profile,
          result: "rejected",
          details: { reason: verdict.reason },
        });
      });
      throw new JobError({ kind: "invalid_input", message: verdict.reason });
    }

    await this.semaphore.acquire(() => settings.get("orchestrator.maxConcurrent"));
    try {
      const startedAt = isoNow(clock);
      db.transaction((tx) => {
        tx.insert(schema.claudeRuns)
          .values({
            id: runId,
            jobId: execReq.jobId,
            workerProfile: profile,
            model: execReq.model,
            status: "running",
            startedAt,
          })
          .run();
        events.publish(tx, {
          type: "claude.job_started",
          aggregateType: "claude_run",
          aggregateId: runId,
          correlationId: newId(),
          payload: { runId, jobId: execReq.jobId },
        });
      });

      let result: AIExecutionResult;
      let providerThrew = false;
      try {
        result = await provider.execute(execReq, signal ?? new AbortController().signal);
      } catch {
        providerThrew = true;
        result = {
          status: "failed",
          toolResults: [],
          finalText: "",
          numTurns: 0,
          durationMs: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            costUsdEquivalent: 0,
          },
          permissionDenials: [],
          connectors: [],
          exitCode: null,
          error: { kind: "provider_error", message: "provider execution failed" },
        };
      }

      const error = this.classify(result, providerThrew);
      db.transaction((tx) => {
        tx.update(schema.claudeRuns)
          .set({
            status: result.status,
            numTurns: result.numTurns,
            durationMs: result.durationMs,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cacheReadTokens: result.usage.cacheReadInputTokens,
            cacheCreationTokens: result.usage.cacheCreationInputTokens,
            costUsdEquivalent: result.usage.costUsdEquivalent,
            permissionDenials: result.permissionDenials,
            error: error ? { kind: error.kind, message: error.message } : null,
            finishedAt: isoNow(clock),
          })
          .where(eq(schema.claudeRuns.id, runId))
          .run();
      });

      if (result.quota) this.storeQuota(result.quota, runId, thresholds);
      this.learnConnectors(result);
      this.deps.auth.record(runId);

      db.transaction((tx) => {
        if (error) {
          events.publish(tx, {
            type: "claude.job_failed",
            aggregateType: "claude_run",
            aggregateId: runId,
            correlationId: newId(),
            payload: { runId, kind: error.kind },
          });
        } else {
          events.publish(tx, {
            type: "claude.job_completed",
            aggregateType: "claude_run",
            aggregateId: runId,
            correlationId: newId(),
            payload: { runId },
          });
        }
      });

      if (error) throw new JobError(error);
      return result;
    } finally {
      this.semaphore.release();
    }
  }

  async runStructured<T>(
    req: ClaudeJobRequest,
    schemaT: ZodType<T>,
    signal?: AbortSignal,
  ): Promise<{ value: T; result: AIExecutionResult }> {
    const result = await this.run(req, signal);
    const p = parseStructured(result.finalText, schemaT);
    if (!p.ok) throw new JobError({ kind: "incomplete_ai_output", message: p.reason });
    return { value: p.value, result };
  }

  private classify(result: AIExecutionResult, providerThrew: boolean): ClassifiedError | null {
    if (result.status === "succeeded") return null;
    if (providerThrew) return { kind: "provider_error", message: "provider execution failed" };
    const e = result.error;
    const kind =
      result.status === "timed_out" || result.status === "cancelled"
        ? "timeout"
        : (e?.kind ?? "provider_error");
    const message =
      e && e.kind === kind && SAFE_MESSAGE_KINDS.has(kind) ? e.message : genericMessage(kind);
    return {
      kind,
      message,
      ...(e?.retryAfter && SAFE_MESSAGE_KINDS.has(kind) ? { retryAfter: e.retryAfter } : {}),
    };
  }

  private latestSnapshot(): QuotaSnapshot | null {
    const row = this.deps.db
      .select()
      .from(schema.quotaSnapshots)
      .orderBy(desc(schema.quotaSnapshots.observedAt), sql`rowid desc`)
      .limit(1)
      .get();
    if (!row) return null;
    return this.rowToSnapshot(row);
  }

  private rowToSnapshot(row: typeof schema.quotaSnapshots.$inferSelect): QuotaSnapshot {
    const fallback = new Date(this.deps.clock.now().getTime() + 3_600_000).toISOString();
    const five = row.fiveHourUtilization ?? 0;
    const seven = row.sevenDayUtilization ?? 0;
    // One stored status: a rejection belongs to the window with the higher utilization.
    const rejectedWindow = row.status === "rejected" ? (seven > five ? "seven" : "five") : null;
    return {
      observedAt: row.observedAt,
      fiveHour: {
        utilization: five,
        status:
          rejectedWindow === "five"
            ? "rejected"
            : row.status === "rejected"
              ? "allowed"
              : row.status,
        resetsAt: row.fiveHourResetsAt ?? fallback,
      },
      sevenDay: {
        utilization: seven,
        status:
          rejectedWindow === "seven"
            ? "rejected"
            : row.status === "rejected"
              ? "allowed"
              : row.status,
        resetsAt: row.sevenDayResetsAt ?? fallback,
      },
    };
  }

  private storeQuota(
    q: QuotaSnapshot,
    runId: string,
    thresholds: ReturnType<typeof thresholdsFromSettings>,
  ): void {
    const { db, clock, events } = this.deps;
    const status =
      q.fiveHour.status === "rejected" || q.sevenDay.status === "rejected"
        ? "rejected"
        : q.fiveHour.status !== "allowed"
          ? q.fiveHour.status
          : q.sevenDay.status;
    db.transaction(
      (tx) => {
        const prevRow = tx
          .select()
          .from(schema.quotaSnapshots)
          .orderBy(desc(schema.quotaSnapshots.observedAt), sql`rowid desc`)
          .limit(1)
          .get();
        const now = clock.now();
        const prev = quotaLevel(prevRow ? this.rowToSnapshot(prevRow) : null, thresholds, now);
        tx.insert(schema.quotaSnapshots)
          .values({
            id: newId(),
            observedAt: q.observedAt,
            fiveHourUtilization: q.fiveHour.utilization,
            fiveHourResetsAt: q.fiveHour.resetsAt,
            sevenDayUtilization: q.sevenDay.utilization,
            sevenDayResetsAt: q.sevenDay.resetsAt,
            status,
            claudeRunId: runId,
          })
          .run();
        const next = quotaLevel(q, thresholds, now);
        const rank = { ok: 0, soft: 1, hard: 2, stop: 3 } as const;
        if (
          rank[next.level] > rank[prev.level] &&
          next.level !== "ok" &&
          next.window &&
          next.resetsAt
        ) {
          events.publish(tx, {
            type: "quota.threshold_reached",
            aggregateType: "quota",
            aggregateId: "claude",
            correlationId: newId(),
            payload: { window: next.window, level: next.level, resetsAt: next.resetsAt },
          });
        }
      },
      { behavior: "immediate" },
    );
  }

  private learnConnectors(result: AIExecutionResult): void {
    if (result.connectors.length === 0) return;
    const { settings } = this.deps;
    const known = settings.get("orchestrator.knownServers");
    const fresh = [
      ...new Set(
        result.connectors.map((c) => connectorToServer(c.name)).filter((s) => !known.includes(s)),
      ),
    ];
    if (fresh.length > 0) {
      settings.set("orchestrator.knownServers", [...known, ...fresh], { emit: false });
    }
  }
}
