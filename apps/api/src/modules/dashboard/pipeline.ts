import type { DashboardOverview } from "@synapse/contracts";

export interface PipelineInput {
  slack: {
    lastSuccessAt: string | null;
    error: boolean;
    stalled: boolean;
    searchesToday: number;
  };
  rulesOk: boolean;
  openRedFlags: number;
  assess: { duePending: number; running: number; failedRecent: number };
  openUrgent: number;
  pendingApprovals: number;
}

type Stages = DashboardOverview["pipeline"];

/** Collection is late after this long without a successful incremental run. */
const COLLECT_LATE_MS = 25 * 60_000;

/** The four pipeline stages, in order. Pure: all inputs are gathered by the caller. */
export function pipelineStages(input: PipelineInput, now: Date): Stages {
  const { slack, assess } = input;
  const lastMs = slack.lastSuccessAt === null ? null : Date.parse(slack.lastSuccessAt);
  const ageMs = lastMs === null || Number.isNaN(lastMs) ? null : now.getTime() - lastMs;
  const searches = `${slack.searchesToday} searches today`;
  const collect: Stages[number] = {
    id: "collect",
    label: "Collect",
    what: "Reads new Slack messages through the Claude connector",
    state:
      slack.error || slack.stalled
        ? "failing"
        : ageMs === null || ageMs > COLLECT_LATE_MS
          ? "waiting"
          : "ok",
    summary:
      ageMs === null
        ? `not collected yet · ${searches}`
        : `${Math.max(0, Math.floor(ageMs / 60_000))} min ago · ${searches}`,
  };

  const screen: Stages[number] = {
    id: "screen",
    label: "Screen",
    what: "Checks every message against local rules for urgency and prompt injection",
    state: input.rulesOk ? "ok" : "failing",
    summary: `${input.openRedFlags} red flags open`,
  };

  const waiting = assess.duePending + assess.running;
  const assessStage: Stages[number] = {
    id: "assess",
    label: "Assess",
    what: "Claude rates how urgent the screened messages are",
    state: assess.failedRecent > 0 ? "failing" : waiting > 0 ? "waiting" : "ok",
    summary:
      waiting > 0
        ? `${waiting} waiting`
        : assess.failedRecent > 0
          ? `${assess.failedRecent} failed in the last 24 h`
          : "up to date",
  };

  const surface: Stages[number] = {
    id: "surface",
    label: "Surface",
    what: "Puts what needs you in the Needs you feed",
    state: input.openUrgent > 0 || input.pendingApprovals > 0 ? "ok" : "idle",
    summary: `${input.openUrgent} urgent · ${input.pendingApprovals} approvals`,
  };

  return [collect, screen, assessStage, surface];
}
