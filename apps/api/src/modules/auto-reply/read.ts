import { type DbOrTx, schema } from "@synapse/database";
import { and, eq, inArray } from "drizzle-orm";

/** Read port: which of these outgoing messages were sent as away-mode auto-replies. */
export function autoSentOutgoingIds(db: DbOrTx, outgoingIds: readonly string[]): Set<string> {
  if (outgoingIds.length === 0) return new Set();
  const rows = db
    .select({ id: schema.autoReplies.outgoingId })
    .from(schema.autoReplies)
    .where(
      and(
        inArray(schema.autoReplies.outgoingId, [...outgoingIds]),
        eq(schema.autoReplies.decision, "sent"),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.id).filter((x): x is string => x !== null));
}
