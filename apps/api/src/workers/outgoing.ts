import { JobError } from "@synapse/contracts";
import { z } from "zod";
import type { HandlerRegistration } from "../core/jobs/worker";
import { OUTGOING_VERIFY_JOB, type OutgoingService } from "../modules/outgoing/service";

/** findSent runs a Slack search through the orchestrator (up to two collector pages). */
const VERIFY_TIMEOUT_MS = 300_000;

const inputSchema = z.object({ outgoingId: z.string().min(1) });

export interface OutgoingJobDeps {
  handlers: Map<string, HandlerRegistration>;
  outgoing: Pick<OutgoingService, "verify">;
}

/**
 * `outgoing.verify` (priority 170, not an external write: it only searches Slack). It never sends;
 * the service queues the next attempt itself, so the job keys follow `outgoing.verify:<id>:<n>`.
 */
export function registerOutgoingJobs(deps: OutgoingJobDeps): void {
  deps.handlers.set(OUTGOING_VERIFY_JOB, {
    timeoutMs: VERIFY_TIMEOUT_MS,
    handler: async (job) => {
      const parsed = inputSchema.safeParse(job.input);
      if (!parsed.success) {
        throw new JobError({ kind: "invalid_input", message: "invalid outgoing verify input" });
      }
      return deps.outgoing.verify(parsed.data.outgoingId);
    },
  });
}
