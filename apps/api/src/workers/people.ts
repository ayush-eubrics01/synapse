import type { Clock } from "@synapse/shared";
import type { HandlerRegistration } from "../core/jobs/worker";
import type { SchedulerService } from "../core/scheduler/scheduler";
import type { TemporaryContacts } from "../modules/people/temporary";

export interface PeopleJobDeps {
  clock: Clock;
  scheduler: SchedulerService;
  temporary: TemporaryContacts;
  handlers: Map<string, HandlerRegistration>;
}

const EXPIRY_TIMEOUT_MS = 60_000;

/** People Memory jobs. Later tasks add the profile and recommendation jobs here. */
export function registerPeopleJobs(deps: PeopleJobDeps): void {
  const { scheduler, temporary, handlers } = deps;
  // Idempotent (a delete by predicate), so a repeated daily run needs no dedupe key; the
  // scheduler has no per-tick key, and `coalesce` stops a backlog.
  handlers.set("people.expire_temporary", {
    handler: async () => ({ deleted: temporary.expire() }),
    timeoutMs: EXPIRY_TIMEOUT_MS,
  });
  scheduler.upsert({
    name: "people.expire_temporary",
    jobType: "people.expire_temporary",
    intervalSeconds: 86_400,
    coalesce: true,
  });
}
