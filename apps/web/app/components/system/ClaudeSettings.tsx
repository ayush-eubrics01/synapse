"use client";

import type { ClaudeSettingsDto, ClaudeSettingsKey } from "../../../lib/api";
import { Card } from "../ui/Card";
import { Switch } from "../ui/Switch";

export const AUTO_SEND_RISK =
  "Residual risk: with auto-send on, a repository secret that does not match a secret pattern could be sent to a priority person.";

export const SANDBOX_HINT =
  "Develop runs execute the repository's tests with no network and writes only inside the repository. Turning this off disables develop runs; tests never run outside the sandbox.";

const TOGGLES: {
  key: ClaudeSettingsKey & keyof ClaudeSettingsDto;
  label: string;
  hint?: string;
}[] = [
  { key: "claudeActivity.enabled", label: "Watch Claude Code sessions" },
  { key: "claudeActivity.yieldWhenActive", label: "Pause background analysis while I work" },
  { key: "claudeActivity.yieldEngineering", label: "Also pause engineering tasks" },
  { key: "engineering.sandbox.enabled", label: "Run tests in a sandbox", hint: SANDBOX_HINT },
  { key: "codeAnswer.away.enabled", label: "Answer code questions while away" },
  {
    key: "codeAnswer.away.autoSend",
    label: "Auto-send code answers while away",
    hint: AUTO_SEND_RISK,
  },
];

const NUMBERS: { key: ClaudeSettingsKey; label: string; min: number; max: number }[] = [
  { key: "claudeActivity.activeWindowMinutes", label: "Active window (minutes)", min: 1, max: 120 },
  { key: "claudeActivity.staleBranchDays", label: "Stale branch (days)", min: 1, max: 60 },
  { key: "claudeActivity.openPrReminderDays", label: "Open PR reminder (days)", min: 1, max: 60 },
  { key: "codeAnswer.maxTurns", label: "Code answer max turns", min: 1, max: 30 },
  { key: "codeAnswer.timeoutMinutes", label: "Code answer timeout (minutes)", min: 1, max: 30 },
  { key: "codeAnswer.away.maxRunsPerDay", label: "Away code answers per day", min: 0, max: 100 },
];

/** Claude Code and code-answer settings. Values come from `GET /api/settings`; validation is the API's. */
export function ClaudeSettings({
  values,
  onChange,
}: {
  values: ClaudeSettingsDto | null;
  onChange: (key: ClaudeSettingsKey, value: boolean | number | string) => void;
}) {
  return (
    <Card className="syn-claude-settings">
      <div className="syn-card-head">
        <h3>Claude Code settings</h3>
      </div>
      {values === null ? (
        <p className="syn-empty">Settings unavailable.</p>
      ) : (
        <>
          {TOGGLES.map((t) => (
            <div key={t.key} className="syn-kv">
              <Switch
                checked={values[t.key] as boolean}
                onChange={(next) => onChange(t.key, next)}
                label={t.label}
                hint={t.hint}
              />
            </div>
          ))}
          <div className="syn-kv">
            <label htmlFor="syn-code-answer-model" className="syn-kv-label">
              Code answer model
            </label>
            <select
              id="syn-code-answer-model"
              value={values["codeAnswer.model"]}
              onChange={(e) => onChange("codeAnswer.model", e.target.value)}
            >
              <option value="haiku">haiku</option>
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
            </select>
          </div>
          {NUMBERS.map((n) => (
            <div key={n.key} className="syn-kv">
              <label htmlFor={`syn-set-${n.key}`} className="syn-kv-label">
                {n.label}
              </label>
              <input
                key={String(values[n.key])}
                id={`syn-set-${n.key}`}
                type="number"
                min={n.min}
                max={n.max}
                defaultValue={values[n.key] as number}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (e.target.value !== "" && v !== values[n.key]) onChange(n.key, v);
                }}
              />
            </div>
          ))}
        </>
      )}
    </Card>
  );
}
