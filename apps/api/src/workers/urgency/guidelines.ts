import { type Db, schema } from "@synapse/database";
import { eq } from "drizzle-orm";

import type { UrgencyJobDeps } from "./shared";

/**
 * Looks the sender up as a person (`people.slack_user_id`); null when there is no person or the
 * profile has no response guidelines.
 */
export function responseGuidelinesLookup(
  db: Db,
  getGuidelines: (personId: string) => { text: string }[],
): NonNullable<UrgencyJobDeps["guidelinesFor"]> {
  return (slackUserId) => {
    const person = db
      .select({ id: schema.people.id, name: schema.people.name })
      .from(schema.people)
      .where(eq(schema.people.slackUserId, slackUserId))
      .get();
    if (!person) return null;
    const texts = getGuidelines(person.id).map((o) => o.text);
    if (texts.length === 0) return null;
    const user = db
      .select({ name: schema.slackUsers.name })
      .from(schema.slackUsers)
      .where(eq(schema.slackUsers.externalId, slackUserId))
      .get();
    return { name: user?.name ?? person.name ?? slackUserId, texts };
  };
}
