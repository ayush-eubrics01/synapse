import { type ClassifiedError, type Job, JobError, type JobStatus } from "@synapse/contracts";
import type { JobQueue } from "./queue";
import { isExternalWrite } from "./retry";

export interface JobContext {
  signal: AbortSignal;
  checkpoint(data: unknown): void;
  getCheckpoint<T>(): T | undefined;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<unknown>;

export interface HandlerRegistration {
  handler: JobHandler;
  timeoutMs: number;
  /**
   * The handler writes to an external system. A timeout or forced stop leaves the outcome
   * uncertain, so the job goes to NEEDS_ATTENTION instead of RETRY (security-model §2). Enqueue
   * such jobs with `externalWrite: true` too, so recovery honours it without the handler loaded.
   */
  externalWrite?: boolean;
}

export interface JobWorkerOptions {
  workerId: string;
  leaseMs?: number;
  heartbeatMs?: number;
  concurrency?: number;
  pollMs?: number;
  /** Called after this worker settles a job (complete, fail, timeout). Ids and status only. */
  onSettled?: (job: { id: string; status: JobStatus }) => void;
}

type Outcome =
  | { kind: "done"; output: unknown }
  | { kind: "error"; error: ClassifiedError }
  | { kind: "lost" };

interface InFlight {
  promise: Promise<void>;
  /** Abort because the worker is shutting down; the job is recorded as a timeout. */
  forceStop(): void;
}

export class JobWorker {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly onSettled: JobWorkerOptions["onSettled"];
  private readonly inFlight = new Set<InFlight>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: Map<string, HandlerRegistration>,
    opts: JobWorkerOptions,
  ) {
    this.workerId = opts.workerId;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.heartbeatMs = opts.heartbeatMs ?? 20_000;
    this.concurrency = opts.concurrency ?? 2;
    this.pollMs = opts.pollMs ?? 1_000;
    this.onSettled = opts.onSettled;
  }

  /** Claims at most one job and runs it to settlement. */
  async runOnce(): Promise<boolean> {
    const job = this.claim();
    if (!job) return false;
    await this.track(job);
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.pollLoop();
  }

  async stop(graceMs: number): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
    if (this.inFlight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    });
    await Promise.race([Promise.all([...this.inFlight].map((f) => f.promise)), grace]);
    clearTimeout(timer);
    const remaining = [...this.inFlight];
    for (const f of remaining) f.forceStop();
    await Promise.all(remaining.map((f) => f.promise));
  }

  private claim(): Job | null {
    try {
      return this.queue.claim(this.workerId, this.leaseMs, [...this.handlers.keys()]);
    } catch (e) {
      console.error("worker: claim failed", describe(e));
      return null;
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      if (this.inFlight.size < this.concurrency) {
        const job = this.claim();
        if (job) {
          this.track(job).catch(() => {});
          continue;
        }
      }
      await this.sleep(this.pollMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private track(job: Job): Promise<void> {
    let forceStop: () => void = () => {};
    const stopped = new Promise<Outcome>((resolve) => {
      forceStop = () =>
        resolve({
          kind: "error",
          error: { kind: "timeout", message: "worker stopped before job finished" },
        });
    });
    const entry: InFlight = {
      promise: Promise.resolve(),
      forceStop: () => forceStop(),
    };
    entry.promise = this.execute(job, stopped).finally(() => this.inFlight.delete(entry));
    this.inFlight.add(entry);
    return entry.promise;
  }

  private async execute(job: Job, stopped: Promise<Outcome>): Promise<void> {
    const reg = this.handlers.get(job.type);
    const external = isExternalWrite(job) || reg?.externalWrite === true;
    const controller = new AbortController();
    let owned = true;
    // Monotonic time of the last successful lease renewal (the claim counts as one).
    let renewedAt = performance.now();
    const leaseExpired = () => performance.now() - renewedAt >= this.leaseMs;
    let settled = false;
    let markLost: () => void = () => {};
    const lost = new Promise<Outcome>((resolve) => {
      markLost = () => resolve({ kind: "lost" });
    });
    const loseLease = () => {
      owned = false;
      controller.abort(new Error("lease lost"));
      markLost();
    };

    const heartbeat = setInterval(() => {
      // Past our own lease the reaper may have reclaimed the job, even for this same worker.
      if (leaseExpired()) return loseLease();
      const beatAt = performance.now();
      try {
        if (this.queue.heartbeat(job.id, this.workerId, this.leaseMs)) renewedAt = beatAt;
        else loseLease();
      } catch {
        // transient queue failure: keep going, the next beat will retry until the lease runs out
      }
    }, this.heartbeatMs);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<Outcome>((resolve) => {
      if (!reg) return;
      timeout = setTimeout(() => {
        const error: ClassifiedError = {
          kind: "timeout",
          message: `job ${job.type} timed out after ${reg.timeoutMs}ms`,
        };
        controller.abort(new Error(error.message));
        resolve({ kind: "error", error });
      }, reg.timeoutMs);
    });

    const ctx: JobContext = {
      signal: controller.signal,
      checkpoint: (data) => {
        if (settled || controller.signal.aborted)
          throw controller.signal.reason ?? new Error("job settled");
        this.queue.checkpoint(job.id, data);
      },
      getCheckpoint: <T>() => this.queue.getCheckpoint<T>(job.id),
    };
    const handled: Promise<Outcome> = !reg
      ? Promise.resolve({
          kind: "error",
          error: { kind: "unknown", message: `no handler for job type ${job.type}` },
        })
      : (async () => reg.handler(job, ctx))().then(
          (output): Outcome => ({ kind: "done", output }),
          (e: unknown): Outcome => ({ kind: "error", error: classify(e) }),
        );

    let outcome: Outcome;
    try {
      outcome = await Promise.race([handled, timedOut, lost, stopped]);
    } finally {
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
    if (outcome.kind === "error" && outcome.error.kind === "timeout") {
      controller.abort(new Error(outcome.error.message));
    }
    if (outcome.kind === "lost" || !owned) return;
    if (leaseExpired()) {
      controller.abort(new Error("lease expired"));
      return;
    }
    const op = outcome.kind === "done" ? "complete" : "fail";
    let status: JobStatus | null;
    try {
      if (outcome.kind === "done")
        status = this.queue.complete(job.id, this.workerId, outcome.output) ? "COMPLETED" : null;
      else if (external && outcome.error.kind === "timeout")
        status = this.queue.failUncertain(job.id, this.workerId, outcome.error);
      else status = this.queue.fail(job.id, this.workerId, outcome.error);
    } catch (e) {
      // The job stays RUNNING until its lease expires; the reaper then reclaims it.
      console.error(`worker: ${op} failed`, job.id, describe(e));
      return;
    }
    if (status === null || !this.onSettled) return;
    try {
      this.onSettled({ id: job.id, status });
    } catch (e) {
      console.error("worker: onSettled failed", job.id, describe(e));
    }
  }
}

/** Error name and message only: never job input, output or handler content. */
function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : "non-error value thrown";
}

function classify(e: unknown): ClassifiedError {
  if (e instanceof JobError) return e.classified;
  let message = "non-error value thrown";
  try {
    message = e instanceof Error ? e.message : String(e);
  } catch {
    // value cannot be stringified (e.g. null prototype); keep fallback
  }
  return { kind: "unknown", message };
}
