import { type DbOrTx, schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import { hasProfile, type ProfileRecommendations } from "./recommendations";
import type { PeopleService } from "./service";

export const POST_SEND_REASON = "You messaged this person";

export interface PostSendSuggestionsDeps {
  settings: SettingsService;
  people: PeopleService;
  recommendations: ProfileRecommendations;
  /** The Slack user id a sent follow-up was addressed to; null when it has none. */
  recipientOf: (tx: DbOrTx, followupId: string) => string | null;
}

/**
 * `followup.sent` consumer (H2): after the user messaged someone who has no profile and no pending
 * recommendation, suggests evaluating them. Skips the user, bots and anyone already profiled or
 * pending. A savepoint, never throws; logs ids only.
 */
export class PostSendSuggestions {
  constructor(private readonly deps: PostSendSuggestionsDeps) {}

  onFollowupSent(event: { payload: unknown }, tx: DbOrTx): void {
    const followupId = (event.payload as { followupId?: unknown } | null)?.followupId;
    if (typeof followupId !== "string") return;
    try {
      tx.transaction((sp) => {
        const recipient = this.deps.recipientOf(sp, followupId);
        if (!recipient || recipient === this.deps.settings.get("slack.selfUserId")) return;
        const user = sp
          .select({ isBot: schema.slackUsers.isBot })
          .from(schema.slackUsers)
          .where(eq(schema.slackUsers.externalId, recipient))
          .get();
        if (user?.isBot) return;
        const person = sp
          .select({ id: schema.people.id })
          .from(schema.people)
          .where(eq(schema.people.slackUserId, recipient))
          .get();
        if (person && hasProfile(sp, person.id)) return;
        // Null when the person already has a pending recommendation (no duplicate).
        this.deps.recommendations.storeSuggestion(sp, recipient, POST_SEND_REASON);
      });
    } catch (e) {
      console.error(
        `people post_send failed followup=${followupId} error=${e instanceof Error ? e.name : "unknown"}`,
      );
    }
  }
}
