"use client";

import type { Job } from "@synapse/contracts";

const cell = { textAlign: "left", padding: "2px 12px 2px 0" } as const;

export function JobsTable({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) return <p>No jobs yet.</p>;
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={cell}>Type</th>
          <th style={cell}>Status</th>
          <th style={cell}>Attempts</th>
          <th style={cell}>Created</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id}>
            <td style={cell}>{j.type}</td>
            <td style={cell}>{j.status}</td>
            <td style={cell}>
              {j.attempts}/{j.maxAttempts}
            </td>
            <td style={cell}>{j.createdAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
