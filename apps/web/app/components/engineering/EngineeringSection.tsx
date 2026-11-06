"use client";

import type {
  DashboardOverview,
  EngineeringTaskDetail,
  EngineeringTaskView,
  RepositoryView,
} from "@synapse/contracts";
import { useState } from "react";
import {
  CANCEL_CONFIRM_TEXT,
  developOutput,
  draftSourceNote,
  groupTasks,
  isTerminal,
  lockText,
  reasonLabel,
  STATUS_LABELS,
  safeHttpsUrl,
  stepLabel,
} from "../../../lib/engineering";
import { relMinutes } from "../../../lib/format";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Chip, type ChipTone } from "../ui/Chip";
import { DiffViewer } from "./DiffViewer";
import { NewTaskForm, type NewTaskInput } from "./NewTaskForm";
import { PlanApproval, type PlanApprovalValues } from "./PlanApproval";
import { TaskTimeline } from "./TaskTimeline";

/** Each handler that can be refused resolves to an error text, or null on success. */
export interface EngineeringHandlers {
  create: (input: NewTaskInput) => Promise<string | null>;
  approveDescription: (taskId: string, description: string) => Promise<string | null>;
  approvePlan: (taskId: string, v: PlanApprovalValues) => Promise<string | null>;
  cancel: (taskId: string) => void;
}

export const engineeringRowId = (id: string) => `eng-task-${id}`;

const STATUS_TONE: Record<EngineeringTaskView["status"], ChipTone> = {
  proposed: "neutral",
  investigating: "blue",
  planned: "blue",
  approved: "neutral",
  queued: "neutral",
  in_progress: "blue",
  awaiting_approval: "amber",
  completed: "green",
  failed: "red",
  cancelled: "neutral",
  needs_attention: "red",
};

/**
 * I3: mounts the description form only once the task detail is loaded, keyed on the detail's id
 * and `updatedAt`, so the form's text always starts from the stored description (a detail that
 * arrives after the first render, or a newer one, gives a fresh form). No hooks here.
 */
export function DescriptionApproval({
  task,
  detail,
  onApprove,
}: {
  task: EngineeringTaskView;
  detail: EngineeringTaskDetail | null;
  onApprove: EngineeringHandlers["approveDescription"];
}) {
  if (!detail) return <p className="syn-eng-note">Loading the description...</p>;
  return (
    <DescriptionForm
      key={`${detail.id}:${detail.updatedAt}`}
      taskId={task.id}
      source={detail.source}
      initial={detail.approvedDescription ?? detail.draftDescription}
      onApprove={onApprove}
    />
  );
}

/** The editable description; `initial` is read once (the parent remounts it with a new key). */
export function DescriptionForm({
  taskId,
  source,
  initial,
  onApprove,
}: {
  taskId: string;
  source: EngineeringTaskView["source"];
  initial: string;
  onApprove: EngineeringHandlers["approveDescription"];
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const note = draftSourceNote(source);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const e = await onApprove(taskId, text);
    setBusy(false);
    if (e) setError(e);
  };
  return (
    <form
      className="syn-eng-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() !== "" && !busy) void submit();
      }}
    >
      {note && (
        <p className="syn-eng-source-note" role="note">
          {note}
        </p>
      )}
      <label className="syn-eng-field">
        <span>Description (edit it, then approve to start the investigation)</span>
        <textarea
          value={text}
          rows={5}
          maxLength={8000}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {error && <p className="syn-eng-field-error">{error}</p>}
      <div className="syn-eng-actions">
        <Button type="submit" variant="primary" disabled={text.trim() === "" || busy}>
          Approve description
        </Button>
      </div>
    </form>
  );
}

/** M7: "Cancel task" with inline confirmation that says what a cancel does. */
export function CancelTaskControl({
  onCancel,
  initiallyConfirming = false,
}: {
  onCancel: () => void;
  initiallyConfirming?: boolean;
}) {
  const [confirming, setConfirming] = useState(initiallyConfirming);
  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Cancel task
      </Button>
    );
  }
  return (
    <span className="syn-eng-confirm">
      <span className="syn-eng-confirm-text">{CANCEL_CONFIRM_TEXT}</span>
      <Button variant="secondary" size="sm" onClick={onCancel}>
        Cancel task
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </span>
  );
}

function TaskRow({
  task,
  detail,
  repo,
  now,
  handlers,
  sandboxEnabled,
}: {
  task: EngineeringTaskView;
  detail: EngineeringTaskDetail | null;
  repo: RepositoryView | null;
  now: Date | null;
  handlers: EngineeringHandlers;
  sandboxEnabled: boolean | null;
}) {
  const dev = developOutput(detail);
  const prHref = safeHttpsUrl(task.prUrl);
  return (
    <li className="syn-eng-task" id={engineeringRowId(task.id)}>
      <div className="syn-eng-task-head">
        <span className="syn-eng-task-title">{task.title}</span>
        <span className="syn-eng-task-meta">
          <Chip tone={STATUS_TONE[task.status]}>{STATUS_LABELS[task.status]}</Chip>
          {task.currentStep && !isTerminal(task.status) && (
            <span className="syn-eng-faint">{stepLabel(task.currentStep)}</span>
          )}
          {repo && <span className="syn-eng-faint">{repo.name}</span>}
          <span className="syn-eng-faint">{task.source}</span>
          {now && <span className="syn-eng-faint">{relMinutes(task.updatedAt, now)}</span>}
          {prHref && (
            <a className="syn-ncard-link" href={prHref} target="_blank" rel="noreferrer noopener">
              {task.prNumber === null ? "PR ↗" : `PR #${task.prNumber} ↗`}
            </a>
          )}
        </span>
      </div>
      {isTerminal(task.status) && task.failure && (
        <p className="syn-eng-reason">{reasonLabel(task.failure)}</p>
      )}
      {detail && !isTerminal(task.status) && <TaskTimeline task={detail} />}
      {task.status === "proposed" && (
        <>
          {task.failure && <p className="syn-eng-reason">{reasonLabel(task.failure)}</p>}
          <DescriptionApproval
            task={task}
            detail={detail}
            onApprove={handlers.approveDescription}
          />
        </>
      )}
      {task.status === "planned" &&
        (detail ? (
          <PlanApproval
            task={detail}
            repo={repo}
            sandboxEnabled={sandboxEnabled}
            onApprove={(v) => handlers.approvePlan(task.id, v)}
          />
        ) : (
          <p className="syn-eng-note">Loading the plan...</p>
        ))}
      {task.status === "queued" && task.lastPickupError && (
        <p className="syn-eng-reason">{`Waiting to retry: ${reasonLabel(task.lastPickupError)}`}</p>
      )}
      {task.status === "awaiting_approval" && (
        <p className="syn-eng-note">Waiting for your approval in Needs you.</p>
      )}
      {dev && !isTerminal(task.status) && (dev.diffText !== "" || dev.files.length > 0) && (
        <details className="syn-eng-changes">
          <summary>Changes</summary>
          <DiffViewer diffText={dev.diffText} truncated={dev.truncated} files={dev.files} />
        </details>
      )}
      {!isTerminal(task.status) && (
        <div className="syn-eng-actions">
          <CancelTaskControl onCancel={() => handlers.cancel(task.id)} />
        </div>
      )}
    </li>
  );
}

/** The Engineering section (E20): lock status, a new-task form and tasks grouped by what they need. */
export function EngineeringSection({
  tasks,
  details,
  repos,
  lock,
  now,
  handlers,
  sandboxEnabled = null,
}: {
  tasks: EngineeringTaskView[];
  details: Record<string, EngineeringTaskDetail>;
  repos: RepositoryView[];
  lock: DashboardOverview["engineeringLock"] | null;
  now: Date | null;
  handlers: EngineeringHandlers;
  /** The `engineering.sandbox.enabled` setting, or null while unknown. */
  sandboxEnabled?: boolean | null;
}) {
  const groups = groupTasks(tasks);
  const sections: Array<[string, EngineeringTaskView[]]> = [
    ["Active", groups.active],
    ["Plan ready", groups.planned],
    ["Proposed", groups.proposed],
    ["Queue", groups.queue],
    ["History", groups.history],
  ];
  return (
    <Card>
      <div className="syn-card-head">
        <h2>Engineering</h2>
        <span className="syn-eng-lock">
          {"eng lock "}
          <Chip tone={lock?.held ? "amber" : "neutral"}>{lockText(lock)}</Chip>
        </span>
      </div>
      <p className="syn-eng-note">
        One task runs at a time. Every commit, merge, push and PR waits for your approval in Needs
        you.
      </p>
      <details className="syn-eng-new">
        <summary>New task</summary>
        <NewTaskForm repos={repos} onCreate={handlers.create} />
      </details>
      {tasks.length === 0 && (
        <p className="syn-eng-note">
          No engineering tasks yet. Start one above, from a Jira issue, or from an inbox message.
        </p>
      )}
      {sections
        .filter(([, list]) => list.length > 0)
        .map(([label, list]) => (
          <section key={label} className="syn-eng-group" aria-label={label}>
            <h3 className="syn-eng-group-head">
              {label} <span>{list.length}</span>
            </h3>
            <ul className="syn-eng-list">
              {list.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  detail={details[t.id] ?? null}
                  repo={repos.find((r) => r.id === t.repositoryId) ?? null}
                  now={now}
                  handlers={handlers}
                  sandboxEnabled={sandboxEnabled}
                />
              ))}
            </ul>
          </section>
        ))}
    </Card>
  );
}
