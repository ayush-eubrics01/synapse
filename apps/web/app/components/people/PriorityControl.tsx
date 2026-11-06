"use client";

import type { PersonPriorityDto } from "../../../lib/api";
import { Segmented } from "../ui/Segmented";
import { Switch } from "../ui/Switch";

// The API's priorities are normal, high and critical (there is no "low").
const OPTIONS: ReadonlyArray<{ value: PersonPriorityDto; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

/** Priority radiogroup plus the Extra attention switch, shared by the list and the drawer. */
export function PriorityControl({
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
  const name = person.name ?? person.slackUserId;
  return (
    <div className="syn-prio">
      <span className="syn-prio-seg">
        <Segmented
          ariaLabel={`Priority for ${name}`}
          options={OPTIONS}
          value={person.priority}
          onChange={(p) => onChange(p, person.extraAttention)}
        />
      </span>
      <Switch
        label="Extra attention"
        checked={person.extraAttention}
        onChange={(v) => onChange(person.priority, v)}
      />
    </div>
  );
}
