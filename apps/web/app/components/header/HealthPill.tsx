"use client";

import type { DashboardOverview } from "@synapse/contracts";
import { useEffect, useRef } from "react";
import type { OverviewFailure } from "../../../lib/api";

type Health = DashboardOverview["health"];

const WORD = { ok: "Healthy", degraded: "Degraded", down: "Down" } as const;

export function healthLabel(h: Health): string {
  const n = h.issues.length;
  if (h.status === "ok") return WORD.ok;
  return `${WORD[h.status]} · ${n} ${n === 1 ? "check" : "checks"}`;
}

export interface HealthPillProps {
  /** Last loaded health; null before the first overview arrives. */
  health: Health | null;
  /**
   * Why the latest overview fetch failed: `network` means the API can't be reached; `http` means
   * it answered with an error. Either way `health` is stale, so it isn't shown.
   */
  failure: OverviewFailure | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Status pill that toggles a popover explaining the failing checks. Esc and outside click close it. */
export function HealthPill({ health, failure, open, onOpenChange }: HealthPillProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
        buttonRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onOpenChange]);

  const unreachable = failure?.kind === "network";
  const tone = unreachable ? "down" : failure ? "degraded" : (health?.status ?? "checking");
  const label = unreachable
    ? "Unreachable"
    : failure?.kind === "unexpected"
      ? "Unexpected response"
      : failure
        ? "Overview unavailable"
        : health
          ? healthLabel(health)
          : "Checking…";
  const first = health?.issues.find((i) => i.hint);
  return (
    <div className="syn-health" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`syn-health-pill syn-health-pill--${tone}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
      >
        <span
          className={`syn-dot syn-dot--${tone}${tone === "degraded" ? " syn-pulse" : ""}`}
          aria-hidden="true"
        />
        {label}
      </button>
      {open && (
        <section className="syn-health-pop syn-in" aria-label="System health">
          <h2 className="syn-health-pop-title">
            {unreachable
              ? "Can't reach Synapse"
              : failure
                ? "Overview unavailable"
                : !health || health.status === "ok"
                  ? "System health"
                  : `Why “${WORD[health.status].toLowerCase()}”?`}
          </h2>
          {unreachable ? (
            <p className="syn-health-pop-text">
              The Synapse API is not responding. What you see may be out of date. Check that the API
              service is running.
            </p>
          ) : failure?.kind === "unexpected" ? (
            <p className="syn-health-pop-text">
              The API answered, but the response could not be read. Check the API logs.
            </p>
          ) : failure ? (
            <p className="syn-health-pop-text">
              {`The API answered with an error (${failure.status}). Check the API logs.`}
            </p>
          ) : !health ? (
            <p className="syn-health-pop-text">Checking the Synapse API…</p>
          ) : health.issues.length === 0 ? (
            <p className="syn-health-pop-text">All checks are passing.</p>
          ) : (
            <>
              <p className="syn-health-pop-text">
                Synapse keeps working, but these checks need a look.
              </p>
              <ul className="syn-health-rows">
                {health.issues.map((i) => (
                  <li key={i.check} className="syn-health-row">
                    <span className={`syn-dot syn-dot--${i.status}`} aria-hidden="true" />
                    <span className="syn-health-row-label">{i.label}</span>
                    {i.detail && <span className="syn-health-row-detail">{i.detail}</span>}
                  </li>
                ))}
              </ul>
              {first?.hint && <p className="syn-health-fix">{`Most likely fix: ${first.hint}`}</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}
