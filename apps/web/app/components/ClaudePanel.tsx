"use client";

import type { ClaudeRun, ClaudeStatus } from "../../lib/api";

const cell = { textAlign: "left", padding: "2px 12px 2px 0" } as const;
const pct = (u: number) => `${Math.round(u * 100)}%`;

export function ClaudePanel({ status, runs }: { status: ClaudeStatus | null; runs: ClaudeRun[] }) {
  const quota = status?.quota ?? null;
  return (
    <section>
      <p>
        Quota:{" "}
        {quota ? (
          <>
            {quota.level} (5h {pct(quota.fiveHour.utilization)}, 7d{" "}
            {pct(quota.sevenDay.utilization)})
          </>
        ) : (
          "no data yet"
        )}
      </p>
      <p>
        Auth refresh expires: {status?.auth.refreshExpiresAt ?? "unknown"}
        {status?.auth.slides === true && " (sliding)"}
      </p>
      {runs.length === 0 ? (
        <p>No Claude runs yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cell}>Status</th>
              <th style={cell}>Profile</th>
              <th style={cell}>Model</th>
              <th style={cell}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 10).map((r) => (
              <tr key={r.id}>
                <td style={cell}>{r.status}</td>
                <td style={cell}>{r.workerProfile}</td>
                <td style={cell}>{r.model ?? "-"}</td>
                <td style={cell}>
                  {r.durationMs === null ? "-" : `${(r.durationMs / 1000).toFixed(1)}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
