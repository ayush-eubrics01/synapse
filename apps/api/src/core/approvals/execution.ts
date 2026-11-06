import { type Approval, JobError, type Operation } from "@synapse/contracts";
import { z } from "zod";
import type { OutboxDispatcher } from "../events/dispatcher";
import type { JobQueue } from "../jobs/queue";
import type { HandlerRegistration } from "../jobs/worker";
import type { ApprovalEngine, Executor } from "./approvals";

export const APPROVAL_EXECUTE_JOB = "approval.execute";
export const APPROVAL_EXECUTE_PRIORITY = 180;
const CONSUMER = "approvals.execute";
// Executors may write to external systems; a timeout must not blindly re-run them.
const EXECUTE_TIMEOUT_MS = 120_000;

const inputSchema = z.object({ approvalId: z.string().min(1) });

function parseInput(raw: unknown): { approvalId: string } {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new JobError({ kind: "invalid_input", message: "invalid approval execution input" });
  }
  return parsed.data;
}

export interface ApprovalExecutionDeps {
  dispatcher: Pick<OutboxDispatcher, "subscribe">;
  queue: Pick<JobQueue, "enqueue">;
  engine: Pick<ApprovalEngine, "execute">;
  handlers: Map<string, HandlerRegistration>;
}

/**
 * approval.approved -> approval.execute job -> engine.execute. The engine owns the claim, so a
 * re-delivered event or a re-run job can never execute an approval twice. An executor failure is
 * recorded by the engine as a terminal `failed` approval (it is never retried: the side effect may
 * have happened); the job still completes.
 */
export function registerApprovalExecution(deps: ApprovalExecutionDeps): void {
  const { dispatcher, queue, engine, handlers } = deps;

  dispatcher.subscribe("approval.approved", CONSUMER, (event, tx) => {
    const { approvalId } = parseInput(event.payload);
    queue.enqueue(tx, {
      type: APPROVAL_EXECUTE_JOB,
      idempotencyKey: `${APPROVAL_EXECUTE_JOB}:${approvalId}`,
      priority: APPROVAL_EXECUTE_PRIORITY,
      input: { approvalId },
      externalWrite: true,
    });
  });

  handlers.set(APPROVAL_EXECUTE_JOB, {
    timeoutMs: EXECUTE_TIMEOUT_MS,
    externalWrite: true,
    handler: async (job) => {
      const { approvalId } = parseInput(job.input);
      try {
        const outcome = await engine.execute(approvalId);
        // The result is deliberately not returned: it may carry payload-derived content.
        return { approvalId, status: outcome.status };
      } catch (e) {
        // Only bookkeeping failures reach here (executor errors are caught by the engine). The
        // approval may be stranded claimed, so park the job visibly instead of retrying.
        console.error(
          `approvals: execution bookkeeping failed approval=${approvalId} error=${e instanceof Error ? e.name : "unknown"}`,
        );
        throw new JobError({
          kind: "parse_failed",
          message: "approval execution bookkeeping failed",
        });
      }
    },
  });
}

const routers = new WeakMap<ApprovalEngine, Map<Operation, Map<string, Executor>>>();

/**
 * Registers `ex` for (action, targetIntegration). The engine holds one executor per action, so a
 * routing executor is registered once per action and dispatches on approval.targetIntegration.
 * An unknown integration fails the approval with the message "no executor".
 */
export function registerIntegrationExecutor(
  engine: ApprovalEngine,
  action: Operation,
  targetIntegration: string,
  ex: Executor,
): void {
  const byAction = routers.get(engine) ?? new Map<Operation, Map<string, Executor>>();
  routers.set(engine, byAction);
  let byIntegration = byAction.get(action);
  if (byIntegration?.has(targetIntegration)) {
    throw new Error(`executor already registered for ${action}/${targetIntegration}`);
  }
  if (!byIntegration) {
    if (engine.hasExecutor(action)) {
      throw new Error(`action ${action} already has a non-router executor`);
    }
    const table = new Map<string, Executor>();
    byIntegration = table;
    byAction.set(action, table);
    const pick = (a: Approval) => table.get(a.targetIntegration);
    engine.registerExecutor(action, {
      execute: async (a) => {
        const target = pick(a);
        if (!target) throw new Error("no executor");
        return target.execute(a);
      },
      // An unknown integration must reach execute() so it is recorded as failed, not skipped.
      revalidate: async (a) => {
        const target = pick(a);
        return target?.revalidate ? target.revalidate(a) : true;
      },
    });
  }
  byIntegration.set(targetIntegration, ex);
}
