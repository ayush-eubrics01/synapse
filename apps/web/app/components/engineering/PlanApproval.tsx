"use client";

import type { EngineeringTaskDetail, RepositoryView } from "@synapse/contracts";
import { useState } from "react";
import {
  defaultPlanForm,
  deployEnvironment,
  parentBranchError,
  taskBranchOf,
  testCommandError,
} from "../../../lib/engineering";
import { Button } from "../ui/Button";

export interface PlanApprovalValues {
  parentBranch: string;
  testCommand: string;
  environmentId?: string;
  rememberAsTracked?: boolean;
}

/**
 * Plan approval with branch confirmation (E4): the user confirms the parent branch, the test
 * command and the environment before anything runs. Nothing here is a default the backend applies:
 * the values shown are what will be sent.
 */
export function PlanApproval({
  task,
  repo,
  onApprove,
}: {
  task: EngineeringTaskDetail;
  repo: RepositoryView | null;
  /** Resolves to an error text, or null on success. */
  onApprove: (v: PlanApprovalValues) => Promise<string | null>;
}) {
  const initial = defaultPlanForm(task, repo);
  const [environmentId, setEnvironmentId] = useState(initial.environmentId);
  const [parentBranch, setParentBranch] = useState(initial.parentBranch);
  const [testCommand, setTestCommand] = useState(initial.testCommand);
  const [remember, setRemember] = useState(initial.remember);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const branchError = parentBranchError(parentBranch, repo);
  const commandError = testCommandError(testCommand);
  const deploy = deployEnvironment(repo, environmentId, parentBranch);
  const valid = branchError === null && commandError === null && repo !== null;
  const plan = task.plan;
  const branches = [
    ...new Set([repo?.trackedBranch, ...(repo?.environments.map((e) => e.branch) ?? [])]),
  ].filter((b): b is string => !!b);

  const pickEnvironment = (id: string) => {
    setEnvironmentId(id);
    const env = repo?.environments.find((e) => e.id === id);
    if (env) setParentBranch(env.branch);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const e = await onApprove({
      parentBranch,
      testCommand,
      ...(environmentId ? { environmentId } : {}),
      ...(remember ? { rememberAsTracked: true } : {}),
    });
    setBusy(false);
    if (e) setError(e);
  };

  return (
    <form
      className="syn-eng-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void submit();
      }}
    >
      {plan && (
        <div className="syn-eng-plan">
          <p className="syn-eng-plan-summary">{plan.summary}</p>
          <ol className="syn-eng-plan-steps">
            {plan.plan.map((s) => (
              <li key={s.step}>{s.step}</li>
            ))}
          </ol>
          {plan.filesLikelyTouched.length > 0 && (
            <div>
              <div className="syn-eng-label">Files likely touched</div>
              <ul className="syn-eng-files">
                {plan.filesLikelyTouched.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          {plan.unclear.length > 0 && (
            <div>
              <div className="syn-eng-label">Claude was unsure about</div>
              <ul className="syn-eng-files">
                {plan.unclear.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <label className="syn-eng-field">
        <span>Environment</span>
        <select value={environmentId} onChange={(e) => pickEnvironment(e.target.value)}>
          <option value="">No environment</option>
          {(repo?.environments ?? []).map((e) => (
            <option key={e.id} value={e.id} disabled={e.protected}>
              {e.protected ? `${e.name} (protected)` : e.name}
            </option>
          ))}
        </select>
      </label>

      <label className="syn-eng-field">
        <span>Parent branch</span>
        <input
          value={parentBranch}
          list={`branches-${task.id}`}
          onChange={(e) => setParentBranch(e.target.value)}
          spellCheck={false}
        />
        <datalist id={`branches-${task.id}`}>
          {branches.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </label>
      {branchError && <p className="syn-eng-field-error">{branchError}</p>}

      <label className="syn-eng-field">
        <span>Test command</span>
        <input
          value={testCommand}
          onChange={(e) => setTestCommand(e.target.value)}
          spellCheck={false}
        />
      </label>
      {commandError && <p className="syn-eng-field-error">{commandError}</p>}

      <label className="syn-eng-check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Remember as tracked branch</span>
      </label>

      {deploy && (
        <p className="syn-eng-deploy" role="alert">
          {`Merging the PR deploys ${deploy.name}`}
        </p>
      )}

      <dl className="syn-eng-facts">
        <dt>Task branch</dt>
        <dd>{taskBranchOf(task)}</dd>
        <dt>Pull request</dt>
        <dd>{`PR origin/${parentBranch || "<parent>"} → upstream/${parentBranch || "<parent>"}`}</dd>
      </dl>

      {error && <p className="syn-eng-field-error">{error}</p>}
      <div className="syn-eng-actions">
        <Button type="submit" variant="primary" disabled={!valid || busy}>
          Approve plan
        </Button>
      </div>
    </form>
  );
}
