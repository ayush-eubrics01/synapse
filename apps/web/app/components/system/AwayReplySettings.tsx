"use client";

import type { AutoReplyKind, AwayReplySettingsDto } from "../../../lib/api";
import { Card } from "../ui/Card";

const KINDS: { kind: AutoReplyKind; label: string }[] = [
  { kind: "code_answer", label: "Code answers" },
  { kind: "stalled_reminder", label: "Stalled reminders" },
  { kind: "followup_question", label: "Follow-up questions" },
  { kind: "acknowledgement", label: "Acknowledgements" },
];

type NumberKey = Exclude<keyof AwayReplySettingsDto, "autoReply.allowedKinds">;

const NUMBERS: { key: NumberKey; label: string; min: number; max: number; step?: number }[] = [
  { key: "autoReply.maxPerPersonPerDay", label: "Max replies per person per day", min: 0, max: 3 },
  {
    key: "autoReply.minMinutesBetweenInThread",
    label: "Min minutes between replies in a thread",
    min: 30,
    max: 1440,
  },
  { key: "autoReply.minConfidence", label: "Min confidence", min: 0.75, max: 1, step: 0.05 },
  { key: "autoReply.maxSendDelayMinutes", label: "Max send delay (minutes)", min: 1, max: 15 },
];

export const AWAY_REPLY_HINT =
  "These limits can only be made stricter than the built-in away-reply rules. 0 replies per day turns automatic replies off; code answers still wait for your approval.";

/** Away-mode auto-reply limits (ADR-033). Validation is the API's. */
export function AwayReplySettings({
  values,
  onChange,
}: {
  values: AwayReplySettingsDto | null;
  onChange: (key: keyof AwayReplySettingsDto, value: number | AutoReplyKind[]) => void;
}) {
  return (
    <Card className="syn-away-settings">
      <div className="syn-card-head">
        <h3>Away replies</h3>
      </div>
      {values === null ? (
        <p className="syn-empty">Settings unavailable.</p>
      ) : (
        <>
          {KINDS.map((k) => {
            const current = values["autoReply.allowedKinds"];
            const checked = current.includes(k.kind);
            return (
              <div key={k.kind} className="syn-kv">
                <label htmlFor={`syn-away-kind-${k.kind}`} className="syn-kv-label">
                  {k.label}
                </label>
                <input
                  id={`syn-away-kind-${k.kind}`}
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange(
                      "autoReply.allowedKinds",
                      KINDS.map((x) => x.kind).filter((x) =>
                        x === k.kind ? !checked : current.includes(x),
                      ),
                    )
                  }
                />
              </div>
            );
          })}
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
                step={n.step}
                defaultValue={values[n.key]}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (e.target.value !== "" && v !== values[n.key]) onChange(n.key, v);
                }}
              />
            </div>
          ))}
          <p className="syn-empty">{AWAY_REPLY_HINT}</p>
        </>
      )}
    </Card>
  );
}
