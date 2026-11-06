"use client";

import { useState } from "react";
import type { PersonDto, PersonPriorityDto } from "../../../lib/api";
import { PRIORITY_SUBTITLE } from "../../../lib/away";
import { priorityRows } from "../../../lib/people-ui";
import { Avatar } from "../ui/Avatar";
import { Card } from "../ui/Card";
import { PriorityControl } from "./PriorityControl";

export function PriorityList({
  people,
  self,
  onChange,
  onOpen,
}: {
  people: PersonDto[];
  self: string | null;
  onChange: (person: PersonDto, priority: PersonPriorityDto, extraAttention: boolean) => void;
  onOpen: (slackUserId: string) => void;
}) {
  const [q, setQ] = useState("");
  const shown = priorityRows(people, self, q);
  const selfPerson = self === null ? null : people.find((p) => p.slackUserId === self);
  return (
    <Card>
      <div className="syn-card-head syn-card-head--top">
        <div>
          <h3>Priority</h3>
          <div className="syn-card-sub">{PRIORITY_SUBTITLE}</div>
        </div>
        <input
          type="search"
          className="syn-filter"
          placeholder="Filter people"
          aria-label="Filter people"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {self !== null && (
        <p className="syn-card-sub syn-self-note">
          {selfPerson?.name ?? self} is you, so you are left out of this list.
        </p>
      )}
      {shown.length === 0 ? (
        <p className="syn-empty">No people.</p>
      ) : (
        <ul className="syn-prow-list">
          {shown.map((p) => (
            <li key={p.slackUserId} className="syn-prow">
              <Avatar id={p.slackUserId} name={p.name} size={28} />
              <button type="button" className="syn-name-btn" onClick={() => onOpen(p.slackUserId)}>
                {p.name ?? p.slackUserId}
              </button>
              <PriorityControl person={p} onChange={(pr, extra) => onChange(p, pr, extra)} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
