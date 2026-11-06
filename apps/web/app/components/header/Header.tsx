"use client";

import type { DashboardOverview } from "@synapse/contracts";
import { useEffect, useState } from "react";
import type { OverviewFailure } from "../../../lib/api";
import { briefing } from "../../../lib/briefing";
import { dateLine, greeting } from "../../../lib/format";
import { Switch } from "../ui/Switch";
import { HealthPill } from "./HealthPill";

export interface HeaderProps {
  overview: DashboardOverview | null;
  /** Why the latest overview fetch failed, or null; `overview` (if any) is the last good one. */
  failure: OverviewFailure | null;
  /** The browser clock; null until mounted so server and client markup match. */
  now: Date | null;
  onOpenPalette: () => void;
  /** Turns away mode on or off; the switch shows the server state, so it only moves after a refresh. */
  onToggleAway: (on: boolean) => void;
  backfillStarted: boolean;
  /** Customise mode is on (spec D5). */
  customising: boolean;
  onToggleCustomise: () => void;
  /** Increment to open the health popover from outside (palette action). */
  openHealthSignal?: number;
  /** Tests only: render the popover open. */
  initiallyOpen?: boolean;
}

export function Header({
  overview,
  failure,
  now,
  onOpenPalette,
  onToggleAway,
  backfillStarted,
  customising,
  onToggleCustomise,
  openHealthSignal = 0,
  initiallyOpen = false,
}: HeaderProps) {
  const [healthOpen, setHealthOpen] = useState(initiallyOpen);
  useEffect(() => {
    if (openHealthSignal > 0) setHealthOpen(true);
  }, [openHealthSignal]);

  return (
    <header className="syn-header">
      <div className="syn-header-date" suppressHydrationWarning>
        {now ? dateLine(now) : " "}
      </div>
      <h1 className="syn-header-greeting">
        {now ? greeting(now, overview?.self.name ?? null) : "Synapse"}
      </h1>
      <p className="syn-header-briefing">
        {failure?.kind === "network"
          ? overview
            ? "Can't reach the Synapse API. Showing the last data loaded."
            : "Can't reach the Synapse API."
          : failure?.kind === "http"
            ? overview
              ? "Couldn't refresh the overview. Showing the last data loaded."
              : "Couldn't load the overview."
            : now && overview
              ? briefing(overview, now, { backfillStarted })
              : " "}
      </p>
      <div className="syn-header-row">
        <button type="button" className="syn-search" onClick={onOpenPalette}>
          <span>Search or jump to…</span>
          <kbd>⌘K</kbd>
        </button>
        <span className="syn-away">
          <Switch
            checked={overview?.away.on ?? false}
            onChange={onToggleAway}
            label="Away mode"
            disabled={overview === null}
          />
        </span>
        <button
          type="button"
          className="syn-btn syn-btn--secondary syn-btn--md"
          aria-pressed={customising}
          onClick={onToggleCustomise}
        >
          {customising ? "Done" : "Customise"}
        </button>
        <HealthPill
          health={overview?.health ?? null}
          failure={failure}
          open={healthOpen}
          onOpenChange={setHealthOpen}
        />
      </div>
    </header>
  );
}
