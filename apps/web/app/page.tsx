"use client";

import type { Approval, HealthReport, Job } from "@synapse/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ClaudeRun,
  type ClaudeStatus,
  confirmSlackIdentity,
  decideApproval,
  type FlagReviewStatus,
  type GroupedFlagsDto,
  getApprovals,
  getClaudeRuns,
  getClaudeStatus,
  getHealth,
  getInboxMessages,
  getJobs,
  getPeople,
  getPersonFlags,
  getSecurityFlags,
  getSlackIdentity,
  getSlackStatus,
  getUrgent,
  type InboxMessageDto,
  type PersonDto,
  type PersonPriorityDto,
  reviewFlag,
  type SecurityFlagDto,
  type SlackIdentityDto,
  type SlackStatusDto,
  setPersonPriority,
  setUrgentStatus,
  skipUnreadablePage,
  startBackfill,
  type UrgencyStatusDto,
  type UrgentItemDto,
} from "../lib/api";
import { trailingDebounce } from "../lib/debounce";
import { decideThenRefresh } from "../lib/decide";
import { LIVE_EVENT_TYPES } from "../lib/live-events";
import { ApprovalsList } from "./components/ApprovalsList";
import { ClaudePanel } from "./components/ClaudePanel";
import { HealthBadge } from "./components/HealthBadge";
import { IdentitySetup } from "./components/IdentitySetup";
import { InboxPanel } from "./components/InboxPanel";
import { JobsTable } from "./components/JobsTable";
import { PriorityPeople } from "./components/PriorityPeople";
import { RedFlags } from "./components/RedFlags";
import { SlackStatus } from "./components/SlackStatus";
import { UrgentInbox } from "./components/UrgentInbox";

export default function Dashboard() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [claudeRuns, setClaudeRuns] = useState<ClaudeRun[]>([]);
  const [slackStatus, setSlackStatus] = useState<SlackStatusDto | null>(null);
  const [messages, setMessages] = useState<InboxMessageDto[]>([]);
  const [urgent, setUrgent] = useState<UrgentItemDto[]>([]);
  const [flags, setFlags] = useState<GroupedFlagsDto[]>([]);
  const [people, setPeople] = useState<PersonDto[]>([]);
  const [identity, setIdentity] = useState<SlackIdentityDto | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [history, setHistory] = useState<Record<string, SecurityFlagDto[]>>({});
  const expandedRef = useRef<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [h, a, j, cs, cr, ss, im, ug, sf, pp, id] = await Promise.allSettled([
      getHealth(),
      getApprovals(),
      getJobs(20),
      getClaudeStatus(),
      getClaudeRuns(10),
      getSlackStatus(),
      getInboxMessages(50),
      getUrgent("open"),
      getSecurityFlags(false),
      getPeople(),
      getSlackIdentity(),
    ]);
    if (h.status === "fulfilled") setHealth(h.value);
    else setHealth(null);
    if (a.status === "fulfilled") setApprovals(a.value);
    if (j.status === "fulfilled") setJobs(j.value);
    if (cs.status === "fulfilled") setClaudeStatus(cs.value);
    if (cr.status === "fulfilled") setClaudeRuns(cr.value);
    if (ss.status === "fulfilled") setSlackStatus(ss.value);
    if (im.status === "fulfilled") setMessages(im.value);
    if (ug.status === "fulfilled") setUrgent(ug.value);
    if (sf.status === "fulfilled") setFlags(sf.value);
    if (pp.status === "fulfilled") setPeople(pp.value);
    if (id.status === "fulfilled") setIdentity(id.value);
    // Expanded histories are refetched on every refresh so review changes show at once.
    const open = expandedRef.current;
    const hist = await Promise.allSettled(open.map((u) => getPersonFlags(u)));
    setHistory((prev) => {
      const next = { ...prev };
      hist.forEach((r, i) => {
        if (r.status === "fulfilled") next[open[i] as string] = r.value;
      });
      return next;
    });
    const failed = [h, a, j, cs, cr, ss, im, ug, sf, pp, id].find((r) => r.status === "rejected");
    const message = failed?.status === "rejected" ? String(failed.reason) : null;
    setLoadError(message);
    return message;
  }, []);

  useEffect(() => {
    void refresh();
    // A burst of live events (e.g. one per stored page) triggers one refresh, 500 ms after the last.
    const debounced = trailingDebounce(() => void refresh(), 500);
    const source = new EventSource("/api/stream");
    source.onmessage = () => debounced.call();
    // Events are named (`event: <type>`), so onmessage alone would miss them.
    for (const t of LIVE_EVENT_TYPES) source.addEventListener(t, () => debounced.call());
    return () => {
      debounced.cancel();
      source.close();
    };
  }, [refresh]);

  const decide = async (id: string, decision: "approve" | "reject") => {
    setActionError(null);
    const out = await decideThenRefresh(() => decideApproval(id, decision), refresh);
    setActionError(out.actionError);
  };

  const backfill = async () => {
    setActionError(null);
    try {
      await startBackfill();
    } catch (e) {
      setActionError(String(e));
    }
    await refresh();
  };

  const skipPage = async () => {
    setActionError(null);
    try {
      await skipUnreadablePage();
    } catch (e) {
      setActionError(String(e));
    }
    await refresh();
  };

  const toggleHistory = (u: string) => {
    const next = expandedRef.current.includes(u)
      ? expandedRef.current.filter((x) => x !== u)
      : [...expandedRef.current, u];
    expandedRef.current = next;
    setExpanded(next);
    void refresh();
  };

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(String(e));
    }
    await refresh();
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
      <IdentitySetup
        identity={identity}
        people={people}
        onConfirm={(u) => void act(() => confirmSlackIdentity(u))}
      />
      <h2>Urgent</h2>
      <UrgentInbox
        items={urgent}
        onStatus={(id: string, s: UrgencyStatusDto) => void act(() => setUrgentStatus(id, s))}
      />
      <h2>Red flags</h2>
      <RedFlags
        groups={flags}
        expanded={expanded}
        history={history}
        onToggle={toggleHistory}
        onReview={(id: string, s: FlagReviewStatus) => void act(() => reviewFlag(id, s))}
      />
      <h2>Priority people</h2>
      <PriorityPeople
        people={people}
        onChange={(p: PersonDto, priority: PersonPriorityDto, extraAttention: boolean) =>
          void act(() =>
            setPersonPriority(p.slackUserId, {
              priority,
              rationale: p.rationale ?? "",
              extraAttention,
            }),
          )
        }
      />
      <h2>Pending approvals</h2>
      <ApprovalsList approvals={approvals} onDecide={decide} />
      <h2>Latest jobs</h2>
      <JobsTable jobs={jobs} />
      <h2>Claude</h2>
      <ClaudePanel status={claudeStatus} runs={claudeRuns} />
      <h2>Slack</h2>
      <SlackStatus
        status={slackStatus}
        onBackfill={() => void backfill()}
        onSkip={() => void skipPage()}
      />
      <h2>Inbox</h2>
      <InboxPanel messages={messages} />
    </main>
  );
}
