"use client";

import type { FactKind, MilestoneView, ProjectDetail } from "@synapse/contracts";
import { useState } from "react";
import {
  brainFactKey,
  FACT_KINDS,
  factKindLabel,
  groupFacts,
  milestoneLabel,
} from "../../../lib/brain";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";

export interface MilestoneDraft {
  name: string;
  targetDate: string;
  environmentId: string | null;
  status?: MilestoneView["status"];
}

export interface ProjectCardProps {
  project: ProjectDetail;
  now: Date | null;
  /** Keys with a pending deferred commit (a fact reject): hidden until it lands. */
  hidden: ReadonlySet<string>;
  onAcceptFact: (factId: string, content?: string) => void;
  onRejectFact: (factId: string) => void;
  onAddFact: (projectId: string, kind: FactKind, content: string) => void;
  /** `milestoneId` null creates one. */
  onSaveMilestone: (projectId: string, milestoneId: string | null, draft: MilestoneDraft) => void;
  onDeleteMilestone: (projectId: string, milestoneId: string) => void;
  /** Tests only: the starting state (a milestone id or "new" being edited; a delete being confirmed). */
  initialEditingMilestone?: string | "new" | null;
  initialConfirmDelete?: string | null;
}

const MILESTONE_STATUSES: readonly MilestoneView["status"][] = [
  "planned",
  "done",
  "slipped",
  "cancelled",
];

const ATTENTION_LABEL: Record<string, string> = {
  overdue: "overdue",
  blocked: "blocked",
  due_soon: "due soon",
  stale: "stale",
};

function PendingFact({
  id,
  kind,
  content,
  onAccept,
  onReject,
}: {
  id: string;
  kind: FactKind;
  content: string;
  onAccept: (id: string, content?: string) => void;
  onReject: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);
  return (
    <li className="syn-brain-fact is-pending">
      <Chip mono>{factKindLabel(kind)}</Chip>
      {editing ? (
        <textarea
          className="syn-ncard-textarea"
          aria-label="Fact text"
          rows={2}
          maxLength={400}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <span className="syn-brain-fact-text">{content}</span>
      )}
      <span className="syn-brain-fact-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={editing && text.trim() === ""}
          onClick={() => onAccept(id, editing && text.trim() !== content ? text.trim() : undefined)}
        >
          Accept
        </Button>
        {!editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => onReject(id)}>
          Reject
        </Button>
      </span>
    </li>
  );
}

function MilestoneForm({
  initial,
  environments,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: MilestoneDraft;
  environments: Array<{ id: string; name: string }>;
  submitLabel: string;
  onSubmit: (d: MilestoneDraft) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [date, setDate] = useState(initial.targetDate);
  const [env, setEnv] = useState(initial.environmentId ?? "");
  // Only an existing milestone's form offers a status; a new one is always planned.
  const [status, setStatus] = useState(initial.status);
  const valid = name.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return (
    <div className="syn-brain-milestone-form">
      <input
        className="syn-ncard-input"
        aria-label="Milestone name"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="syn-ncard-input"
        aria-label="Target date"
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <select
        className="syn-ncard-input"
        aria-label="Environment"
        value={env}
        onChange={(e) => setEnv(e.target.value)}
      >
        <option value="">No environment</option>
        {environments.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {status !== undefined && (
        <select
          className="syn-ncard-input"
          aria-label="Milestone status"
          value={status}
          onChange={(e) => setStatus(e.target.value as MilestoneView["status"])}
        >
          {MILESTONE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}
      <Button
        variant="primary"
        size="sm"
        disabled={!valid}
        onClick={() =>
          onSubmit({
            name: name.trim(),
            targetDate: date,
            environmentId: env === "" ? null : env,
            ...(status !== undefined ? { status } : {}),
          })
        }
      >
        {submitLabel}
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** One project (spec C13): summary, approved facts by kind, facts to review, milestones, Jira. */
export function ProjectCard({
  project,
  now,
  hidden,
  onAcceptFact,
  onRejectFact,
  onAddFact,
  onSaveMilestone,
  onDeleteMilestone,
  initialEditingMilestone = null,
  initialConfirmDelete = null,
}: ProjectCardProps) {
  const [editingMilestone, setEditingMilestone] = useState<string | "new" | null>(
    initialEditingMilestone,
  );
  const [confirmDelete, setConfirmDelete] = useState<string | null>(initialConfirmDelete);
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState<FactKind>("note");
  const [newText, setNewText] = useState("");
  const groups = groupFacts(project.facts);
  const pending = project.facts.filter(
    (f) => f.status === "needs_review" && !hidden.has(brainFactKey(f.id)),
  );
  const environments = project.repositories.flatMap((r) =>
    r.environments.map((e) => ({ id: e.id, name: `${r.name} · ${e.name}` })),
  );
  const attention = Object.entries(project.jira?.byAttention ?? {}).filter(([, n]) => n > 0);
  return (
    <article className="syn-brain-project" id={`project-${project.id}`}>
      <header className="syn-brain-project-head">
        <h3 className="syn-brain-project-name">{project.name}</h3>
        {project.factsNeedingReview > 0 && (
          <Chip tone="amber">{project.factsNeedingReview} to review</Chip>
        )}
      </header>
      {project.summary && <p className="syn-brain-summary">{project.summary}</p>}

      {groups.length === 0 && pending.length === 0 && (
        <p className="syn-jira-faint">No facts yet. Inspect the repository to collect some.</p>
      )}
      {groups.map((g) => (
        <section key={g.kind} className="syn-brain-group" aria-label={g.label}>
          <h4 className="syn-brain-group-head">{g.label}</h4>
          <ul className="syn-brain-facts">
            {g.facts.map((f) => (
              <li key={f.id} className="syn-brain-fact">
                <span className="syn-brain-fact-text">{f.content}</span>
                {f.evidence.length > 0 && (
                  <span className="syn-brain-evidence">
                    {f.evidence.map((e) => (e.line ? `${e.path}:${e.line}` : e.path)).join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {pending.length > 0 && (
        <section className="syn-brain-group" aria-label="Needs review">
          <h4 className="syn-brain-group-head">Needs review</h4>
          <ul className="syn-brain-facts">
            {pending.map((f) => (
              <PendingFact
                key={f.id}
                id={f.id}
                kind={f.kind}
                content={f.content}
                onAccept={onAcceptFact}
                onReject={onRejectFact}
              />
            ))}
          </ul>
        </section>
      )}

      {adding ? (
        <div className="syn-brain-milestone-form">
          <select
            className="syn-ncard-input"
            aria-label="Fact kind"
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as FactKind)}
          >
            {FACT_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <input
            className="syn-ncard-input syn-brain-grow"
            aria-label="New fact"
            value={newText}
            maxLength={400}
            onChange={(e) => setNewText(e.target.value)}
          />
          <Button
            variant="primary"
            size="sm"
            disabled={newText.trim() === ""}
            onClick={() => {
              onAddFact(project.id, newKind, newText.trim());
              setNewText("");
              setAdding(false);
            }}
          >
            Save fact
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="link" onClick={() => setAdding(true)}>
          Add a fact
        </Button>
      )}

      <section className="syn-brain-group" aria-label="Milestones">
        <h4 className="syn-brain-group-head">Milestones</h4>
        {project.milestones.length === 0 && <p className="syn-jira-faint">No milestones yet.</p>}
        <ul className="syn-brain-facts">
          {project.milestones.map((m) =>
            editingMilestone === m.id ? (
              <li key={m.id}>
                <MilestoneForm
                  initial={{
                    name: m.name,
                    targetDate: m.targetDate,
                    environmentId: m.environmentId,
                    status: m.status,
                  }}
                  environments={environments}
                  submitLabel="Save milestone"
                  onSubmit={(d) => {
                    onSaveMilestone(project.id, m.id, d);
                    setEditingMilestone(null);
                  }}
                  onCancel={() => setEditingMilestone(null)}
                />
              </li>
            ) : (
              <li key={m.id} className="syn-brain-milestone">
                <span className="syn-brain-fact-text">
                  {m.name}
                  {m.environmentName ? ` · ${m.environmentName}` : ""} · {m.targetDate}
                </span>
                <Chip tone={m.overdue ? "red" : m.status === "planned" ? "blue" : "neutral"}>
                  {milestoneLabel(m, now)}
                </Chip>
                <span className="syn-brain-fact-actions">
                  {m.status === "planned" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        onSaveMilestone(project.id, m.id, {
                          name: m.name,
                          targetDate: m.targetDate,
                          environmentId: m.environmentId,
                          status: "done",
                        })
                      }
                    >
                      Mark done
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setEditingMilestone(m.id)}>
                    Edit milestone
                  </Button>
                  {confirmDelete === m.id ? (
                    <>
                      <span className="syn-ncard-faint" role="status">
                        Delete this milestone?
                      </span>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          setConfirmDelete(null);
                          onDeleteMilestone(project.id, m.id);
                        }}
                      >
                        Confirm delete
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(m.id)}>
                      Delete
                    </Button>
                  )}
                </span>
              </li>
            ),
          )}
        </ul>
        {editingMilestone === "new" ? (
          <MilestoneForm
            initial={{ name: "", targetDate: "", environmentId: null }}
            environments={environments}
            submitLabel="Add"
            onSubmit={(d) => {
              onSaveMilestone(project.id, null, d);
              setEditingMilestone(null);
            }}
            onCancel={() => setEditingMilestone(null)}
          />
        ) : (
          <Button variant="link" onClick={() => setEditingMilestone("new")}>
            Add milestone
          </Button>
        )}
      </section>

      {project.jira && attention.length > 0 && (
        <section className="syn-brain-group" aria-label="Jira attention">
          <h4 className="syn-brain-group-head">Jira attention</h4>
          <p className="syn-jira-faint">
            {attention.map(([k, n]) => `${n} ${ATTENTION_LABEL[k] ?? k}`).join(" · ")}
          </p>
          <ul className="syn-brain-facts">
            {project.jira.top.map((i) => (
              <li key={i.key} className="syn-jira-mini-row">
                <span className="syn-jira-key">{i.key}</span>
                <span className="syn-jira-summary">{i.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
