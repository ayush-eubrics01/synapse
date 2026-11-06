"use client";

import type { ApprovalView, EngineeringTaskDetail, EngineeringTaskView } from "@synapse/contracts";
import { useState } from "react";
import {
  type CommitRef,
  developOutput,
  type EngineeringApproval,
  engineeringApproval,
  reasonLabel,
  safeHttpsUrl,
  shortSha,
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
      <span className="syn-eng-confirm-text">Rejecting cancels the task.</span>
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

function Body({ p, detail }: { p: EngineeringApproval; detail: EngineeringTaskDetail | null }) {
  switch (p.kind) {
    case "commit": {
      const dev = developOutput(detail);
      const files = p.files.length > 0 ? p.files : (dev?.files ?? []);
      return (
        <>
          <div className="syn-eng-row">
            {p.testsPassed === null ? (
              <Chip>Tests not run</Chip>
            ) : p.testsPassed ? (
              <Chip tone="green">Tests passed</Chip>
            ) : (
              <Chip tone="red">Tests failed</Chip>
            )}
            <span className="syn-eng-faint">
              {`${p.filesTotal} ${p.filesTotal === 1 ? "file" : "files"} changed`}
            </span>
          </div>
          <pre className="syn-eng-message">{p.message}</pre>
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
          <div className="syn-eng-pr-title">{p.title}</div>
          {p.body !== "" && <pre className="syn-eng-message">{p.body}</pre>}
        </>
      );
    case "merge_pr": {
      const href = safeHttpsUrl(p.prUrl);
      return (
        <>
          {p.autoDeploys && <DeployBanner env={p.environmentName} />}
          <div className="syn-eng-row">
            <span>{p.prNumber === null ? "Pull request" : `Pull request #${p.prNumber}`}</span>
            {p.checks !== "" && (
              <Chip
                tone={p.checks === "passing" ? "green" : p.checks === "failing" ? "red" : "neutral"}
              >
                {`checks ${p.checks}`}
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

/** One card per engineering approval kind (E20). Approve and reject are immediate API calls. */
export function EngineeringApprovalCard({
  approval: a,
  taskTitle,
  detail,
  now,
  onDecide,
}: {
  approval: ApprovalView;
  taskTitle: string | null;
  detail: EngineeringTaskDetail | null;
  now: Date | null;
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  const p = engineeringApproval(a);
  if (!p) return null;
  return (
    <CardFrame
      tag={TAGS[p.kind]}
      tone={p.kind === "merge_pr" || (p.kind === "push_pr" && p.autoDeploys) ? "red" : "blue"}
      meta={metaLine(a.createdAt, now, "engineering")}
      title={taskTitle ?? "Engineering task"}
    >
      <Body p={p} detail={detail} />
      <Actions>
        <Button variant="primary" onClick={() => onDecide(a.id, "approve")}>
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
}: {
  task: EngineeringTaskView;
  now: Date | null;
  onCancel: (taskId: string) => void;
  onOpen: (taskId: string) => void;
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
        <Button variant="secondary" onClick={() => onOpen(task.id)}>
          Open task
        </Button>
        {confirming ? (
          <span className="syn-eng-confirm">
            <span className="syn-eng-confirm-text">Cancel this task?</span>
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
