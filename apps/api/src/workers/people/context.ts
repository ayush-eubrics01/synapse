import { schema } from "@synapse/database";
import { and, eq, max } from "drizzle-orm";
import { createRunHelpers } from "../intelligence-shared";

import type { PeopleJobDeps } from "./shared";

/** Shared by the update tick and the update job: run helpers and the history window. */
export function createPeopleContext(deps: PeopleJobDeps) {
  const { db, clock, settings } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = createRunHelpers(
    db,
    deps.securityFlags,
  );

  // The newest evidence date of the current version (the version's own date when it has none):
  // history newer than this is "new".
  const baselineOf = (profile: { id: string; currentVersion: number; updatedAt: string }) => {
    const version = db
      .select({
        id: schema.peopleProfileVersions.id,
        createdAt: schema.peopleProfileVersions.createdAt,
      })
      .from(schema.peopleProfileVersions)
      .where(
        and(
          eq(schema.peopleProfileVersions.profileId, profile.id),
          eq(schema.peopleProfileVersions.version, profile.currentVersion),
        ),
      )
      .get();
    if (!version) return profile.updatedAt;
    const row = db
      .select({ newest: max(schema.peopleProfileEvidence.observedAt) })
      .from(schema.peopleProfileEvidence)
      .where(eq(schema.peopleProfileEvidence.versionId, version.id))
      .get();
    return row?.newest ?? version.createdAt;
  };
  const historyOpts = (after: string, maxMessages: number) => ({
    days: settings.get("people.history.days"),
    maxMessages,
    selfUserId: settings.get("slack.selfUserId"),
    now: clock.now(),
    after,
  });

  return { latestRunId, runIdBefore, runtimeFlags, failedRunFlags, baselineOf, historyOpts };
}

export type PeopleContext = ReturnType<typeof createPeopleContext>;
