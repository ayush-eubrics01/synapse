import { ApiError } from "./api";

/** The toast for a "Back up now" request that was refused or failed. */
export function backupStartMessage(e: unknown): string {
  return e instanceof ApiError && e.status === 409
    ? "A backup is already running"
    : "Couldn't start the backup";
}
