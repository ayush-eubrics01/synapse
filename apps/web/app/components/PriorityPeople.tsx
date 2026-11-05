"use client";

import { useState } from "react";
import type { PersonDto, PersonPriorityDto } from "../../lib/api";

export function PriorityPeople({
  people,
  onChange,
}: {
  people: PersonDto[];
  onChange: (person: PersonDto, priority: PersonPriorityDto, extraAttention: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = people
    .filter((p) => !needle || `${p.name ?? ""} ${p.slackUserId}`.toLowerCase().includes(needle))
    .slice(0, 50);
  return (
    <div>
      <input
        type="search"
        placeholder="Search people"
        aria-label="Search people"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {shown.length === 0 ? (
        <p>No people.</p>
      ) : (
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            {shown.map((p) => (
              <tr key={p.slackUserId}>
                <td style={{ paddingRight: 12 }}>{p.name ?? p.slackUserId}</td>
                <td style={{ paddingRight: 12 }}>
                  <select
                    aria-label={`Priority for ${p.name ?? p.slackUserId}`}
                    value={p.priority}
                    onChange={(e) =>
                      onChange(p, e.target.value as PersonPriorityDto, p.extraAttention)
                    }
                  >
                    <option value="normal">normal</option>
                    <option value="high">high</option>
                    <option value="critical">critical</option>
                  </select>
                </td>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={p.extraAttention}
                      onChange={(e) => onChange(p, p.priority, e.target.checked)}
                    />{" "}
                    extra attention
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
