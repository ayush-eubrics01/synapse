"use client";

import type {
  ApprovalView,
  CandidatesResponse,
  CommitmentFilter,
  DashboardOverview,
  HealthReport,
  Job,
  PersonDetail,
  RecommendationView,
} from "@synapse/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptSuggestion,
  type ClaudeRun,
  type ClaudeStatus,
  type CommitmentEditsDto,
  type CommitmentStatusDto,
  type CommitmentViewDto,
  confirmSlackIdentity,
  decideApproval,
  decideProposal,
  discardFollowup,
  discardRecommendation,
  dismissSuggestion,
  draftFollowup,
  evaluatePerson,
  type FlagReviewStatus,
  type FollowupViewDto,
  type GroupedFlagsDto,
  getApprovals,
  getCandidates,
  getClaudeRuns,
  getClaudeStatus,
  getCommitments,
  getFollowups,
  getHealth,
  getInboxMessages,
  getJobs,
  getOverview,
  getPeople,
  getPersonFlags,
  getPersonProfile,
  getRecommendations,
  getSecurityFlags,
  getSlackIdentity,
  getSlackStatus,
  getUrgent,
  type InboxMessageDto,
  type PersonDto,
  type PersonPriorityDto,
  type ResolveDecisionDto,
  requestUrgentReply,
  resolveOutgoing,
  retryApply,
  reviewCommitment,
  reviewFlag,
  type SecurityFlagDto,
  type SlackIdentityDto,
  type SlackStatusDto,
  sendFollowup,
  setCommitmentStatus,
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
import { SECTION_IDS, type SectionId, sidebarItems } from "../lib/nav";
import type { Decision } from "../lib/people-decision";
import { ApprovalsList } from "./components/ApprovalsList";
import { ClaudePanel } from "./components/ClaudePanel";
import { CommitmentsPanel } from "./components/CommitmentsPanel";
import { FollowupDrafts } from "./components/FollowupDrafts";
import { HealthBadge } from "./components/HealthBadge";
import { IdentitySetup } from "./components/IdentitySetup";
import { InboxPanel } from "./components/InboxPanel";
import { JobsTable } from "./components/JobsTable";
import { PeopleCandidates } from "./components/PeopleCandidates";
import { PersonProfile } from "./components/PersonProfile";
import { PriorityPeople } from "./components/PriorityPeople";
import { ProfileRecommendations } from "./components/ProfileRecommendations";
import { RedFlags } from "./components/RedFlags";
import { SlackStatus } from "./components/SlackStatus";
import { Sidebar } from "./components/shell/Sidebar";
import { UrgentInbox } from "./components/UrgentInbox";

const FOOTER = { api: "127.0.0.1:7400", web: ":7401", lock: "not in use yet" };

/** Highlights the section in view (spec D1): the first one crossing the top 40% of the viewport. */
function useActiveSection(initial: SectionId): [SectionId, (id: SectionId) => void] {
  const [active, setActive] = useState<SectionId>(initial);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = SECTION_IDS.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: "0px 0px -60% 0px" },
    );
    for (const id of SECTION_IDS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  return [active, setActive];
}

function scrollToSection(id: SectionId) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

export default function Dashboard() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [active, setActive] = useActiveSection("overview");
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [claudeRuns, setClaudeRuns] = useState<ClaudeRun[]>([]);
  const [slackStatus, setSlackStatus] = useState<SlackStatusDto | null>(null);
  const [messages, setMessages] = useState<InboxMessageDto[]>([]);
  const [urgent, setUrgent] = useState<UrgentItemDto[]>([]);
  const [flags, setFlags] = useState<GroupedFlagsDto[]>([]);
  const [people, setPeople] = useState<PersonDto[]>([]);
  const [candidates, setCandidates] = useState<CandidatesResponse | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationView[]>([]);
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const personRef = useRef<string | null>(null);
  const [identity, setIdentity] = useState<SlackIdentityDto | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [history, setHistory] = useState<Record<string, SecurityFlagDto[]>>({});
  const expandedRef = useRef<string[]>([]);
  const [commitmentFilter, setCommitmentFilter] = useState<CommitmentFilter>("all");
  const commitmentFilterRef = useRef<CommitmentFilter>("all");
  const [commitments, setCommitments] = useState<CommitmentViewDto[]>([]);
  const [reviewQueue, setReviewQueue] = useState<CommitmentViewDto[]>([]);
  const [followups, setFollowups] = useState<FollowupViewDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const openUser = personRef.current;
    const [h, a, j, cs, cr, ss, im, ug, sf, pp, id, cd, rc, cm, rq, fu, ov, pd] =
      await Promise.allSettled([
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
        getCandidates(50),
        getRecommendations(),
        getCommitments(commitmentFilterRef.current),
        getCommitments("review"),
        getFollowups(),
        getOverview(),
        openUser ? getPersonProfile(openUser) : Promise.resolve(null),
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
    if (cd.status === "fulfilled") setCandidates(cd.value);
    if (rc.status === "fulfilled") setRecommendations(rc.value);
    if (cm.status === "fulfilled") setCommitments(cm.value);
    if (rq.status === "fulfilled") setReviewQueue(rq.value);
    if (fu.status === "fulfilled") setFollowups(fu.value);
    if (ov.status === "fulfilled") setOverview(ov.value);
    // The open profile is refetched with everything else; if that fails, the stale profile closes.
    if (openUser && personRef.current === openUser) {
      if (pd.status === "fulfilled") setPerson(pd.value);
      else {
        personRef.current = null;
        setPerson(null);
      }
    }
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
    const failed = [h, a, j, cs, cr, ss, im, ug, sf, pp, id, cd, rc, cm, rq, fu, ov].find(
      (r) => r.status === "rejected",
    );
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

  const decide = async (id: string, decision: "approve" | "reject", reason?: string) => {
    setActionError(null);
    const out = await decideThenRefresh(() => decideApproval(id, decision, reason), refresh);
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

  const openPerson = (slackUserId: string | null) => {
    personRef.current = slackUserId;
    if (slackUserId === null) setPerson(null);
    void refresh();
  };

  // A refusal (no identity, already queued) is a normal result; show it as a notice.
  const evaluate = (fn: () => Promise<{ queued: boolean; reason?: string }>) =>
    act(async () => {
      const r = await fn();
      if (!r.queued) throw new Error(`Not queued: ${r.reason ?? "unknown reason"}`);
    });

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
    <div className="syn-app">
      <Sidebar
        items={sidebarItems(overview?.counts ?? null)}
        active={active}
        onGo={(id) => {
          const section = SECTION_IDS.find((s) => s === id);
          if (!section) return;
          setActive(section);
          scrollToSection(section);
        }}
        footer={FOOTER}
      />
      <main className="syn-main">
        <div className="syn-main-inner">
          <section id="overview" className="syn-section">
            <h1>
              Synapse <HealthBadge health={health} />
            </h1>
            {loadError && <p style={{ color: "var(--redFg)" }}>{loadError}</p>}
            {actionError && (
              <p style={{ color: "var(--redFg)" }}>
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
          </section>
          <section id="triage" className="syn-section">
            <h2>Urgent</h2>
            <UrgentInbox
              items={urgent}
              onStatus={(id: string, s: UrgencyStatusDto) => void act(() => setUrgentStatus(id, s))}
              onReply={(id: string, text: string) => void act(() => requestUrgentReply(id, text))}
              onResolve={(id: string, d: ResolveDecisionDto) =>
                void act(() => resolveOutgoing(id, d))
              }
            />
            <h2>Follow-up drafts</h2>
            <FollowupDrafts
              items={followups}
              onSend={(id: string, text: string) => void act(() => sendFollowup(id, text))}
              onDiscard={(id: string) => void act(() => discardFollowup(id))}
              onResolve={(id: string, d: ResolveDecisionDto) =>
                void act(() => resolveOutgoing(id, d))
              }
            />
            <h2>Red flags</h2>
            <RedFlags
              groups={flags}
              expanded={expanded}
              history={history}
              onToggle={toggleHistory}
              onReview={(id: string, s: FlagReviewStatus) => void act(() => reviewFlag(id, s))}
            />
            <h2>Profile recommendations</h2>
            <ProfileRecommendations
              items={recommendations}
              onDecide={(d: Decision) => void decide(d.approvalId, d.decision, d.reason)}
              onDismiss={(id) => void act(() => dismissSuggestion(id))}
              onDiscard={(id) => void act(() => discardRecommendation(id))}
              onRetry={(id) => void act(() => retryApply(id))}
              onEvaluate={(id) => void evaluate(() => acceptSuggestion(id))}
            />
            <h2>Pending approvals</h2>
            <ApprovalsList approvals={approvals} onDecide={decide} />
          </section>
          <section id="inbox" className="syn-section">
            <h2>Inbox</h2>
            <InboxPanel messages={messages} />
          </section>
          <section id="commitments" className="syn-section">
            <h2>Commitments</h2>
            <CommitmentsPanel
              queue={reviewQueue}
              items={commitments}
              filter={commitmentFilter}
              onFilter={(f: CommitmentFilter) => {
                commitmentFilterRef.current = f;
                setCommitmentFilter(f);
                void refresh();
              }}
              onReview={(id: string, d: "accept" | "reject", edits?: CommitmentEditsDto) =>
                void act(() => reviewCommitment(id, d, edits))
              }
              onStatus={(id: string, s: CommitmentStatusDto) =>
                void act(() => setCommitmentStatus(id, s))
              }
              onProposal={(id: string, accept: boolean) =>
                void act(() => decideProposal(id, accept))
              }
              onDraftFollowup={(id: string) =>
                void act(async () => {
                  const r = await draftFollowup(id);
                  if (!r.queued)
                    throw new Error("A follow-up draft is already queued for this commitment");
                })
              }
            />
          </section>
          <section id="people" className="syn-section">
            <h2>People to evaluate</h2>
            <PeopleCandidates
              data={candidates}
              onEvaluate={(u) => void evaluate(() => evaluatePerson(u))}
              onOpen={openPerson}
            />
            <PersonProfile
              person={person}
              onClose={() => openPerson(null)}
              onEvaluate={(u) => void evaluate(() => evaluatePerson(u))}
              onPriority={(p, priority, extraAttention) =>
                void act(() =>
                  setPersonPriority(p.slackUserId, {
                    priority,
                    rationale: p.rationale ?? "",
                    extraAttention,
                  }),
                )
              }
            />
            <h2>Priority people</h2>
            <PriorityPeople
              people={people}
              onOpen={openPerson}
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
          </section>
          <section id="system" className="syn-section">
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
          </section>
        </div>
      </main>
    </div>
  );
}
