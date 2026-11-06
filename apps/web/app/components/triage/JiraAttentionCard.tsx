"use client";

import type { JiraIssueView } from "@synapse/contracts";
import { attentionLabel } from "../../../lib/jira";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Actions, CardFrame } from "./CardFrame";

const SHOWN = 5;

/** One card for every Jira issue that needs attention; the first few, then a link to the section. */
export function JiraAttentionCard({
  issues,
  now,
  onSeeAll,
}: {
  issues: JiraIssueView[];
  now: Date | null;
  onSeeAll: () => void;
}) {
  const n = issues.length;
  const more = n - SHOWN;
  return (
    <CardFrame
      tag="JIRA · ATTENTION"
      tone="amber"
      title={`${n} Jira ${n === 1 ? "issue needs" : "issues need"} attention`}
    >
      <ul className="syn-jira-mini">
        {issues.slice(0, SHOWN).map((i) => (
          <li key={i.key} className="syn-jira-mini-row">
            <span className="syn-jira-key">{i.key}</span>
            <span className="syn-jira-summary">{i.summary}</span>
            <Chip tone={i.attention === "overdue" || i.attention === "blocked" ? "red" : "amber"}>
              {attentionLabel(i, now)}
            </Chip>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="syn-ncard-faint">+{more} more</p>}
      <Actions>
        <Button variant="link" onClick={onSeeAll}>
          See all in Jira →
        </Button>
      </Actions>
    </CardFrame>
  );
}
