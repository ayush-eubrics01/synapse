"use client";

import type { Approval, HealthReport, Job } from "@synapse/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  type ClaudeRun,
  type ClaudeStatus,
  decideApproval,
  getApprovals,
  getClaudeRuns,
  getClaudeStatus,
  getHealth,
  getJobs,
} from "../lib/api";
import { decideThenRefresh } from "../lib/decide";
import { LIVE_EVENT_TYPES } from "../lib/live-events";
import { ApprovalsList } from "./components/ApprovalsList";
import { ClaudePanel } from "./components/ClaudePanel";
import { HealthBadge } from "./components/HealthBadge";
import { JobsTable } from "./components/JobsTable";

export default function Dashboard() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [claudeRuns, setClaudeRuns] = useState<ClaudeRun[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [h, a, j, cs, cr] = await Promise.allSettled([
      getHealth(),
      getApprovals(),
      getJobs(20),
      getClaudeStatus(),
      getClaudeRuns(10),
    ]);
    if (h.status === "fulfilled") setHealth(h.value);
    else setHealth(null);
    if (a.status === "fulfilled") setApprovals(a.value);
    if (j.status === "fulfilled") setJobs(j.value);
    if (cs.status === "fulfilled") setClaudeStatus(cs.value);
    if (cr.status === "fulfilled") setClaudeRuns(cr.value);
    const failed = [h, a, j, cs, cr].find((r) => r.status === "rejected");
    const message = failed?.status === "rejected" ? String(failed.reason) : null;
    setLoadError(message);
    return message;
  }, []);

  useEffect(() => {
    void refresh();
    const source = new EventSource("/api/stream");
    source.onmessage = () => void refresh();
    // Events are named (`event: <type>`), so onmessage alone would miss them.
    for (const t of LIVE_EVENT_TYPES) source.addEventListener(t, () => void refresh());
    return () => source.close();
  }, [refresh]);

  const decide = async (id: string, decision: "approve" | "reject") => {
    setActionError(null);
    const out = await decideThenRefresh(() => decideApproval(id, decision), refresh);
    setActionError(out.actionError);
  };

  return (
    <main>
      <h1>
        Synapse <HealthBadge health={health} />
      </h1>
      {loadError && <p style={{ color: "#c33" }}>{loadError}</p>}
      {actionError && (
        <p style={{ color: "#c33" }}>
          {actionError}{" "}
          <button type="button" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </p>
      )}
      <h2>Pending approvals</h2>
      <ApprovalsList approvals={approvals} onDecide={decide} />
      <h2>Latest jobs</h2>
      <JobsTable jobs={jobs} />
      <h2>Claude</h2>
      <ClaudePanel status={claudeStatus} runs={claudeRuns} />
    </main>
  );
}
