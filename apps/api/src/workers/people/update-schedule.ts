import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { selectHistory } from "../../intelligence/people/history";
import {
  PEOPLE_CONCURRENCY_GROUP,
  UPDATE_PROFILE_JOB,
  UPDATE_PROFILE_PRIORITY,
  UPDATE_SCHEDULE_JOB,
} from "../../modules/people/recommendations";
import type { PeopleContext } from "./context";
import type { PeopleJobDeps } from "./shared";
import { EXPIRY_TIMEOUT_MS } from "./shared";

export function registerUpdateSchedule(deps: PeopleJobDeps, c: PeopleContext): void {
  const { db, settings, scheduler, recommendations, handlers } = deps;
  const { queue } = deps;
  const { baselineOf, historyOpts } = c;

  // Tick: one job per profiled person with history newer than their evidence and nothing pending.
  handlers.set(UPDATE_SCHEDULE_JOB, {
    handler: async () => {
      const profiled = db
        .select({
          personId: schema.people.id,
          slackUserId: schema.people.slackUserId,
          profile: schema.peopleProfiles,
        })
        .from(schema.peopleProfiles)
        .innerJoin(schema.people, eq(schema.people.id, schema.peopleProfiles.personId))
        .all();
      let enqueued = 0;
      for (const p of profiled) {
        if (recommendations.hasPending(db, p.personId)) continue;
        const [newest] = selectHistory(db, p.slackUserId, historyOpts(baselineOf(p.profile), 1));
        if (!newest) continue;
        const { created } = db.transaction(
          (tx) =>
            queue.enqueue(tx, {
              type: UPDATE_PROFILE_JOB,
              idempotencyKey: `people.update:${p.personId}:${newest.sentAt}`,
              input: { personId: p.personId },
              concurrencyGroup: PEOPLE_CONCURRENCY_GROUP,
              priority: UPDATE_PROFILE_PRIORITY,
            }),
          { behavior: "immediate" },
        );
        if (created) enqueued++;
      }
      return { enqueued };
    },
    timeoutMs: EXPIRY_TIMEOUT_MS,
  });
  scheduler.upsert({
    name: UPDATE_SCHEDULE_JOB,
    jobType: UPDATE_SCHEDULE_JOB,
    intervalSeconds: settings.get("people.update.intervalSeconds"),
    priority: UPDATE_PROFILE_PRIORITY,
    coalesce: true,
  });
}
