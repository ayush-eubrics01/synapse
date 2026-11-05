import type { SlackSyncState } from "./api";

/**
 * The backfill button (R54, R60 M4): start from idle; resume from error, or from "running" when
 * the backend reports no live backfill job (`resumable`). Disabled otherwise.
 */
export function backfillAction(b: { status: SlackSyncState["status"]; resumable: boolean }): {
  enabled: boolean;
  label: string;
} {
  if (b.status === "idle") return { enabled: true, label: "Start 90-day backfill" };
  if (b.status === "error" || b.resumable) return { enabled: true, label: "Resume backfill" };
  return { enabled: false, label: "Start 90-day backfill" };
}
