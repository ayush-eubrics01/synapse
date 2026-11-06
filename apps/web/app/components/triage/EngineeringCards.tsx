"use client";

import type {
  ApprovalTextEdit,
  ApprovalView,
  EngineeringTaskDetail,
  EngineeringTaskView,
} from "@synapse/contracts";
import { useState } from "react";
import {
  type ApprovalTextValues,
  approvalTextProblem,
  approvalTextValues,
  CANCEL_CONFIRM_TEXT,
  type CommitRef,
  canCheckAgain,
  changedText,
  clockTime,
  developOutput,
  type EngineeringApproval,
  engineeringApproval,
  latestChecks,
  reasonLabel,
  safeHttpsUrl,
  shortSha,
  testChip,
} from "../../../lib/engineering";
import { DiffViewer } from "../engineering/DiffViewer";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Actions, CardFrame, Explainer, metaLine } from "./CardFrame";

const TAGS: Record<EngineeringApproval["kind"], string> = {
  commit: "ENGINEERING · COMMIT",
  merge_local: "ENGINEERING · MERGE LOCAL",
  push_pr: "ENGINEERING · PUSH & PR",
  merge_pr: "ENGINEERING · MERGE PR",
};

const APPROVE: Record<EngineeringApproval["kind"], string> = {
  commit: "Approve commit",
  merge_local: "Approve local merge",
  push_pr: "Approve push and PR",
  merge_pr: "Merge PR",
};

const MAX_COMMITS_SHOWN = 5;

/** Reject with inline confirmation: a rejected step cancels the whole task, so it asks first. */
export function RejectControl({
  onReject,
  initiallyConfirming = false,
}: {
  onReject: () => void;
  initiallyConfirming?: boolean;
}) {
  const [confirming, setConfirming] = useState(initiallyConfirming);
  if (!confirming) {
    return (
      <Button variant="secondary" onClick={() => setConfirming(true)}>
        Reject
      </Button>
    );
  }
  return (
    <span className="syn-eng-confirm">
      <span className="syn-eng-confirm-text">{CANCEL_CONFIRM_TEXT}</span>
      <Button variant="secondary" onClick={onReject}>
        Reject and cancel task
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </span>
  );
}

function DeployBanner({ env }: { env: string | null }) {
  return (
    <p className="syn-eng-deploy" role="alert">
      {`Merging the PR deploys ${env ?? "an environment"}`}
    </p>
  );
}

function Commits({ commits, total }: { commits: CommitRef[]; total: number }) {
  const shown = commits.slice(0, MAX_COMMITS_SHOWN);
  const more = Math.max(total, commits.length) - shown.length;
  return (
    <ul className="syn-eng-commits">
      {shown.map((c) => (
        <li key={`${c.sha}:${c.subject}`}>
          <code>{shortSha(c.sha)}</code> {c.subject}
        </li>
      ))}
      {more > 0 && <li className="syn-eng-faint">{`and ${more} more`}</li>}
    </ul>
  );
}

function Body({
  p,
  detail,
  text,
  onText,
}: {
  p: EngineeringApproval;
  detail: EngineeringTaskDetail | null;
  text: ApprovalTextValues;
  onText: (v: ApprovalTextValues) => void;
}) {
  switch (p.kind) {
    case "commit": {
      const dev = developOutput(detail);
      const tests = testChip(p.testsPassed, p.testRun);
      const files = p.files.length > 0 ? p.files : (dev?.files ?? []);
      return (
        <>
          <div className="syn-eng-row">
            <Chip tone={tests.tone}>{tests.label}</Chip>
            <span className="syn-eng-faint">
              {`${p.filesTotal} ${p.filesTotal === 1 ? "file" : "files"} changed`}
            </span>
          </div>
          <textarea
            className="syn-eng-edit"
            aria-label="Commit message"
            rows={6}
            value={text.commitMessage ?? ""}
            onChange={(e) => onText({ ...text, commitMessage: e.target.value })}
          />
          {dev && dev.testOutputTail !== "" && (
            <details className="syn-eng-tail">
              <summary>Test output</summary>
              <pre className="syn-diff-pre">{dev.testOutputTail}</pre>
            </details>
          )}
          <DiffViewer
            diffText={dev?.diffText ?? ""}
            truncated={dev?.truncated ?? false}
            files={files}
          />
          {p.filesTotal > files.length && (
            <p className="syn-eng-note">{`Showing ${files.length} of ${p.filesTotal} files.`}</p>
          )}
        </>
      );
    }
    case "merge_local":
      return (
        <>
          <Explainer>
            {`Merges ${p.taskBranch || "the task branch"} into ${p.parentBranch || "the parent branch"} on this machine. Nothing is pushed.`}
          </Explainer>
          <Commits
            commits={
              p.commits.length > 0 ? p.commits : [{ sha: p.commitSha, subject: "Task commit" }]
            }
            total={p.commits.length}
          />
        </>
      );
    case "push_pr":
      return (
        <>
          {p.autoDeploys && <DeployBanner env={p.environmentName} />}
          <Explainer>
            {`PR origin/${p.parentBranch} → upstream/${p.parentBranch}. Pushes ${p.parentBranch} to origin, then opens the pull request.`}
          </Explainer>
          <div className="syn-eng-label">Commits</div>
          <Commits commits={p.commits} total={p.commitsTotal} />
          <div className="syn-eng-label">Pull request</div>
          <input
            className="syn-eng-edit"
            aria-label="PR title"
            value={text.prTitle ?? ""}
            onChange={(e) => onText({ ...text, prTitle: e.target.value })}
          />
          <textarea
            className="syn-eng-edit"
            aria-label="PR body"
            rows={6}
            value={text.prBody ?? ""}
            onChange={(e) => onText({ ...text, prBody: e.target.value })}
          />
        </>
      );
    case "merge_pr": {
      const href = safeHttpsUrl(p.prUrl);
      const checks = latestChecks({ checks: p.checks, checkedAt: p.checkedAt }, detail);
      const at = checks.checkedAt ? clockTime(checks.checkedAt) : "";
      return (
        <>
          {p.autoDeploys && <DeployBanner env={p.environmentName} />}
          <div className="syn-eng-row">
            <span>{p.prNumber === null ? "Pull request" : `Pull request #${p.prNumber}`}</span>
            {checks.checks !== "" && (
              <Chip
                tone={
                  checks.checks === "passing"
                    ? "green"
                    : checks.checks === "failing"
                      ? "red"
                      : "neutral"
                }
              >
                {at === "" ? `checks ${checks.checks}` : `checks ${checks.checks} at ${at}`}
              </Chip>
            )}
            {p.mergeable !== "" && (
              <span className="syn-eng-faint">{p.mergeable.toLowerCase()}</span>
            )}
            {href && (
              <a className="syn-ncard-link" href={href} target="_blank" rel="noreferrer noopener">
                Open PR ↗
              </a>
            )}
          </div>
          <Explainer>The PR merges only after you approve here.</Explainer>
        </>
      );
    }
  }
}

/**
 * Saves unsaved text edits, then decides. A save that fails with an error sentence stops the
 * decision, so the user never approves text other than what is on screen.
 */
export async function approveWithEdits(
  save: () => Promise<string | null>,
  decide: () => void,
): Promise<string | null> {
  const error = await save();
  if (error !== null) return error;
  decide();
  return null;
}

/** One card per engineering approval kind (E20). Approve and reject are immediate API calls. */
export function EngineeringApprovalCard({
  approval: a,
  taskTitle,
  detail,
  now,
  onDecide,
  onSaveText,
}: {
  approval: ApprovalView;
  taskTitle: string | null;
  detail: EngineeringTaskDetail | null;
  now: Date | null;
  onDecide: (id: string, decision: "approve" | "reject") => void;
  /** Resolves to an error sentence, or null once the text is saved. */
  onSaveText: (
    taskId: string,
    approvalId: string,
    edit: ApprovalTextEdit,
  ) => Promise<string | null>;
}) {
  const p = engineeringApproval(a);
  const original = p ? approvalTextValues(p) : null;
  const [draft, setDraft] = useState<ApprovalTextValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  const text = draft ?? original ?? {};
  const edit = original ? changedText(original, text) : {};
  const dirty = Object.keys(edit).length > 0;
  const problem = original ? approvalTextProblem(text) : null;
  const save = async (): Promise<string | null> => {
    if (!dirty) return null;
    setBusy(true);
    const err = await onSaveText(p.taskId, a.id, edit);
    setBusy(false);
    setError(err);
    if (err === null) setDraft(null);
    return err;
  };
  return (
    <CardFrame
      tag={TAGS[p.kind]}
      tone={p.kind === "merge_pr" || (p.kind === "push_pr" && p.autoDeploys) ? "red" : "blue"}
      meta={metaLine(a.createdAt, now, "engineering")}
      title={taskTitle ?? "Engineering task"}
    >
      <Body p={p} detail={detail} text={text} onText={setDraft} />
      {original && problem !== null && <p className="syn-eng-reason">{problem}</p>}
      {error !== null && (
        <p className="syn-eng-reason" role="alert">
          {error}
        </p>
      )}
      <Actions>
        {original && (
          <Button
            variant="secondary"
            disabled={!dirty || problem !== null || busy}
            onClick={() => void save()}
          >
            Save
          </Button>
        )}
        <Button
          variant="primary"
          disabled={busy || (dirty && problem !== null)}
          onClick={() => void approveWithEdits(save, () => onDecide(a.id, "approve"))}
        >
          {APPROVE[p.kind]}
        </Button>
        <RejectControl onReject={() => onDecide(a.id, "reject")} />
      </Actions>
    </CardFrame>
  );
}

/** A planned task: the plan is read and approved (with branch confirmation) in the Engineering section. */
export function EngineeringPlanCard({
  task,
  detail,
  now,
  onOpen,
}: {
  task: EngineeringTaskView;
  detail: EngineeringTaskDetail | null;
  now: Date | null;
  onOpen: (taskId: string) => void;
}) {
  const plan = detail?.plan ?? null;
  return (
    <CardFrame
      tag="ENGINEERING · APPROVE PLAN"
      tone="blue"
      meta={metaLine(task.updatedAt, now, "engineering")}
      title={task.title}
    >
      {plan ? (
        <Explainer>{`${plan.summary} (${plan.plan.length} steps, risk ${plan.risk}, size ${plan.size})`}</Explainer>
      ) : (
        <Explainer>
          The plan is ready. Confirm the parent branch and test command to start.
        </Explainer>
      )}
      <Actions>
        <Button variant="primary" onClick={() => onOpen(task.id)}>
          Review plan
        </Button>
      </Actions>
    </CardFrame>
  );
}

/** A task stopped on a fixed reason; the user resolves it by hand, then cancels the task. */
export function EngineeringAttentionCard({
  task,
  now,
  onCancel,
  onOpen,
  onCheckAgain,
}: {
  task: EngineeringTaskView;
  now: Date | null;
  onCancel: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onCheckAgain: (taskId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <CardFrame
      tag="ENGINEERING · NEEDS ATTENTION"
      tone="red"
      meta={metaLine(task.updatedAt, now, "engineering")}
      title={task.title}
    >
      <Explainer>{reasonLabel(task.failure) || "The task stopped and needs a decision."}</Explainer>
      <Actions>
        {canCheckAgain(task) && (
          <Button variant="primary" onClick={() => onCheckAgain(task.id)}>
            Check again
          </Button>
        )}
        <Button variant="secondary" onClick={() => onOpen(task.id)}>
          Open task
        </Button>
        {confirming ? (
          <span className="syn-eng-confirm">
            <span className="syn-eng-confirm-text">{CANCEL_CONFIRM_TEXT}</span>
            <Button variant="secondary" onClick={() => onCancel(task.id)}>
              Cancel task
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Cancel task
          </Button>
        )}
      </Actions>
    </CardFrame>
  );
}
