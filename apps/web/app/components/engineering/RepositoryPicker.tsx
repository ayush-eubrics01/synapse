"use client";

import type { RepositoryView } from "@synapse/contracts";
import { useState } from "react";
import { repositoryChoices, type TaskSource } from "../../../lib/engineering";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

/** Asks which repository an ambiguous proposal belongs to; the user's choice is sent explicitly. */
export function RepositoryPicker({
  source,
  repos,
  onPick,
  onCancel,
}: {
  source: TaskSource;
  repos: RepositoryView[];
  onPick: (source: TaskSource, repositoryId: string) => void;
  onCancel: () => void;
}) {
  const choices = repositoryChoices(repos);
  const [id, setId] = useState(choices[0]?.id ?? "");
  return (
    <Card>
      <fieldset aria-label="Choose a repository" className="syn-eng-form syn-eng-picker">
        <p className="syn-eng-note">
          More than one repository could apply. Choose where this task should run.
        </p>
        <label className="syn-eng-field">
          <span>Repository</span>
          <select value={id} onChange={(e) => setId(e.target.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="syn-eng-actions">
          <Button variant="primary" disabled={id === ""} onClick={() => onPick(source, id)}>
            Create task
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </fieldset>
    </Card>
  );
}
