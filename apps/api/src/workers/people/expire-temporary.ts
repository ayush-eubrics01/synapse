import type { PeopleJobDeps } from "./shared";
import { EXPIRY_TIMEOUT_MS } from "./shared";

export function registerExpireTemporary(deps: PeopleJobDeps): void {
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
