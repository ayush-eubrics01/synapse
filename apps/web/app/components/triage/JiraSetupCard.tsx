"use client";

import { useState } from "react";
import { validateJiraSetup } from "../../../lib/jira";
import { Button } from "../ui/Button";
import { Actions, CardFrame, Explainer } from "./CardFrame";

/**
 * Shown while Jira tracking is off, prefilled with the stored scope and exclusions (from the
 * status). Enabling saves them, then syncs.
 */
export function JiraSetupCard({
  scopeJql,
  excludedProjects,
  onEnable,
}: {
  scopeJql: string;
  excludedProjects: string[];
  onEnable: (setup: { scopeJql: string; excludedProjects: string[] }) => void;
}) {
  const [scope, setScope] = useState(scopeJql);
  const [excluded, setExcluded] = useState(excludedProjects.join(", "));
  const [errors, setErrors] = useState<{ scope: string | null; excluded: string | null }>({
    scope: null,
    excluded: null,
  });
  const enable = () => {
    const r = validateJiraSetup(scope, excluded);
    if (!r.ok) {
      setErrors({ scope: r.scopeError, excluded: r.excludedError });
      return;
    }
    setErrors({ scope: null, excluded: null });
    onEnable({ scopeJql: r.scopeJql, excludedProjects: r.excludedProjects });
  };
  return (
    <CardFrame tag="JIRA · SETUP" tone="neutral" title="Track your Jira issues">
      <Explainer>Track the Jira issues assigned to you.</Explainer>
      <label className="syn-jira-field">
        <span className="syn-ncard-faint">Scope (JQL, no ORDER BY)</span>
        <textarea
          className="syn-ncard-textarea"
          rows={2}
          value={scope}
          aria-invalid={errors.scope !== null}
          onChange={(e) => setScope(e.target.value)}
        />
      </label>
      {errors.scope && (
        <p role="alert" className="syn-jira-error">
          {errors.scope}
        </p>
      )}
      <label className="syn-jira-field">
        <span className="syn-ncard-faint">Excluded projects (comma-separated keys)</span>
        <input
          className="syn-ncard-textarea"
          aria-label="Excluded projects"
          value={excluded}
          placeholder="e.g. OPS, SUPPORT"
          aria-invalid={errors.excluded !== null}
          onChange={(e) => setExcluded(e.target.value)}
        />
      </label>
      {errors.excluded && (
        <p role="alert" className="syn-jira-error">
          {errors.excluded}
        </p>
      )}
      <Actions>
        <Button variant="primary" onClick={enable}>
          Enable
        </Button>
      </Actions>
    </CardFrame>
  );
}
