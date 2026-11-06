"use client";

import type { DashboardOverview } from "@synapse/contracts";
import { useEffect, useRef } from "react";

type Health = DashboardOverview["health"];

const WORD = { ok: "Healthy", degraded: "Degraded", down: "Down" } as const;

export function healthLabel(h: Health): string {
  const n = h.issues.length;
  if (h.status === "ok") return WORD.ok;
  return `${WORD[h.status]} · ${n} ${n === 1 ? "check" : "checks"}`;
}

export interface HealthPillProps {
  health: Health;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Status pill that toggles a popover explaining the failing checks. Esc and outside click close it. */
export function HealthPill({ health, open, onOpenChange }: HealthPillProps) {
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

  const first = health.issues.find((i) => i.hint);
  const word = WORD[health.status].toLowerCase();
  return (
    <div className="syn-health" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`syn-health-pill syn-health-pill--${health.status}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => onOpenChange(!open)}
      >
        <span
          className={`syn-dot syn-dot--${health.status}${health.status === "degraded" ? " syn-pulse" : ""}`}
          aria-hidden="true"
        />
        {healthLabel(health)}
      </button>
      {open && (
        <section className="syn-health-pop syn-in" aria-label="System health">
          <h2 className="syn-health-pop-title">
            {health.status === "ok" ? "System health" : `Why “${word}”?`}
          </h2>
          {health.issues.length === 0 ? (
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
