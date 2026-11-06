"use client";

import type { RepositoryProposal, RepositoryRegisterInput } from "@synapse/contracts";
import { JIRA_PROJECT_KEY_RE } from "@synapse/contracts/patterns";
import { useEffect, useState } from "react";
import { REGISTER_ANCHOR, registryErrorLabel } from "../../../lib/brain";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";

export type InspectResult =
  | { ok: true; proposal: RepositoryProposal }
  | { ok: false; error: string };
export type RegisterResult = { ok: true } | { ok: false; error: string };

interface EnvRow {
  key: number;
  name: string;
  branch: string;
  protected: boolean;
  autoDeploysOnMerge: boolean;
}

/**
 * The proposal-then-confirm flow (spec C13): a path is inspected first (nothing is saved), then
 * the user confirms a form prefilled from the proposal. Errors are shown inline with fixed labels.
 */
export function RegisterRepository({
  onInspect,
  onRegister,
  openSignal = 0,
  initialOpen = false,
  initialPath = "",
  initialProposal = null,
  initialError = null,
}: {
  onInspect: (path: string) => Promise<InspectResult>;
  onRegister: (input: RepositoryRegisterInput) => Promise<RegisterResult>;
  /** Changes whenever something else asks for the form to open (palette, setup card). */
  openSignal?: number;
  /** Tests only: the starting state. */
  initialOpen?: boolean;
  initialPath?: string;
  initialProposal?: RepositoryProposal | null;
  initialError?: string | null;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [path, setPath] = useState(initialPath);
  const [proposal, setProposal] = useState<RepositoryProposal | null>(initialProposal);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(initialProposal?.suggestedName ?? "");
  const [tracked, setTracked] = useState(
    initialProposal?.suggestedTrackedBranch ?? initialProposal?.branches[0] ?? "",
  );
  const [envs, setEnvs] = useState<EnvRow[]>(() =>
    (initialProposal?.environmentCandidates ?? []).map((c, i) => ({
      key: i,
      name: c.name,
      branch: c.branch,
      protected: false,
      autoDeploysOnMerge: false,
    })),
  );
  const [nextKey, setNextKey] = useState(initialProposal?.environmentCandidates.length ?? 0);
  const [jira, setJira] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  const fill = (p: RepositoryProposal) => {
    setProposal(p);
    setName(p.suggestedName);
    setTracked(p.suggestedTrackedBranch ?? p.branches[0] ?? "");
    setEnvs(
      p.environmentCandidates.map((c, i) => ({
        key: i,
        name: c.name,
        branch: c.branch,
        protected: false,
        autoDeploysOnMerge: false,
      })),
    );
    setNextKey(p.environmentCandidates.length);
  };

  const reset = () => {
    setOpen(false);
    setPath("");
    setProposal(null);
    setError(null);
    setJira("");
    setNotes("");
  };

  const inspect = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await onInspect(path.trim());
      if (r.ok) fill(r.proposal);
      else setError(r.error);
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    const keys = [
      ...new Set(
        jira
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k !== ""),
      ),
    ];
    const bad = keys.filter((k) => !JIRA_PROJECT_KEY_RE.test(k));
    if (bad.length > 0) {
      setError(`bad_jira_keys:${bad.join(", ")}`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const r = await onRegister({
        path: proposal?.realpath ?? path.trim(),
        name: name.trim(),
        trackedBranch: tracked,
        environments: envs.map((e) => ({
          name: e.name.trim(),
          branch: e.branch,
          protected: e.protected,
          autoDeploysOnMerge: e.autoDeploysOnMerge,
        })),
        jiraProjectKeys: keys,
        ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
      });
      if (r.ok) reset();
      else setError(r.error);
    } finally {
      setBusy(false);
    }
  };

  const patchEnv = (key: number, patch: Partial<EnvRow>) =>
    setEnvs((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const errorText =
    error === null
      ? null
      : error.startsWith("bad_jira_keys:")
        ? `Not a Jira project key: ${error.slice("bad_jira_keys:".length)}`
        : registryErrorLabel(error);

  if (!open) {
    return (
      <div id={REGISTER_ANCHOR} className="syn-brain-register">
        <Button variant="primary" onClick={() => setOpen(true)}>
          Register a repository
        </Button>
      </div>
    );
  }

  const branches = proposal?.branches ?? [];
  return (
    <div id={REGISTER_ANCHOR} className="syn-brain-register">
      <h3 className="syn-brain-subhead">Register a repository</h3>
      <div className="syn-brain-row">
        <label className="syn-brain-field syn-brain-grow">
          <span className="syn-ncard-faint">Repository path</span>
          <input
            className="syn-ncard-input syn-brain-wide"
            value={path}
            placeholder="/home/you/projects/app"
            aria-invalid={proposal === null && errorText !== null}
            disabled={proposal !== null}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        {proposal === null && (
          <Button
            variant="primary"
            disabled={busy || path.trim() === ""}
            onClick={() => void inspect()}
          >
            Inspect
          </Button>
        )}
      </div>
      {proposal !== null && (
        <div className="syn-brain-form">
          <p className="syn-ncard-faint">
            {proposal.originUrl ? `origin ${proposal.originUrl}` : "no origin remote"}
            {proposal.upstreamUrl ? ` · upstream ${proposal.upstreamUrl}` : ""}
          </p>
          <label className="syn-brain-field">
            <span className="syn-ncard-faint">Name</span>
            <input
              className="syn-ncard-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="syn-brain-field">
            <span className="syn-ncard-faint">Tracked branch</span>
            <select
              className="syn-ncard-input"
              value={tracked}
              onChange={(e) => setTracked(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="syn-brain-envs">
            <legend className="syn-ncard-faint">Environments</legend>
            {envs.map((e) => (
              <div key={e.key} className="syn-brain-env">
                <input
                  className="syn-ncard-input"
                  aria-label="Environment name"
                  value={e.name}
                  onChange={(ev) => patchEnv(e.key, { name: ev.target.value })}
                />
                <select
                  className="syn-ncard-input"
                  aria-label="Environment branch"
                  value={e.branch}
                  onChange={(ev) => patchEnv(e.key, { branch: ev.target.value })}
                >
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <Switch
                  label="Protected"
                  checked={e.protected}
                  onChange={(v) => patchEnv(e.key, { protected: v })}
                />
                <Switch
                  label="Auto-deploys on merge"
                  checked={e.autoDeploysOnMerge}
                  onChange={(v) => patchEnv(e.key, { autoDeploysOnMerge: v })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEnvs((rows) => rows.filter((r) => r.key !== e.key))}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEnvs((rows) => [
                  ...rows,
                  {
                    key: nextKey,
                    name: "",
                    branch: tracked,
                    protected: false,
                    autoDeploysOnMerge: false,
                  },
                ]);
                setNextKey((n) => n + 1);
              }}
            >
              Add environment
            </Button>
          </fieldset>
          <label className="syn-brain-field">
            <span className="syn-ncard-faint">Jira project keys</span>
            <input
              className="syn-ncard-input"
              value={jira}
              placeholder="e.g. DEMO, OPS"
              onChange={(e) => setJira(e.target.value)}
            />
          </label>
          <label className="syn-brain-field">
            <span className="syn-ncard-faint">Notes</span>
            <textarea
              className="syn-ncard-textarea"
              rows={2}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <div className="syn-ncard-actions">
            <Button
              variant="primary"
              disabled={busy || name.trim() === ""}
              onClick={() => void register()}
            >
              Register repository
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {errorText && (
        <p role="alert" className="syn-brain-error">
          {errorText}
        </p>
      )}
      {proposal === null && (
        <div className="syn-ncard-actions">
          <Button variant="ghost" size="sm" onClick={reset}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
