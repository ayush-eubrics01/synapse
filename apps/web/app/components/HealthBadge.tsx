"use client";

import type { HealthReport } from "@synapse/contracts";

const colors = { ok: "#2a7", degraded: "#ca2", down: "#c33" } as const;

export function HealthBadge({ health }: { health: HealthReport | null }) {
  const status = health?.status;
  return (
    <span
      style={{
        background: status ? colors[status] : "#888",
        color: "#fff",
        borderRadius: 4,
        padding: "2px 8px",
      }}
    >
      {status ?? "unknown"}
    </span>
  );
}
