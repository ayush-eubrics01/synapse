"use client";

import type { DashboardOverview } from "@synapse/contracts";
import { useEffect, useState } from "react";
import { briefing } from "../../../lib/briefing";
import { dateLine, greeting } from "../../../lib/format";
import { Switch } from "../ui/Switch";
import { HealthPill } from "./HealthPill";

export const AWAY_HINT = "Away mode isn't available yet. Until it is, every reply waits for you.";

export interface HeaderProps {
  overview: DashboardOverview | null;
  /** The latest overview fetch failed; `overview` (if any) is the last good one. */
  unreachable: boolean;
  /** The browser clock; null until mounted so server and client markup match. */
  now: Date | null;
  onOpenPalette: () => void;
  backfillStarted: boolean;
  /** Increment to open the health popover from outside (palette action). */
  openHealthSignal?: number;
  /** Tests only: render the popover open. */
  initiallyOpen?: boolean;
}

export function Header({
  overview,
  unreachable,
  now,
  onOpenPalette,
  backfillStarted,
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
        {unreachable
          ? overview
            ? "Can't reach the Synapse API. Showing the last data loaded."
            : "Can't reach the Synapse API."
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
          <Switch checked={false} onChange={() => {}} label="Away mode" disabled hint={AWAY_HINT} />
        </span>
        <HealthPill
          health={overview?.health ?? null}
          unreachable={unreachable}
          open={healthOpen}
          onOpenChange={setHealthOpen}
        />
      </div>
    </header>
  );
}
