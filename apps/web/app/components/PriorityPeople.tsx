"use client";

import { useState } from "react";
import type { PersonDto, PersonPriorityDto } from "../../lib/api";

/** The priority select and extra-attention checkbox, shared by the people list and the profile. */
export function PriorityControls({
  person,
  onChange,
}: {
  person: {
    slackUserId: string;
    name: string | null;
    priority: PersonPriorityDto;
    extraAttention: boolean;
  };
  onChange: (priority: PersonPriorityDto, extraAttention: boolean) => void;
}) {
  return (
    <>
      <select
        aria-label={`Priority for ${person.name ?? person.slackUserId}`}
        value={person.priority}
        onChange={(e) => onChange(e.target.value as PersonPriorityDto, person.extraAttention)}
      >
        <option value="normal">normal</option>
        <option value="high">high</option>
        <option value="critical">critical</option>
      </select>{" "}
      <label>
        <input
          type="checkbox"
          checked={person.extraAttention}
          onChange={(e) => onChange(person.priority, e.target.checked)}
        />{" "}
        extra attention
      </label>
    </>
  );
}

export function PriorityPeople({
  people,
  onChange,
  onOpen,
}: {
  people: PersonDto[];
  onChange: (person: PersonDto, priority: PersonPriorityDto, extraAttention: boolean) => void;
  onOpen?: (slackUserId: string) => void;
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
                  <PriorityControls
                    person={p}
                    onChange={(priority, extra) => onChange(p, priority, extra)}
                  />
                </td>
                {onOpen && (
                  <td>
                    <button type="button" onClick={() => onOpen(p.slackUserId)}>
                      Open
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
