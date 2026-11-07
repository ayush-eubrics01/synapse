"use client";

import type { DashboardSectionId } from "@synapse/contracts";
import type { ReactNode } from "react";

export interface DashboardSectionProps {
  id: DashboardSectionId;
  label: string;
  count?: number;
  hot?: boolean;
  width: "full" | "half";
  collapsed: boolean;
  customising: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** False for Needs you, which can't be hidden. */
  canHide: boolean;
  onMove: (delta: -1 | 1) => void;
  onHide: () => void;
  /** The wanted state: the toolbar toggles it (saved); a collapsed header asks for `false`. */
  onCollapse: (collapsed: boolean) => void;
  onWidth: (width: "full" | "half") => void;
  /** A layout call is running: the toolbar waits. */
  busy?: boolean;
  children: ReactNode;
}

/** One dashboard section; customise mode adds a button toolbar (no drag-only controls). */
export function DashboardSection({
  id,
  label,
  count,
  hot,
  width,
  collapsed,
  customising,
  isFirst,
  isLast,
  canHide,
  onMove,
  onHide,
  onCollapse,
  onWidth,
  busy = false,
  children,
}: DashboardSectionProps) {
  const cls = `syn-section${collapsed ? " is-collapsed" : ""}${customising ? " is-customising" : ""}`;
  return (
    <section id={id} className={cls} data-width={width}>
      {customising && (
        <div
          className="syn-section-toolbar"
          role="toolbar"
          tabIndex={-1}
          aria-label={`${label} layout`}
        >
          <span className="syn-section-toolbar-label">{label}</span>
          <button
            type="button"
            className="syn-btn syn-btn--ghost syn-btn--sm"
            disabled={busy || isFirst}
            onClick={() => onMove(-1)}
          >
            Move up
          </button>
          <button
            type="button"
            className="syn-btn syn-btn--ghost syn-btn--sm"
            disabled={busy || isLast}
            onClick={() => onMove(1)}
          >
            Move down
          </button>
          {canHide && (
            <button
              type="button"
              className="syn-btn syn-btn--ghost syn-btn--sm"
              disabled={busy}
              onClick={onHide}
            >
              Hide
            </button>
          )}
          {canHide && (
            <button
              type="button"
              className="syn-btn syn-btn--ghost syn-btn--sm"
              disabled={busy}
              onClick={() => onCollapse(!collapsed)}
            >
              {collapsed ? "Expand" : "Collapse"}
            </button>
          )}
          <button
            type="button"
            className="syn-btn syn-btn--ghost syn-btn--sm"
            disabled={busy}
            onClick={() => onWidth(width === "half" ? "full" : "half")}
          >
            {width === "half" ? "Full width" : "Half width"}
          </button>
        </div>
      )}
      {collapsed ? (
        <button
          type="button"
          className="syn-section-collapsed-head"
          aria-expanded="false"
          onClick={() => onCollapse(false)}
        >
          <span>{label}</span>
          {count ? <span className={`syn-badge${hot ? " is-hot" : ""}`}>{count}</span> : null}
        </button>
      ) : (
        <div>{children}</div>
      )}
    </section>
  );
}
