"use client";

import type { RepositoryView } from "@synapse/contracts";
import { useState } from "react";
import { Button } from "../ui/Button";

export interface NewTaskInput {
  repositoryId: string;
  title: string;
  draftDescription: string;
}

/** A task from scratch (E2). It starts as a proposal: nothing runs until the description is approved. */
export function NewTaskForm({
  repos,
  onCreate,
}: {
  repos: RepositoryView[];
  /** Resolves to an error text, or null on success. */
  onCreate: (input: NewTaskInput) => Promise<string | null>;
}) {
  const [repositoryId, setRepositoryId] = useState(repos[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (repos.length === 0) {
    return (
      <p className="syn-eng-note">Register a repository in Projects before creating a task.</p>
    );
  }
  const repoId = repos.some((r) => r.id === repositoryId) ? repositoryId : (repos[0]?.id ?? "");
  const valid = title.trim() !== "" && description.trim() !== "";

  const submit = async () => {
    setBusy(true);
    setError(null);
    const e = await onCreate({
      repositoryId: repoId,
      title: title.trim(),
      draftDescription: description,
    });
    setBusy(false);
    if (e) setError(e);
    else {
      setTitle("");
      setDescription("");
    }
  };

  return (
    <form
      className="syn-eng-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void submit();
      }}
    >
      <label className="syn-eng-field">
        <span>Repository</span>
        <select value={repoId} onChange={(e) => setRepositoryId(e.target.value)}>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="syn-eng-field">
        <span>Title</span>
        <input
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Fix the retry loop"
        />
      </label>
      <label className="syn-eng-field">
        <span>What should change?</span>
        <textarea
          value={description}
          rows={4}
          maxLength={8000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {error && <p className="syn-eng-field-error">{error}</p>}
      <div className="syn-eng-actions">
        <Button type="submit" variant="primary" disabled={!valid || busy}>
          Propose task
        </Button>
      </div>
    </form>
  );
}
