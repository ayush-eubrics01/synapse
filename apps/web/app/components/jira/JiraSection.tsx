"use client";

import type { JiraIssueView } from "@synapse/contracts";
import { useState } from "react";
import type { JiraStatusDto } from "../../../lib/api";
import { relMinutes } from "../../../lib/format";
import {
  attentionLabel,
  dueLabel,
  groupIssues,
  jiraErrorLabel,
  jiraRowId,
} from "../../../lib/jira";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Chip, type ChipTone } from "../ui/Chip";

const STATUS_TONE: Record<JiraIssueView["statusCategory"], ChipTone> = {
  new: "neutral",
  indeterminate: "blue",
  done: "green",
};

function Row({
  i,
  now,
  onCreateTask,
}: {
  i: JiraIssueView;
  now: Date | null;
  onCreateTask?: (key: string) => void;
}) {
  const attention = attentionLabel(i, now);
  const due = dueLabel(i, now);
  const n = i.slackMentions.count;
  return (
    <li className="syn-jira-row" id={jiraRowId(i.key)}>
      <div className="syn-jira-main">
        <span className="syn-jira-key">{i.key}</span>
        <span className="syn-jira-summary" title={i.summary}>
          {i.summary}
        </span>
      </div>
      <div className="syn-jira-meta">
        {attention && (
          <Chip tone={i.attention === "overdue" || i.attention === "blocked" ? "red" : "amber"}>
            {attention}
          </Chip>
        )}
        <Chip tone={STATUS_TONE[i.statusCategory]}>{i.statusName}</Chip>
        {i.priority && <span className="syn-jira-faint">{i.priority}</span>}
        {due && (
          <span className={due.overdue ? "syn-jira-due is-overdue" : "syn-jira-faint"}>
            {due.text}
          </span>
        )}
        {now && <span className="syn-jira-faint">{relMinutes(i.updatedAt, now)}</span>}
        {n > 0 && (
          <span className="syn-jira-mono">
            {n} Slack {n === 1 ? "mention" : "mentions"}
          </span>
        )}
        {onCreateTask && (
          <Button variant="ghost" size="sm" onClick={() => onCreateTask(i.key)}>
            Create task
          </Button>
        )}
        {i.webUrl?.startsWith("https://") && (
          <a className="syn-ncard-link" href={i.webUrl} target="_blank" rel="noreferrer noopener">
            Open in Jira ↗
          </a>
        )}
      </div>
    </li>
  );
}

function syncLine(s: JiraStatusDto, now: Date | null): string {
  if (s.lastSyncAt === null) return "not synced yet";
  return now ? `synced ${relMinutes(s.lastSyncAt, now)}` : "synced";
}

function SitePicker({
  sites,
  onChoose,
}: {
  sites: JiraStatusDto["sites"];
  onChoose: (id: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const value = picked !== null && sites.some((s) => s.id === picked) ? picked : sites[0]?.id;
  return (
    <p className="syn-jira-sites">
      <select aria-label="Jira site" value={value} onChange={(e) => setPicked(e.target.value)}>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name || s.id}
          </option>
        ))}
      </select>{" "}
      <Button variant="secondary" size="sm" onClick={() => value && onChoose(value)}>
        Use this site
      </Button>
    </p>
  );
}

/** The Jira section (spec B12): grouped issues, last-sync line and a manual sync. */
export function JiraSection({
  status,
  issues,
  now,
  onSync,
  onGoToSetup,
  onCreateTask,
  onChooseSite,
}: {
  status: JiraStatusDto | null;
  issues: JiraIssueView[];
  now: Date | null;
  onSync: () => void;
  onGoToSetup: () => void;
  /** Proposes an engineering task from the issue (Phase 10); the action is hidden without it. */
  onCreateTask?: (key: string) => void;
  /** Saves the chosen Jira site while several are offered; the picker is hidden without it. */
  onChooseSite?: (id: string) => void;
}) {
  const enabled = status?.enabled === true;
  const groups = groupIssues(issues).filter((g) => g.issues.length > 0);
  return (
    <Card>
      <div className="syn-card-head">
        <h2>Jira</h2>
        {status && enabled && (
          <span className="syn-jira-sync">
            <span className="syn-jira-mono">{syncLine(status, now)}</span>
            <Button variant="secondary" size="sm" onClick={onSync}>
              Sync now
            </Button>
          </span>
        )}
      </div>
      {status?.lastError && enabled && (
        <p className="syn-jira-error">
          Last sync problem: {jiraErrorLabel(status.lastError, status.sites.length > 0)}
        </p>
      )}
      {enabled &&
        status?.lastError === "multiple_sites" &&
        status.sites.length > 0 &&
        onChooseSite && <SitePicker sites={status.sites} onChoose={onChooseSite} />}
      {status && !enabled && (
        <p className="syn-jira-faint">
          Jira tracking is off.{" "}
          <Button variant="link" onClick={onGoToSetup}>
            Set up in Needs you →
          </Button>
        </p>
      )}
      {enabled && groups.length === 0 && <p className="syn-jira-faint">No Jira issues in scope.</p>}
      {enabled &&
        groups.map((g) => (
          <section key={g.id} className="syn-jira-group" aria-label={g.label}>
            <h3 className="syn-jira-group-head">
              {g.label} <span>{g.issues.length}</span>
            </h3>
            <ul className="syn-jira-list">
              {g.issues.map((i) => (
                <Row key={i.key} i={i} now={now} onCreateTask={onCreateTask} />
              ))}
            </ul>
          </section>
        ))}
    </Card>
  );
}
