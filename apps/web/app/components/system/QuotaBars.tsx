import type { ClaudeQuotaWindow, ClaudeStatus } from "../../../lib/api";

const LEVEL_TEXT: Record<NonNullable<ClaudeStatus["quota"]>["level"], string> = {
  ok: "ok · jobs allowed",
  soft: "soft · non-urgent jobs paused",
  hard: "hard · only urgent jobs allowed",
  stop: "stop · all jobs paused",
};

const pct = (fraction: number) => Math.round(fraction * 100);

function Bar({
  label,
  window,
  soft,
}: {
  label: string;
  window: ClaudeQuotaWindow | undefined;
  soft: number;
}) {
  const used = window ? Math.min(100, Math.max(0, pct(window.utilization))) : 0;
  return (
    <div className="syn-quota-row">
      <span className="syn-quota-label">{label}</span>
      <div className="syn-quota-track">
        <div className="syn-quota-fill" style={{ width: `${used}%` }} />
        <span
          className="syn-quota-marker"
          style={{ left: `${pct(soft)}%` }}
          title="Non-urgent jobs pause above this"
        />
      </div>
      <span className="syn-quota-pct">{window ? `${used}%` : "-"}</span>
    </div>
  );
}

/** Quota levels are 0–1 fractions; the marker sits at the soft threshold. */
export function QuotaBars({ status }: { status: ClaudeStatus | null }) {
  const quota = status?.quota ?? null;
  return (
    <div className="syn-quota">
      <div className="syn-quota-head">
        <span className="syn-quota-title">Claude quota</span>
        {quota && <span className="syn-quota-level">{LEVEL_TEXT[quota.level]}</span>}
      </div>
      {quota && status ? (
        <>
          <Bar
            label="Five-hour window"
            window={quota.fiveHour}
            soft={status.thresholds.fiveHour.soft}
          />
          <Bar
            label="Seven-day window"
            window={quota.sevenDay}
            soft={status.thresholds.sevenDay.soft}
          />
          <p className="syn-quota-caption">
            Marker = pause threshold for non-urgent jobs, keeping headroom for your own Claude Code
            work.
          </p>
        </>
      ) : (
        <p className="syn-quota-caption">No quota reading yet.</p>
      )}
    </div>
  );
}
