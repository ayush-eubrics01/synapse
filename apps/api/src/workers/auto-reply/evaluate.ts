import { JobError } from "@synapse/contracts";
import { z } from "zod";
import type { HandlerRegistration } from "../../core/jobs/worker";
import { AUTOREPLY_EVALUATE_JOB, type AutoReplyService } from "../../modules/auto-reply/service";

/** Database work only; the send itself runs later as its own `approval.execute` job. */
const EVALUATE_TIMEOUT_MS = 30_000;

const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("acknowledgement"), messageId: z.string().min(1) }),
  z.object({
    kind: z.enum(["stalled_reminder", "followup_question"]),
    followupId: z.string().min(1),
  }),
]);

export interface AutoReplyJobDeps {
  handlers: Map<string, HandlerRegistration>;
  autoReply: Pick<AutoReplyService, "evaluate">;
}

/**
 * `autoreply.evaluate` (ADR-033): one trigger per job, in concurrency group `autoreply` with
 * concurrency 1 (A5), keyed `autoreply:<kind>:<id>` so a trigger is evaluated once. The service
 * enqueues it from `message.urgent_detected` and `followup.draft_created` while away is on.
 * Not an external write: it records the decision and, on send, a policy approval.
 */
export function registerAutoReplyJobs(deps: AutoReplyJobDeps): void {
  deps.handlers.set(AUTOREPLY_EVALUATE_JOB, {
    timeoutMs: EVALUATE_TIMEOUT_MS,
    handler: async (job) => {
      const parsed = triggerSchema.safeParse(job.input);
      if (!parsed.success) {
        throw new JobError({ kind: "invalid_input", message: "invalid auto-reply trigger" });
      }
      return deps.autoReply.evaluate(parsed.data);
    },
  });
}
