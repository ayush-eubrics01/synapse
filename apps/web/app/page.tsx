"use client";

import type {
  ApprovalView,
  CandidatesResponse,
  CommitmentFilter,
  ConversationSummary,
  ConversationThread,
  DashboardOverview,
  Job,
  PersonDetail,
  RecommendationView,
} from "@synapse/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ClaudeRun,
  type ClaudeStatus,
  type CommitmentStatusDto,
  type CommitmentViewDto,
  decideProposal,
  draftFollowup,
  evaluatePerson,
  type FollowupViewDto,
  type GroupedFlagsDto,
  getApprovals,
  getCandidates,
  getClaudeRuns,
  getClaudeStatus,
  getCommitments,
  getConversations,
  getFollowups,
  getJobs,
  getOverview,
  getPeople,
  getPersonFlags,
  getPersonProfile,
  getRecommendations,
  getSecurityFlags,
  getSlackIdentity,
  getSlackStatus,
  getThread,
  getUrgent,
  type PersonDto,
  type PersonPriorityDto,
  type SecurityFlagDto,
  type SlackIdentityDto,
  type SlackStatusDto,
  setCommitmentStatus,
  setPersonPriority,
  skipUnreadablePage,
  type UrgentItemDto,
} from "../lib/api";
import { trailingDebounce } from "../lib/debounce";
import { filterConversations, type InboxFilter } from "../lib/inbox";
import { LIVE_EVENT_TYPES } from "../lib/live-events";
import { SECTION_IDS, type SectionId, sidebarItems } from "../lib/nav";
import {
  allClearRows,
  buildNeedsYou,
  isActionable,
  type NeedsYouInput,
  needsYouCount,
} from "../lib/needs-you";
import { TOASTS } from "../lib/needs-you-actions";
import type { PaletteItem } from "../lib/palette";
import { writeTheme } from "../lib/theme";
import { Commitments } from "./components/commitments/Commitments";
import { CommandPalette } from "./components/header/CommandPalette";
import { Header } from "./components/header/Header";
import { Inbox } from "./components/inbox/Inbox";
import { People } from "./components/people/People";
import { ProfileDrawer } from "./components/people/ProfileDrawer";
import { Sidebar } from "./components/shell/Sidebar";
import { Running } from "./components/system/Running";
import { SystemDetails } from "./components/system/SystemDetails";
import { NeedsYou } from "./components/triage/NeedsYou";
import { BACKFILL_CARD_ID } from "./components/triage/SetupCards";
import { useNeedsYouActions } from "./components/triage/useNeedsYouActions";
import { useToast } from "./components/ui/Toasts";

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

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

/** Browser clock, null on the server and first render; ticks each minute (hydration-safe). */
function useClock(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * The 90-day backfill counts as started once it has run, paused, failed or finished, or has a
 * checkpoint or a success time. Unknown status (not loaded yet) counts as started, so a slow load
 * never shows a false setup step.
 */
function backfillStarted(s: SlackStatusDto | null): boolean {
  if (s === null) return true;
  const b = s.backfill;
  return b.status !== "idle" || b.checkpoint !== null || b.lastSuccessAt !== null;
}

const GO_TO: Array<{ id: SectionId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "triage", label: "Needs you" },
  { id: "inbox", label: "Inbox" },
  { id: "commitments", label: "Commitments" },
  { id: "people", label: "People" },
  { id: "system", label: "System" },
];

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  try {
    writeTheme(window.localStorage, next);
  } catch {
    writeTheme(null, next);
  }
  document.documentElement.dataset.theme = next;
}

export default function Dashboard() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const now = useClock();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openHealthSignal, setOpenHealthSignal] = useState(0);
  const [active, setActive] = useActiveSection("overview");
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [claudeRuns, setClaudeRuns] = useState<ClaudeRun[]>([]);
  const [slackStatus, setSlackStatus] = useState<SlackStatusDto | null>(null);
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const threadIdRef = useRef<string | null>(null);
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
  const [backfillSignal, setBackfillSignal] = useState(0);
  const toast = useToast();
  // The selected conversation falls back to the first one in the current filter (spec D10).
  const visibleConversations = filterConversations(conversations, inboxFilter);
  const effectiveConversationId = visibleConversations.some((c) => c.id === selectedId)
    ? selectedId
    : (visibleConversations[0]?.id ?? null);
  threadIdRef.current = effectiveConversationId;

  const refresh = useCallback(async () => {
    const openUser = personRef.current;
    const threadId = threadIdRef.current;
    const [a, j, cs, cr, ss, ug, sf, pp, id, cd, rc, cm, rq, fu, ov, cv, pd, td] =
      await Promise.allSettled([
        getApprovals(),
        getJobs(20),
        getClaudeStatus(),
        getClaudeRuns(10),
        getSlackStatus(),
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
        getConversations(50),
        openUser ? getPersonProfile(openUser) : Promise.resolve(null),
        threadId ? getThread(threadId) : Promise.resolve(null),
      ]);
    if (a.status === "fulfilled") setApprovals(a.value);
    if (j.status === "fulfilled") setJobs(j.value);
    if (cs.status === "fulfilled") setClaudeStatus(cs.value);
    if (cr.status === "fulfilled") setClaudeRuns(cr.value);
    if (ss.status === "fulfilled") setSlackStatus(ss.value);
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
    setOverviewFailed(ov.status === "rejected");
    if (cv.status === "fulfilled") setConversations(cv.value);
    // The open thread is refetched with everything else; stale answers for another conversation are dropped.
    if (td.status === "fulfilled" && td.value && threadIdRef.current === threadId)
      setThread(td.value);
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
    const failed = [a, j, cs, cr, ss, ug, sf, pp, id, cd, rc, cm, rq, fu, ov, cv].find(
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

  // Fetches the thread when the shown conversation changes; refresh() keeps it current after that.
  useEffect(() => {
    if (effectiveConversationId === null) {
      setThread(null);
      return;
    }
    const id = effectiveConversationId;
    getThread(id).then(
      (t) => {
        if (threadIdRef.current === id) setThread(t);
      },
      (e: unknown) => {
        if (threadIdRef.current === id) setActionError(String(e));
      },
    );
  }, [effectiveConversationId]);

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

  // A refusal (no identity, already queued) is a normal result; show it as a notice and resolve
  // false. The caller toasts a success, so one click or a batch gives one confirmation.
  const evaluateQuiet = async (slackUserId: string): Promise<boolean> => {
    setActionError(null);
    let queued = false;
    try {
      const r = await evaluatePerson(slackUserId);
      queued = r.queued;
      if (!r.queued) setActionError(`Not queued: ${r.reason ?? "unknown reason"}`);
    } catch (e) {
      setActionError(String(e));
    }
    await refresh();
    return queued;
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

  const setPriority = (
    p: { slackUserId: string; rationale: string | null },
    priority: PersonPriorityDto,
    extraAttention: boolean,
  ) =>
    void act(() =>
      setPersonPriority(p.slackUserId, { priority, rationale: p.rationale ?? "", extraAttention }),
    );

  const openConversation = (id: string) => {
    // A conversation outside the current filter needs the full list to be visible.
    if (!visibleConversations.some((c) => c.id === id)) setInboxFilter("all");
    setSelectedId(id);
    scrollToSection("inbox");
  };

  const goTo = (id: SectionId) => {
    setActive(id);
    scrollToSection(id);
  };

  const feed = useNeedsYouActions({
    refresh,
    setActionError,
    toggleHistory,
    seeAllPeople: () => goTo("people"),
  });
  // Pending-undo keys are passed in, so a live refresh can't bring a hidden item back (D8).
  const needsInput: NeedsYouInput = {
    urgent,
    approvals,
    flags,
    followups,
    reviewQueue,
    recommendations,
    identity,
    people,
    candidates,
    slackStatus,
    hidden: feed.hidden,
  };
  const cards = buildNeedsYou(needsInput);
  // A running backfill has nothing to start, so the palette offers no action for it.
  const canStartBackfill = cards.some((c) => c.kind === "setup-backfill" && isActionable(c));

  // Brings the backfill setup card into view with its confirm step open.
  const openBackfill = () => {
    setActive("triage");
    setBackfillSignal((n) => n + 1);
    scrollToSection(BACKFILL_CARD_ID);
  };

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.show("Copied"),
      (e: unknown) => setActionError(String(e)),
    );

  const paletteItems: PaletteItem[] = [
    ...GO_TO.map(
      (g): PaletteItem => ({
        id: `go-${g.id}`,
        label: g.label,
        group: "go to",
        run: () => goTo(g.id),
      }),
    ),
    ...conversations.map(
      (c): PaletteItem => ({
        id: `conv-${c.id}`,
        label: c.isSelfDm ? "Notes to self" : (c.partner?.name ?? c.name ?? c.id),
        group: "conversation",
        run: () => openConversation(c.id),
      }),
    ),
    ...people.map(
      (p): PaletteItem => ({
        id: `person-${p.slackUserId}`,
        label: p.name ?? p.slackUserId,
        group: "person",
        run: () => openPerson(p.slackUserId),
      }),
    ),
    // Opens the backfill setup card in its confirm step; omitted when there is nothing to start.
    ...(canStartBackfill
      ? [
          {
            id: "act-backfill",
            label: "Start 90-day Slack backfill",
            group: "action",
            run: openBackfill,
          } satisfies PaletteItem,
        ]
      : []),
    {
      id: "act-health",
      label: "Show system health",
      group: "action",
      run: () => {
        goTo("overview");
        setOpenHealthSignal((n) => n + 1);
      },
    },
    { id: "act-theme", label: "Toggle theme", group: "action", run: toggleTheme },
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="syn-app">
      <Sidebar
        items={sidebarItems(
          overview?.counts ?? null,
          needsYouCount(cards),
          conversations.filter((c) => c.theyWroteLast).length,
        )}
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
            <Header
              overview={overview}
              unreachable={overviewFailed}
              now={now}
              onOpenPalette={() => setPaletteOpen(true)}
              backfillStarted={backfillStarted(slackStatus)}
              openHealthSignal={openHealthSignal}
            />
            {loadError && <p style={{ color: "var(--redFg)" }}>{loadError}</p>}
            {actionError && (
              <p style={{ color: "var(--redFg)" }}>
                {actionError}{" "}
                <button type="button" onClick={() => setActionError(null)}>
                  Dismiss
                </button>
              </p>
            )}
          </section>
          <section id="triage" className="syn-section">
            <NeedsYou
              cards={cards}
              allClear={allClearRows(needsInput)}
              now={now}
              handlers={feed.handlers}
              expanded={expanded}
              history={history}
              hidden={feed.hidden}
              sevenDay={claudeStatus?.quota?.sevenDay?.utilization ?? null}
              onCopy={copy}
              backfillConfirmSignal={backfillSignal}
            />
          </section>
          {overview && (
            <section id="running" className="syn-section">
              <Running
                pipeline={overview.pipeline}
                status={claudeStatus}
                runs={claudeRuns}
                now={now}
              />
            </section>
          )}
          <section id="inbox" className="syn-section">
            <Inbox
              conversations={conversations}
              filter={inboxFilter}
              onFilter={setInboxFilter}
              selectedId={effectiveConversationId}
              onSelect={setSelectedId}
              thread={thread}
              urgentById={new Map(urgent.map((u) => [u.messageId, u]))}
              now={now}
              hidden={feed.hidden}
              handlers={feed.handlers}
            />
          </section>
          <section id="commitments" className="syn-section">
            <Commitments
              queue={reviewQueue}
              items={commitments}
              filter={commitmentFilter}
              onFilter={(f: CommitmentFilter) => {
                commitmentFilterRef.current = f;
                setCommitmentFilter(f);
                void refresh();
              }}
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
              onGoToReview={() => goTo("triage")}
            />
          </section>
          <section id="people" className="syn-section">
            <People
              candidates={candidates}
              people={people}
              self={identity?.selfUserId ?? null}
              onEvaluate={evaluateQuiet}
              onPriority={setPriority}
              onOpen={openPerson}
            />
            <ProfileDrawer
              person={person}
              onClose={() => openPerson(null)}
              onEvaluate={(u) => {
                void evaluateQuiet(u).then((ok) => {
                  if (ok) toast.show(TOASTS.evaluationQueued);
                });
              }}
              onPriority={setPriority}
            />
          </section>
          <section id="system" className="syn-section">
            <SystemDetails
              jobs={jobs}
              slack={slackStatus}
              runs={claudeRuns}
              onSkip={() => void skipPage()}
              now={now}
            />
          </section>
        </div>
      </main>
      <CommandPalette
        open={paletteOpen}
        items={paletteItems}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
