"use client";

import type {
  FactKind,
  ProjectDetail,
  RepositoryRegisterInput,
  RepositoryView,
} from "@synapse/contracts";
import { useState } from "react";
import {
  driftLabel,
  envChipLabel,
  INSPECTION_DENIED_TEXT,
  removeConfirmText,
} from "../../../lib/brain";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Chip } from "../ui/Chip";
import { type MilestoneDraft, ProjectCard } from "./ProjectCard";
import { type InspectResult, RegisterRepository, type RegisterResult } from "./RegisterRepository";

export interface ProjectsSectionProps {
  repos: RepositoryView[];
  projects: ProjectDetail[];
  /** False until the first load, so a slow load never reads as an empty section. */
  loaded: boolean;
  now: Date | null;
  hidden: ReadonlySet<string>;
  /** Changes when the palette or setup card asks for the register form. */
  registerSignal?: number;
  onInspectNow: (repoId: string) => void;
  onAcceptRemotes: (repoId: string) => void;
  onRemove: (repoId: string) => void;
  onProposal: (path: string) => Promise<InspectResult>;
  onRegister: (input: RepositoryRegisterInput) => Promise<RegisterResult>;
  onAcceptFact: (factId: string, content?: string) => void;
  onRejectFact: (factId: string) => void;
  onAddFact: (projectId: string, kind: FactKind, content: string) => void;
  onSaveMilestone: (projectId: string, milestoneId: string | null, draft: MilestoneDraft) => void;
  onDeleteMilestone: (projectId: string, milestoneId: string) => void;
}

function RepoRow({
  repo,
  onInspectNow,
  onAcceptRemotes,
  onRemove,
}: {
  repo: RepositoryView;
  onInspectNow: (id: string) => void;
  onAcceptRemotes: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const drift = driftLabel(repo.drift, repo.trackedBranch);
  return (
    <li className="syn-brain-repo">
      <div className="syn-brain-repo-main">
        <span className="syn-brain-repo-name">{repo.name}</span>
        <span className="syn-jira-mono">{repo.localPath}</span>
        <Chip tone="blue" title="Tracked branch">
          {repo.trackedBranch}
        </Chip>
        <Button variant="secondary" size="sm" onClick={() => onInspectNow(repo.id)}>
          Inspect now
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Remove
        </Button>
      </div>
      {confirming && (
        <div className="syn-brain-repo-main">
          <p role="alert">{removeConfirmText(repo.name)}</p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setConfirming(false);
              onRemove(repo.id);
            }}
          >
            Remove
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
      {repo.inspectionWarning === "permission_denied" && (
        <p className="syn-brain-drift" role="status">
          <Chip tone="amber">Inspection</Chip> {INSPECTION_DENIED_TEXT}
        </p>
      )}
      {repo.environments.length > 0 && (
        <div className="syn-brain-chips">
          {repo.environments.map((e) => (
            <Chip key={e.id} tone={e.protected ? "amber" : "neutral"}>
              {envChipLabel(e)}
            </Chip>
          ))}
        </div>
      )}
      {drift && (
        <p className="syn-brain-drift" role="status">
          <Chip tone="amber">Drift</Chip> {drift}
          {repo.drift?.remotesChanged && (
            <>
              {" "}
              <Button variant="secondary" size="sm" onClick={() => onAcceptRemotes(repo.id)}>
                Accept current remotes
              </Button>
            </>
          )}
        </p>
      )}
    </li>
  );
}

/** The Projects section (spec C13): repositories, the register flow, and project cards. */
export function ProjectsSection(p: ProjectsSectionProps) {
  return (
    <Card>
      <div className="syn-card-head">
        <h2>Projects</h2>
      </div>
      {p.loaded && p.repos.length === 0 && (
        <p className="syn-jira-faint">
          No repositories yet. Register one to start building the Engineering Brain.
        </p>
      )}
      {p.repos.length > 0 && (
        <ul className="syn-brain-repos" aria-label="Repositories">
          {p.repos.map((r) => (
            <RepoRow
              key={r.id}
              repo={r}
              onInspectNow={p.onInspectNow}
              onAcceptRemotes={p.onAcceptRemotes}
              onRemove={p.onRemove}
            />
          ))}
        </ul>
      )}
      <RegisterRepository
        onInspect={p.onProposal}
        onRegister={p.onRegister}
        openSignal={p.registerSignal}
      />
      {p.projects.map((d) => (
        <ProjectCard
          key={d.id}
          project={d}
          now={p.now}
          hidden={p.hidden}
          onAcceptFact={p.onAcceptFact}
          onRejectFact={p.onRejectFact}
          onAddFact={p.onAddFact}
          onSaveMilestone={p.onSaveMilestone}
          onDeleteMilestone={p.onDeleteMilestone}
        />
      ))}
    </Card>
  );
}
