"use client";

import type { SlackStatusDto } from "../../lib/api";

export function SlackStatus({
  status,
  onBackfill,
}: {
  status: SlackStatusDto | null;
  onBackfill: () => void;
}) {
  if (!status) return <p>No Slack status yet.</p>;
  const { incremental, backfill, searchesToday } = status;
  // R54: startable from idle, resumable from error; never while running, paused or complete.
  const canStart = backfill.status === "idle" || backfill.status === "error";
  return (
    <section>
      <p>
        Incremental: checkpoint {incremental.checkpoint ?? "none"}, last success{" "}
        {incremental.lastSuccessAt ?? "never"}
      </p>
      <p>
        Backfill: {backfill.status}
        {backfill.pagesDone > 0 && ` (${backfill.pagesDone} pages)`}
        {backfill.status === "error" && backfill.lastError && ` - ${backfill.lastError.kind}`}{" "}
        <button type="button" disabled={!canStart} onClick={onBackfill}>
          {backfill.status === "error" ? "Resume backfill" : "Start 90-day backfill"}
        </button>
      </p>
      <p>Searches today: {searchesToday}</p>
    </section>
  );
}
