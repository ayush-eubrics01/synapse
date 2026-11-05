/**
 * R11: where a follow-up posts relative to its source message. In an `im` it is top-level unless
 * the source was itself a thread reply (then that thread); in mpim and channels it threads under
 * the source (`thread_ts ?? ts`), so a nudge is not buried.
 */
export function followupThreadTs(
  conversationType: "im" | "mpim" | "channel",
  threadTs: string | null,
  ts: string,
): string | null {
  return conversationType === "im" ? threadTs : (threadTs ?? ts);
}
