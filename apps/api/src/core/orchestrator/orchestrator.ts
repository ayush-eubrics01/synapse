import {
  type AIExecutionRequest,
  type AIExecutionResult,
  type AIProvider,
  type ClassifiedError,
  type ClaudeJobRequest,
  claudeJobRequestSchema,
  JobError,
  type QuotaSnapshot,
  type QuotaWindow,
  type RunOptions,
  type UserActivitySignal,
  type WorkerProfile,
} from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { desc, eq, sql } from "drizzle-orm";
import type { ZodType } from "zod";
import type { AuditLogger } from "../audit/audit";
import type { SettingsService } from "../config/settings";
import type { EventPublisher } from "../events/publisher";
import type { NotificationService } from "../notifications/notifications";
import type { AuthMonitor } from "./auth";
import { assemblePrompt } from "./prompt";
import { clampQuotaRetry, decideQuota, quotaLevel, thresholdsFromSettings } from "./quota-gate";
import { parseStructured } from "./structured";
import { buildDenylist, classifyTool, SERVER_NAME_RE } from "./tool-catalog";
import { validateRequest } from "./validator";
import { shouldYield, yieldRetryAfter } from "./yield-gate";

export const DEFAULT_SYSTEM_PROMPTS: Record<WorkerProfile, string> = {
  collector:
    "You are a read-only data collection worker. Call only the tools you are told to, with the exact arguments given. Never send or modify anything.",
  intelligence:
    "You are an analysis worker. Use only the tools you are given, which are read-only. Reply with exactly the JSON the instructions ask for.",
  engineering:
    "You are an engineering worker operating only inside the given repository and only within the approved task.",
  reader:
    "You answer one question about one local repository by reading its files. You cannot change anything.",
};

export interface OrchestratorDeps {
  db: Db;
  clock: Clock;
  provider: AIProvider;
  settings: SettingsService;
  events: EventPublisher;
  audit: AuditLogger;
  auth: AuthMonitor;
  notifications: NotificationService;
  scratchDir: string;
  /** Boundary generator (16 hex chars); injectable for tests. */
  random?: () => string;
  /** Optional (core never imports the module): background work yields while the user is active. */
  userActivity?: UserActivitySignal;
}

// Provider messages for these kinds are generic by design (Task 5); others never echo content.
const SAFE_MESSAGE_KINDS = new Set<string>([
  "provider_error",
  "timeout",
  "quota_exhausted",
  "auth_failed",
  "connector_not_ready",
  "incomplete_ai_output",
]);

const AUTH_PAUSE_RETRY_MS = 15 * 60_000;

/** Fixed, content-free: the user must edit `~/.claude/settings.json` (read once at startup). */
export const UNSAFE_USER_SETTINGS_MESSAGE =
  "Claude Code user settings widen file or shell permissions; engineering and code-answer runs are refused until they are removed and the API is restarted";
const AUTH_PROBE_AFTER_MS = 30 * 60_000;

const defaultBoundary = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/** True when any allowed tool is a connector write-class tool (a send run). */
function hasWriteTool(tools: string[]): boolean {
  return tools.some((t) => t.startsWith("mcp__") && classifyTool(t) === "write");
}

export function connectorToServer(name: string): string {
  return `mcp__${name.replace(/^claude\.ai /, "claude_ai_").replace(/[^A-Za-z0-9]/g, "_")}`;
}

const cancelledWaiting = () =>
  new JobError({ kind: "timeout", message: "cancelled while waiting for a Claude slot" });

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  /** Waits for a slot; an abort removes the waiter from the queue and throws a timeout JobError. */
  async acquire(max: () => number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw cancelledWaiting();
    while (this.active >= max()) {
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(cancelledWaiting());
        };
        this.waiters.push(wake);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      if (signal.aborted) {
        // Woken and aborted in the same turn: pass the wake-up on so no slot is stranded.
        this.waiters.shift()?.();
        throw cancelledWaiting();
      }
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

/** Error class name only: never messages, which may carry SQL values or content. */
function errName(e: unknown): string {
  return e instanceof Error ? e.name : "non-error value thrown";
}

export class ClaudeOrchestrator {
  private readonly semaphore = new Semaphore();
  private readonly random: () => string;
  /** True while one run is acting as the auth probe (in-process; one probe at a time). */
  private probing = false;

  constructor(private readonly deps: OrchestratorDeps) {
    this.random = deps.random ?? defaultBoundary;
  }

  async run(
    req: ClaudeJobRequest,
    signal: AbortSignal,
    opts: RunOptions = {},
  ): Promise<AIExecutionResult> {
    const probe = this.authGate();
    try {
      const result = await this.runInner(req, signal, opts);
      if (probe) this.clearAuthPause();
      return result;
    } catch (e) {
      if (e instanceof JobError && e.classified.kind === "auth_failed") {
        // Only the auth_failed that starts the pause parks a job (R38); later ones defer.
        if (!this.pauseAuth()) {
          // R4: keep the original details: a spawned send run stays `uncertain`.
          const details = e.classified.details;
          throw new JobError({
            kind: "auth_paused",
            message: "Claude authentication is paused until re-login",
            retryAfter: new Date(
              this.deps.clock.now().getTime() + AUTH_PAUSE_RETRY_MS,
            ).toISOString(),
            ...(details ? { details } : {}),
          });
        }
      }
      throw e;
    } finally {
      if (probe) this.probing = false;
    }
  }

  /**
   * ADR-037 §4. Throws auth_paused while paused, unless this run is the single probe (pause is
   * 30+ min old, or the credentials refresh expiry changed). Returns true for the probe.
   */
  private authGate(): boolean {
    const { settings, clock, auth } = this.deps;
    const pausedAt = settings.get("auth.pausedAt");
    if (pausedAt === null) return false;
    const now = clock.now();
    const exp = auth.currentExpiry();
    const changed =
      !("error" in exp) && exp.refreshExpiresAt !== settings.get("auth.pausedRefreshExpiresAt");
    const old = now.getTime() - Date.parse(pausedAt) >= AUTH_PROBE_AFTER_MS;
    if ((old || changed) && !this.probing) {
      this.probing = true; // claimed synchronously: no await between check and set
      return true;
    }
    throw new JobError({
      kind: "auth_paused",
      message: "Claude authentication is paused until re-login",
      retryAfter: new Date(now.getTime() + AUTH_PAUSE_RETRY_MS).toISOString(),
    });
  }

  private checkBeforeSpawn(opts: RunOptions): void {
    if (!opts.beforeSpawn) return;
    let ok = false;
    try {
      ok = opts.beforeSpawn() === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new JobError({
        kind: "cancelled_before_spawn",
        message: "run cancelled before spawn",
        details: { notSpawned: true },
      });
    }
  }

  private clearAuthPause(): void {
    this.bestEffort("auth pause clear", "-", () => {
      this.deps.settings.clear("auth.pausedAt");
      this.deps.settings.clear("auth.pausedRefreshExpiresAt");
    });
  }

  /**
   * Sets (or re-arms) the pause; returns true when this call started it. The notification is
   * created before the pause keys are written, so a failed write cannot lose it (R40).
   */
  private pauseAuth(): boolean {
    let started = false;
    this.bestEffort("auth pause", "-", () => {
      const { settings, clock, db, notifications, auth } = this.deps;
      started = settings.get("auth.pausedAt") === null;
      if (started) {
        db.transaction((tx) => {
          notifications.notify(tx, {
            kind: "claude.auth_paused",
            severity: "high",
            title: "Claude authentication failed",
            body: "Claude runs are paused. Log in to Claude again; runs resume automatically.",
          });
        });
      }
      const exp = auth.currentExpiry();
      settings.set("auth.pausedAt", isoNow(clock), { emit: false });
      if ("error" in exp) settings.clear("auth.pausedRefreshExpiresAt");
      else settings.set("auth.pausedRefreshExpiresAt", exp.refreshExpiresAt, { emit: false });
    });
    return started;
  }

  private async runInner(
    req: ClaudeJobRequest,
    signal: AbortSignal,
    opts: RunOptions,
  ): Promise<AIExecutionResult> {
    const { db, clock, settings, events, audit, provider } = this.deps;

    const parsed = claudeJobRequestSchema.safeParse(req);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      throw new JobError({ kind: "invalid_input", message: `invalid claude request: ${paths}` });
    }
    const request = parsed.data as ClaudeJobRequest;

    // Quota gate (checked again after the slot is acquired)
    const thresholds = thresholdsFromSettings(settings);
    this.checkQuota(request, thresholds);
    this.checkYield(request);

    // Build the execution request
    const profile = request.workerProfile;
    const parts = request.parts ?? [];
    const boundary = this.random();
    const allowedTools = [...request.allowedTools];
    // Never for a reader (C1): it may use no connector, so rule C refuses one, and its denylist
    // holds ToolSearch so no deferred connector tool can be loaded.
    if (
      profile !== "reader" &&
      allowedTools.some((t) => t.startsWith("mcp__")) &&
      !allowedTools.includes("ToolSearch")
    ) {
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
      ...(request.sendGuard ? { sendGuard: request.sendGuard } : {}),
      ...(request.sandbox ? { sandbox: request.sandbox } : {}),
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
    // Phase 9: user-level permissions merge into the run (`--setting-sources user`) and the
    // override cannot remove them, so a widening user setting would defeat rule L's path scoping.
    // Both path-scoped profiles are refused: engineering, and reader (C1), which reads files next
    // to untrusted text. A reader is also refused while a user-level `mcp__` allow names a server
    // outside knownServers: its denylist denies every known server, but not that one.
    const widens =
      provider.userPermissionsWidenScope === true ||
      (profile === "reader" &&
        (provider.userAllowedConnectorServers ?? []).some((s) => !knownServers.includes(s)));
    if ((profile === "engineering" || profile === "reader") && widens) {
      db.transaction((tx) => {
        audit.record(tx, {
          actor: "system",
          module: "orchestrator",
          action: "claude.request_rejected",
          workerProfile: profile,
          result: "rejected",
          details: { reason: "unsafe_user_settings" },
        });
      });
      throw new JobError({
        kind: "needs_attention",
        message: UNSAFE_USER_SETTINGS_MESSAGE,
        details: { notSpawned: true },
      });
    }
    const sendsExternally = hasWriteTool(allowedTools);

    await this.semaphore.acquire(() => settings.get("orchestrator.maxConcurrent"), signal);
    try {
      // The quota may have risen while this request waited for a slot.
      this.checkQuota(request, thresholds);
      this.checkYield(request);
      // Last word for the caller (a policy send whose user came back while it waited). Nothing
      // below awaits before provider.execute, so the answer holds until the spawn.
      this.checkBeforeSpawn(opts);

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
        result = await provider.execute(execReq, signal);
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
          availableTools: [],
          exitCode: null,
          error: { kind: "provider_error", message: "provider execution failed" },
        };
      }

      // A send run that actually spawned may have written externally whatever the failure.
      const spawned = providerThrew || result.error?.details?.notSpawned !== true;
      const error = this.classify(result, providerThrew, sendsExternally && spawned);

      // Everything below is best-effort bookkeeping: it never changes the outcome.
      const r = result;
      const updated = this.bestEffort("run update", runId, () =>
        db.transaction((tx) => {
          tx.update(schema.claudeRuns)
            .set({
              status: r.status,
              numTurns: r.numTurns,
              durationMs: r.durationMs,
              inputTokens: r.usage.inputTokens,
              outputTokens: r.usage.outputTokens,
              cacheReadTokens: r.usage.cacheReadInputTokens,
              cacheCreationTokens: r.usage.cacheCreationInputTokens,
              costUsdEquivalent: r.usage.costUsdEquivalent,
              permissionDenials: r.permissionDenials,
              error: error ? { kind: error.kind, message: error.message } : null,
              finishedAt: isoNow(clock),
            })
            .where(eq(schema.claudeRuns.id, runId))
            .run();
        }),
      );
      if (!updated) {
        // Never leave the row `running`: retry with the status alone.
        this.bestEffort("run status update", runId, () =>
          db
            .update(schema.claudeRuns)
            .set({ status: r.status, finishedAt: isoNow(clock) })
            .where(eq(schema.claudeRuns.id, runId))
            .run(),
        );
      }
      const q = r.quota;
      if (q) this.bestEffort("store quota", runId, () => this.storeQuota(q, runId, thresholds));
      this.bestEffort("learn connectors", runId, () => this.learnConnectors(r));
      this.bestEffort("auth record", runId, () => this.deps.auth.record(runId));
      this.bestEffort("completion event", runId, () =>
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
        }),
      );

      if (error) throw new JobError(error);
      return result;
    } finally {
      this.semaphore.release();
    }
  }

  async runStructured<T>(
    req: ClaudeJobRequest,
    schemaT: ZodType<T>,
    signal: AbortSignal,
  ): Promise<{ value: T; result: AIExecutionResult }> {
    const result = await this.run(req, signal);
    const p = parseStructured(result.finalText, schemaT);
    if (!p.ok) {
      throw new JobError({
        kind: "incomplete_ai_output",
        message: p.reason,
        ...(hasWriteTool(req.allowedTools) ? { details: { uncertain: true } } : {}),
      });
    }
    return { value: p.value, result };
  }

  private checkQuota(
    request: ClaudeJobRequest,
    thresholds: ReturnType<typeof thresholdsFromSettings>,
  ): void {
    const now = this.deps.clock.now();
    const decision = quotaLevel(this.latestSnapshot(), thresholds, now);
    if (!decideQuota(decision.level, request.priorityClass)) {
      throw new JobError({
        kind: "quota_exhausted",
        message: `quota level ${decision.level}: ${request.priorityClass} work deferred`,
        retryAfter: clampQuotaRetry(decision.resetsAt ?? undefined, now),
      });
    }
  }

  /** ADR-036: defers (never spawns) background work while the user is active in Claude Code. */
  private checkYield(request: ClaudeJobRequest): void {
    const signal = this.deps.userActivity;
    if (!signal) return;
    const { settings, clock } = this.deps;
    const cfg = {
      yieldWhenActive: settings.get("claudeActivity.yieldWhenActive"),
      yieldEngineering: settings.get("claudeActivity.yieldEngineering"),
    };
    // Classes that can never yield do not touch the signal at all.
    if (!shouldYield(request.priorityClass, cfg, true)) return;
    const now = clock.now();
    let a: { active: boolean; until: string | null };
    try {
      a = signal.isUserActive(now);
    } catch (e) {
      // Fail open: a broken activity signal must never stop background work.
      console.error("orchestrator: user activity check failed", errName(e));
      return;
    }
    if (!a.active) return;
    throw new JobError({
      kind: "user_active",
      message: `user active in Claude Code: ${request.priorityClass} work deferred`,
      retryAfter: yieldRetryAfter(a.until, now),
      details: { notSpawned: true },
    });
  }

  /** Runs one bookkeeping step; a failure is logged as one content-free line. */
  private bestEffort(step: string, runId: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (e) {
      console.error(`orchestrator: ${step} failed`, runId, errName(e));
      return false;
    }
  }

  private classify(
    result: AIExecutionResult,
    providerThrew: boolean,
    uncertain: boolean,
  ): ClassifiedError | null {
    if (result.status === "succeeded") return null;
    const extra = uncertain ? { details: { uncertain: true } } : {};
    if (providerThrew) {
      return { kind: "provider_error", message: "provider execution failed", ...extra };
    }
    const e = result.error;
    const kind =
      result.status === "timed_out" || result.status === "cancelled"
        ? "timeout"
        : (e?.kind ?? "provider_error");
    const message =
      e && e.kind === kind && SAFE_MESSAGE_KINDS.has(kind) ? e.message : genericMessage(kind);
    const safeRetry = SAFE_MESSAGE_KINDS.has(kind) ? e?.retryAfter : undefined;
    const retryAfter =
      kind === "quota_exhausted" ? clampQuotaRetry(safeRetry, this.deps.clock.now()) : safeRetry;
    // R16: the max-turns marker survives classification (a boolean, never content).
    const maxTurns = e?.kind === kind && e.details?.maxTurns === true;
    const details = {
      ...(maxTurns ? { maxTurns: true } : {}),
      ...(uncertain ? { uncertain: true } : {}),
    };
    return {
      kind,
      message,
      ...(retryAfter ? { retryAfter } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  }

  latestSnapshot(): QuotaSnapshot | null {
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
    const window = (
      utilization: number | null,
      status: string,
      resetsAt: string | null,
    ): QuotaWindow => ({
      utilization: utilization ?? 0,
      status,
      // A missing resetsAt stays absent; the gate applies observedAt + 1h (R30).
      ...(resetsAt !== null ? { resetsAt } : {}),
    });
    const five = row.fiveHourUtilization ?? 0;
    const seven = row.sevenDayUtilization ?? 0;
    if (row.fiveHourStatus !== null || row.sevenDayStatus !== null) {
      // Per-window row (R30): a window with no status was absent from the event.
      return {
        observedAt: row.observedAt,
        ...(row.fiveHourStatus !== null
          ? {
              fiveHour: window(row.fiveHourUtilization, row.fiveHourStatus, row.fiveHourResetsAt),
            }
          : {}),
        ...(row.sevenDayStatus !== null
          ? {
              sevenDay: window(row.sevenDayUtilization, row.sevenDayStatus, row.sevenDayResetsAt),
            }
          : {}),
      };
    }
    let fiveStatus: string;
    let sevenStatus: string;
    if (row.status === "rejected") {
      // Legacy row (no per-window statuses): attribute to the higher-utilization window.
      fiveStatus = seven > five ? "allowed" : "rejected";
      sevenStatus = seven > five ? "rejected" : "allowed";
    } else {
      fiveStatus = row.status;
      sevenStatus = row.status;
    }
    return {
      observedAt: row.observedAt,
      fiveHour: window(row.fiveHourUtilization, fiveStatus, row.fiveHourResetsAt),
      sevenDay: window(row.sevenDayUtilization, sevenStatus, row.sevenDayResetsAt),
    };
  }

  private storeQuota(
    q: QuotaSnapshot,
    runId: string,
    thresholds: ReturnType<typeof thresholdsFromSettings>,
  ): void {
    const { db, clock, events } = this.deps;
    const present = [q.fiveHour, q.sevenDay].filter((w): w is QuotaWindow => w !== undefined);
    const status = present.some((w) => w.status === "rejected")
      ? "rejected"
      : (present.find((w) => w.status !== "allowed")?.status ?? "allowed");
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
            fiveHourUtilization: q.fiveHour?.utilization ?? null,
            fiveHourResetsAt: q.fiveHour?.resetsAt ?? null,
            sevenDayUtilization: q.sevenDay?.utilization ?? null,
            sevenDayResetsAt: q.sevenDay?.resetsAt ?? null,
            status,
            fiveHourStatus: q.fiveHour?.status ?? null,
            sevenDayStatus: q.sevenDay?.status ?? null,
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
        result.connectors
          .map((c) => connectorToServer(c.name))
          .filter((s) => SERVER_NAME_RE.test(s))
          .filter((s) => !known.includes(s)),
      ),
    ];
    if (fresh.length > 0) {
      settings.set("orchestrator.knownServers", [...known, ...fresh], { emit: false });
    }
  }
}
