"use client";

import type {
  ApprovalView,
  AwayDigest,
  BackupEntry,
  CandidatesResponse,
  ClaudeActivityView,
  CodeAnswerView,
  CommitmentFilter,
  ConversationSummary,
  ConversationThread,
  DashboardOverview,
  EngineeringTaskDetail,
  EngineeringTaskView,
  JiraIssueView,
  Job,
  PersonDetail,
  ProjectDetail,
  RecommendationView,
  RepositoryView,
  RuntimeView,
} from "@synapse/contracts";
import {
  type DashboardLayout,
  type DashboardLayoutSummary,
  type DashboardLayoutsResponse,
  type DashboardSectionId,
  DEFAULT_DASHBOARD_LAYOUT,
} from "@synapse/contracts";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ActionErrors, actionErrorText, NO_ACTION_ERRORS } from "../lib/action-errors";
import {
  ApiError,
  acceptCurrentRemotes,
  activateLayout,
  addProjectFact,
  approveTaskDescription,
  approveTaskPlan,
  type ClaudeRun,
  type ClaudeStatus,
  type CommitmentStatusDto,
  type CommitmentViewDto,
  classifyOverviewFailure,
  createEngineeringTask,
  createLayout,
  createMilestone,
  decideProposal,
  deleteLayout,
  deleteMilestone,
  draftFollowup,
  evaluatePerson,
  type FollowupViewDto,
  type GroupedFlagsDto,
  getApprovals,
  getAwayDigest,
  getBackups,
  getCandidates,
  getClaudeActivity,
  getClaudeRuns,
  getClaudeStatus,
  getCommitments,
  getConversations,
  getEngineeringTask,
  getEngineeringTasks,
  getFollowups,
  getJiraIssues,
  getJiraStatus,
  getJobs,
  getLayouts,
  getOverview,
  getPeople,
  getPersonFlags,
  getPersonProfile,
  getProject,
  getProjects,
  getRecommendations,
  getRepositories,
  getRuntime,
  getSecurityFlags,
  getSettings,
  getSlackIdentity,
  getSlackStatus,
  getThread,
  getUrgent,
  inspectRepositoryNow,
  inspectRepositoryPath,
  type JiraStatusDto,
  type OverviewFailure,
  type PersonDto,
  type PersonPriorityDto,
  putSettings,
  registerRepository,
  resetLayout,
  type SecurityFlagDto,
  type SettingsDto,
  type SlackIdentityDto,
  type SlackStatusDto,
  sendCodeAnswer,
  setCommitmentStatus,
  setPersonPriority,
  skipUnreadablePage,
  startBackup,
  type UrgentItemDto,
  updateLayout,
  updateMilestone,
} from "../lib/api";
import { backupStartMessage } from "../lib/backup";
import { brainPaletteItems, projectRowId } from "../lib/brain";
import { codeAnswerErrorText, codeAnswerEventMessageId } from "../lib/code-answers";
import { trailingDebounce } from "../lib/debounce";
import { clearDraft } from "../lib/drafts";
import { engineeringErrorText, isTerminal, lockText, type TaskSource } from "../lib/engineering";
import { conversationTitle, filterConversations, type InboxFilter } from "../lib/inbox";
import { jiraPaletteItems, jiraRowId } from "../lib/jira";
import {
  focusSelector,
  hiddenSections,
  type LayoutRow,
  layoutErrorText,
  layoutRows,
  moveVisible,
  SECTION_LABELS,
  setCollapsed,
  setVisible,
  setWidth,
} from "../lib/layout";
import {
  createLayoutGate,
  createLayoutSaver,
  LAYOUT_SWITCH_FAILED,
  type LayoutCallOutcome,
  runLayoutCall,
} from "../lib/layout-saver";
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
import type { EvalOutcome } from "../lib/people-ui";
import { writeTheme } from "../lib/theme";
import type { MilestoneDraft } from "./components/brain/ProjectCard";
import { ProjectsSection } from "./components/brain/ProjectsSection";
import { Commitments } from "./components/commitments/Commitments";
import { EngineeringSection, engineeringRowId } from "./components/engineering/EngineeringSection";
import { RepositoryPicker } from "./components/engineering/RepositoryPicker";
import { AwayBanner } from "./components/header/AwayBanner";
import { CommandPalette } from "./components/header/CommandPalette";
import { Header } from "./components/header/Header";
import { Inbox } from "./components/inbox/Inbox";
import { JiraSection } from "./components/jira/JiraSection";
import { DashboardSection } from "./components/layout/DashboardSection";
import { HiddenTray } from "./components/layout/HiddenTray";
import { LayoutPicker } from "./components/layout/LayoutPicker";
import { People } from "./components/people/People";
import { ProfileDrawer } from "./components/people/ProfileDrawer";
import { useQueuedEvaluations } from "./components/people/useQueuedEvaluations";
import { Sidebar } from "./components/shell/Sidebar";
import { ClaudeCodeCard } from "./components/system/ClaudeCodeCard";
import { ClaudeSettings } from "./components/system/ClaudeSettings";
import { Running } from "./components/system/Running";
import { RuntimePanel } from "./components/system/RuntimePanel";
import { SystemDetails } from "./components/system/SystemDetails";
import { NeedsYou } from "./components/triage/NeedsYou";
import { BACKFILL_CARD_ID } from "./components/triage/SetupCards";
import { useNeedsYouActions } from "./components/triage/useNeedsYouActions";
import { useToast } from "./components/ui/Toasts";

const FOOTER = { api: "127.0.0.1:7400", web: ":7401" };

/** Highlights the section in view (spec D1): the first one crossing the top 40% of the viewport. */
function useActiveSection(
  initial: SectionId,
  layoutKey: string,
): [SectionId, (id: SectionId) => void] {
  const [active, setActive] = useState<SectionId>(initial);
  // Sections mount, unmount and move with the layout, so the observer is rebuilt on a change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey is the trigger
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
  }, [layoutKey]);
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
  { id: "jira", label: "Jira" },
  { id: "projects", label: "Projects" },
  { id: "engineering", label: "Engineering" },
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
  const [overviewFailure, setOverviewFailure] = useState<OverviewFailure | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const now = useClock();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openHealthSignal, setOpenHealthSignal] = useState(0);
  const [layout, setLayout] = useState<DashboardLayout>(DEFAULT_DASHBOARD_LAYOUT);
  const [layoutList, setLayoutList] = useState<DashboardLayoutSummary[]>([]);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);
  const [customising, setCustomising] = useState(false);
  // Sections the user expanded outside customise mode; never saved.
  const [localExpanded, setLocalExpanded] = useState<ReadonlySet<string>>(new Set());
  // Sections revealed by navigation (hidden ones shown, never saved); cleared on the next layout change.
  const [localShown, setLocalShown] = useState<ReadonlySet<string>>(new Set());
  const shownLayout: DashboardLayout = customising
    ? layout
    : {
        ...layout,
        sections: layout.sections.map((x) =>
          !x.visible && localShown.has(x.id) ? { ...x, visible: true } : x,
        ),
      };
  const rows = layoutRows(shownLayout);
  const [active, setActive] = useActiveSection("overview", JSON.stringify(rows));
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
  const [awayDigest, setAwayDigest] = useState<AwayDigest | null>(null);
  const [flags, setFlags] = useState<GroupedFlagsDto[]>([]);
  const [people, setPeople] = useState<PersonDto[]>([]);
  const [candidates, setCandidates] = useState<CandidatesResponse | null>(null);
  // Evaluations requested this session, shared by People and the Needs-you setup card.
  const evalQueue = useQueuedEvaluations(candidates?.candidates);
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
  const [jiraStatus, setJiraStatus] = useState<JiraStatusDto | null>(null);
  const [jiraIssues, setJiraIssues] = useState<JiraIssueView[]>([]);
  const [jiraAttention, setJiraAttention] = useState<JiraIssueView[]>([]);
  const [repos, setRepos] = useState<RepositoryView[] | null>(null);
  // Code answers (Phase 10b C5): the answer chosen as a reply, and a counter bumped by live events.
  const [codeDraft, setCodeDraft] = useState<{
    codeAnswerId: string;
    draft: string;
    useAnyway: boolean;
  } | null>(null);
  const [codeAnswerTick, setCodeAnswerTick] = useState<{ n: number; messageId: string | null }>({
    n: 0,
    messageId: null,
  });
  const [projectDetails, setProjectDetails] = useState<ProjectDetail[]>([]);
  const [claudeActivity, setClaudeActivity] = useState<ClaudeActivityView | null>(null);
  const [claudeSettings, setClaudeSettings] = useState<SettingsDto | null>(null);
  const [repoChoice, setRepoChoice] = useState<TaskSource | null>(null);
  const [runtime, setRuntime] = useState<RuntimeView | null>(null);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [settingsReset, setSettingsReset] = useState(0);
  const [backupPending, setBackupPending] = useState(false);
  const [engineeringTasks, setEngineeringTasks] = useState<EngineeringTaskView[]>([]);
  const [engineeringDetails, setEngineeringDetails] = useState<
    Record<string, EngineeringTaskDetail>
  >({});
  const [registerSignal, setRegisterSignal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<ActionErrors>(NO_ACTION_ERRORS);
  // Immediate actions clear only their own channel; a deferred commit's failure stays until Dismiss.
  const setActionError = useCallback(
    (e: string | null) => setActionErrors((s) => ({ ...s, immediate: e })),
    [],
  );
  const setDeferredError = useCallback(
    (e: string) => setActionErrors((s) => ({ ...s, deferred: e })),
    [],
  );
  const actionError = actionErrorText(actionErrors);
  // The control that opened the profile drawer, captured at click time (focus returns to it).
  const personOpenerRef = useRef<HTMLElement | null>(null);
  const [backfillSignal, setBackfillSignal] = useState(0);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const activeLayoutIdRef = useRef<string | null>(null);
  const refreshRef = useRef<() => Promise<unknown>>(async () => {});
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Debounced layout saves. While one is pending, refresh() leaves the local layout alone.
  const [gate] = useState(createLayoutGate);
  const [saver] = useState(() =>
    createLayoutSaver({
      put: (l) => {
        const id = activeLayoutIdRef.current;
        return id === null
          ? Promise.reject(new Error("no active layout"))
          : updateLayout(id, { layout: l });
      },
      onSaved: (v) => {
        gate.bump();
        setLayout(v.layout);
      },
      onError: (text) => {
        gate.bump();
        toastRef.current.show(text);
      },
      reload: () => void refreshRef.current(),
    }),
  );
  // The selected conversation falls back to the first one in the current filter (spec D10).
  const visibleConversations = filterConversations(conversations, inboxFilter);
  const effectiveConversationId = visibleConversations.some((c) => c.id === selectedId)
    ? selectedId
    : (visibleConversations[0]?.id ?? null);
  threadIdRef.current = effectiveConversationId;

  const applyLayouts = useCallback((r: DashboardLayoutsResponse) => {
    setLayout(r.active.layout);
    setLayoutList(r.layouts);
    activeLayoutIdRef.current = r.active.id;
    setActiveLayoutId(r.active.id);
  }, []);

  const refresh = useCallback(async () => {
    const openUser = personRef.current;
    const threadId = threadIdRef.current;
    const layoutToken = gate.begin();
    const [
      a,
      j,
      cs,
      cr,
      ss,
      ug,
      sf,
      pp,
      id,
      cd,
      rc,
      cm,
      rq,
      fu,
      ov,
      cv,
      pd,
      td,
      ad,
      js,
      ji,
      ja,
      rp,
      pr,
      et,
      ca,
      st,
      lo,
      rt,
      bk,
    ] = await Promise.allSettled([
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
      getAwayDigest(),
      getJiraStatus(),
      getJiraIssues("all"),
      getJiraIssues("attention"),
      getRepositories(),
      getProjects(),
      getEngineeringTasks(),
      getClaudeActivity(),
      getSettings(),
      getLayouts(),
      getRuntime(),
      getBackups(),
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
    setOverviewFailure(ov.status === "rejected" ? classifyOverviewFailure(ov.reason) : null);
    if (cv.status === "fulfilled") setConversations(cv.value);
    if (ad.status === "fulfilled") setAwayDigest(ad.value);
    if (js.status === "fulfilled") setJiraStatus(js.value);
    if (ji.status === "fulfilled") setJiraIssues(ji.value);
    if (ja.status === "fulfilled") setJiraAttention(ja.value);
    if (rp.status === "fulfilled") setRepos(rp.value);
    if (ca.status === "fulfilled") setClaudeActivity(ca.value);
    if (st.status === "fulfilled") setClaudeSettings(st.value);
    if (rt.status === "fulfilled") setRuntime(rt.value);
    if (bk.status === "fulfilled") setBackups(bk.value);
    // A refresh that lands while an edit is debounced or in flight must not undo that edit.
    // A fetch that began before a save settled is older than that save and is dropped.
    if (lo.status === "fulfilled" && !saver.isBusy() && gate.isCurrent(layoutToken))
      applyLayouts(lo.value);
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
    // Project details (facts, milestones) follow the project list; a failed one keeps its old copy.
    let projectsFailed = pr.status === "rejected";
    if (pr.status === "fulfilled") {
      const details = await Promise.allSettled(pr.value.map((p) => getProject(p.id)));
      projectsFailed = details.some((d) => d.status === "rejected");
      const fresh = details.flatMap((d) => (d.status === "fulfilled" ? [d.value] : []));
      setProjectDetails((prev) =>
        pr.value.flatMap((p) => {
          const d = fresh.find((x) => x.id === p.id) ?? prev.find((x) => x.id === p.id);
          return d ? [d] : [];
        }),
      );
    }
    // Open tasks carry their plan, steps and diff in the detail; finished ones show the list row only.
    if (et.status === "fulfilled") {
      setEngineeringTasks(et.value);
      const open = et.value.filter((t) => !isTerminal(t.status));
      const fetched = await Promise.allSettled(open.map((t) => getEngineeringTask(t.id)));
      // A failed fetch keeps the detail already shown, so an open description form is not
      // unmounted (and its edits lost) by one bad refresh.
      setEngineeringDetails((prev) =>
        Object.fromEntries(
          open.flatMap((t, i) => {
            const d = fetched[i];
            if (d?.status === "fulfilled") return [[t.id, d.value]];
            const kept = prev[t.id];
            return kept ? [[t.id, kept]] : [];
          }),
        ),
      );
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
    // A failed thread refetch surfaces like any other fetch failure.
    const failed = [
      a,
      j,
      cs,
      cr,
      ss,
      ug,
      sf,
      pp,
      id,
      cd,
      rc,
      cm,
      rq,
      fu,
      ov,
      cv,
      td,
      ad,
      js,
      ji,
      rp,
      et,
    ].find((r) => r.status === "rejected");
    const message =
      failed?.status === "rejected"
        ? String(failed.reason)
        : projectsFailed
          ? "Could not load the projects"
          : null;
    setLoadError(message);
    return message;
  }, [saver, gate, applyLayouts]);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    // A burst of live events (e.g. one per stored page) triggers one refresh, 500 ms after the last.
    const debounced = trailingDebounce(() => void refresh(), 500);
    const source = new EventSource("/api/stream");
    source.onmessage = () => debounced.call();
    // Events are named (`event: <type>`), so onmessage alone would miss them.
    for (const t of LIVE_EVENT_TYPES) source.addEventListener(t, () => debounced.call());
    source.addEventListener("code_answer.status_changed", (e) => {
      const messageId = codeAnswerEventMessageId((e as MessageEvent).data);
      setCodeAnswerTick((t) => ({ n: t.n + 1, messageId }));
    });
    return () => {
      debounced.cancel();
      source.close();
    };
  }, [refresh]);

  // A pending layout edit is sent when the page unmounts.
  useEffect(() => () => void saver.flush(), [saver]);

  // A code-answer draft belongs to the conversation it was made in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clears on a conversation change only
  useEffect(() => setCodeDraft(null), [effectiveConversationId]);

  // The backend refuses a suspected injection without `useAnyway`, whatever this UI sends.
  const sendCodeAnswerDraft = async (id: string, text: string, useAnyway: boolean) => {
    setActionError(null);
    try {
      await sendCodeAnswer(id, text, useAnyway);
      clearDraft(`code_answer:${id}`);
      setCodeDraft(null);
      toast.show("Approval request created · nothing is sent until you approve");
    } catch (e) {
      setActionError(codeAnswerErrorText(e, "Could not request approval for that answer"));
    }
    await refresh();
  };

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
  }, [effectiveConversationId, setActionError]);

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
    // Captured now, synchronously: the profile loads later, when focus may have moved.
    if (slackUserId !== null)
      personOpenerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    personRef.current = slackUserId;
    if (slackUserId === null) setPerson(null);
    void refresh();
  };

  // A refusal (no identity, already queued) is a normal result, returned as a notice; the caller
  // shows it (after a whole batch, for Evaluate top 3) and toasts a success.
  const requestEvaluation = async (slackUserId: string): Promise<EvalOutcome> => {
    let out: EvalOutcome;
    try {
      const r = await evaluatePerson(slackUserId);
      out = r.queued
        ? { queued: true, notice: null }
        : { queued: false, notice: `Not queued: ${r.reason ?? "unknown reason"}` };
    } catch (e) {
      out = { queued: false, notice: String(e) };
    }
    await refresh();
    return out;
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

  const inspectNow = async (id: string) => {
    setActionError(null);
    try {
      await inspectRepositoryNow(id);
      toast.show("Inspection queued · runs in the background");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast.show("Inspection already queued");
      else setActionError(String(e));
    }
    await refresh();
  };

  const proposeRepository = async (path: string) => {
    try {
      return { ok: true, proposal: await inspectRepositoryPath(path) } as const;
    } catch (e) {
      return {
        ok: false,
        error: e instanceof ApiError ? (e.code ?? "git_failed") : "unreachable",
      } as const;
    }
  };

  const register: ComponentProps<typeof ProjectsSection>["onRegister"] = async (input) => {
    try {
      await registerRepository(input);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof ApiError ? (e.code ?? "invalid_input") : "unreachable",
      };
    }
    toast.show("Repository registered");
    await refresh();
    return { ok: true };
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
    navigateTo("inbox");
  };

  // Navigating to a hidden or collapsed section reveals it locally (not saved), then scrolls.
  const [scrollTick, setScrollTick] = useState(0);
  const pendingScrollRef = useRef<string | null>(null);
  const navigateTo = (sectionId: string, targetId: string = sectionId) => {
    const sec = layoutRef.current.sections.find((x) => x.id === sectionId);
    if (sec && !customising) {
      if (!sec.visible) setLocalShown((set) => new Set(set).add(sectionId));
      if (sec.collapsed) setLocalExpanded((set) => new Set(set).add(sectionId));
    }
    pendingScrollRef.current = targetId;
    setScrollTick((n) => n + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollTick is the trigger, after the reveal renders
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (id === null) return;
    pendingScrollRef.current = null;
    scrollToSection(id);
  }, [scrollTick]);

  const goTo = (id: SectionId) => {
    setActive(id);
    navigateTo(id);
  };

  const openRegister = () => {
    setActive("projects");
    setRegisterSignal((n) => n + 1);
    navigateTo("projects");
  };

  const feed = useNeedsYouActions({
    refresh,
    setActionError,
    setDeferredError,
    toggleHistory,
    seeAllPeople: () => goTo("people"),
    seeAllJira: () => goTo("jira"),
    seeAllProjects: () => goTo("projects"),
    registerRepository: () => openRegister(),
    pickRepository: setRepoChoice,
    seeAllEngineering: (taskId) => {
      setActive("engineering");
      navigateTo("engineering", taskId ? engineeringRowId(taskId) : "engineering");
    },
    onEvaluationQueued: (id) => evalQueue.markQueued([id]),
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
    awayDigest,
    jiraStatus,
    jiraAttention,
    brainReview: projectDetails.flatMap((d) =>
      d.facts
        .filter((f) => f.status === "needs_review")
        .map((fact) => ({ fact, projectName: d.name })),
    ),
    repositories: repos,
    engineeringTasks,
    hidden: feed.hidden,
  };
  const cards = buildNeedsYou(needsInput);

  // Each form handler resolves to an error text (shown inside the form), or null on success.
  const engineeringCall = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
    } catch (e) {
      return engineeringErrorText(e);
    }
    await refresh();
    return null;
  };
  // A running backfill has nothing to start, so the palette offers no action for it.
  const canStartBackfill = cards.some((c) => c.kind === "setup-backfill" && isActionable(c));

  // Brings the backfill setup card into view with its confirm step open.
  const openBackfill = () => {
    setActive("triage");
    setBackfillSignal((n) => n + 1);
    navigateTo("triage", BACKFILL_CARD_ID);
  };

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.show("Copied"),
      (e: unknown) => setActionError(String(e)),
    );

  // After a toolbar action the clicked button may be disabled or gone: focus moves to a stable spot.
  const focusRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each layout change
  useEffect(() => {
    const sel = focusRef.current;
    if (sel === null) return;
    focusRef.current = null;
    document.querySelector<HTMLElement>(sel)?.focus();
  }, [layout]);

  const editLayout = (
    fn: (l: DashboardLayout) => DashboardLayout,
    focus?: { id: DashboardSectionId; action: "move" | "hide" | "collapse" | "width" },
  ) => {
    // A picker call (switch, create, reset) is changing the active layout; edits wait for it.
    if (gate.isLocked()) return;
    const next = fn(layoutRef.current);
    if (next === layoutRef.current) return;
    setLocalShown(new Set());
    setLocalExpanded(new Set());
    if (focus) focusRef.current = focusSelector(focus.action, focus.id);
    layoutRef.current = next;
    setLayout(next);
    saver.change(next);
  };

  // Picker actions: serialised; the server's answer is applied, then a refresh shows the rest.
  const layoutCall = async (
    op: Parameters<typeof runLayoutCall>[1],
  ): Promise<LayoutCallOutcome> => {
    const outcome = await runLayoutCall(
      {
        gate,
        flush: () => saver.flush(),
        setBusy: setLayoutBusy,
        getLayouts,
        apply: (r) => {
          applyLayouts(r);
          setLocalShown(new Set());
          setLocalExpanded(new Set());
        },
        toast: toast.show,
      },
      op,
    );
    if (outcome !== "busy") await refresh();
    return outcome;
  };
  const opErrorText = (e: unknown) => layoutErrorText(e instanceof ApiError ? e.code : undefined);

  const toggleCustomise = () => {
    if (customising) void saver.flush();
    setCustomising((c) => !c);
  };

  const hiddenIds: ReadonlySet<string> = new Set(
    layout.sections.filter((x) => !x.visible).map((x) => x.id),
  );
  const navItems = sidebarItems(
    overview?.counts ?? null,
    needsYouCount(cards),
    conversations.filter((c) => c.theyWroteLast).length,
    hiddenIds,
  );
  const visibleOrder = shownLayout.sections.filter((x) => x.visible).map((x) => x.id);

  const renderSection = (id: DashboardSectionId) => {
    const sec = layout.sections.find((x) => x.id === id);
    if (!sec) return null;
    const nav = navItems.find((n) => n.id === id);
    const collapsed = customising ? sec.collapsed : sec.collapsed && !localExpanded.has(id);
    return (
      <DashboardSection
        key={id}
        id={id}
        label={SECTION_LABELS[id]}
        count={nav?.count}
        hot={nav?.hot}
        width={sec.width}
        collapsed={collapsed}
        customising={customising}
        isFirst={visibleOrder[0] === id}
        isLast={visibleOrder[visibleOrder.length - 1] === id}
        canHide={id !== "triage"}
        onMove={(delta) => editLayout((l) => moveVisible(l, id, delta), { id, action: "move" })}
        onHide={() => editLayout((l) => setVisible(l, id, false), { id, action: "hide" })}
        onCollapse={(want) => {
          if (customising) editLayout((l) => setCollapsed(l, id, want), { id, action: "collapse" });
          else if (!want) setLocalExpanded((set) => new Set(set).add(id));
        }}
        onWidth={(w) => editLayout((l) => setWidth(l, id, w), { id, action: "width" })}
        busy={layoutBusy}
      >
        {sectionBodies[id]}
      </DashboardSection>
    );
  };

  const renderRow = (row: LayoutRow) =>
    row.kind === "pair" ? (
      <div key={row.ids.join("+")} className="syn-pair">
        {renderSection(row.ids[0])}
        {renderSection(row.ids[1])}
      </div>
    ) : (
      renderSection(row.id)
    );

  const paletteItems: PaletteItem[] = [
    ...GO_TO.filter((g) => !hiddenIds.has(g.id)).map(
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
        label: conversationTitle(c),
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
    ...jiraPaletteItems(jiraIssues, jiraStatus?.enabled === true, {
      sync: feed.handlers.syncJira,
      open: (key) => {
        setActive("jira");
        navigateTo("jira", jiraRowId(key));
      },
    }),
    ...brainPaletteItems(projectDetails, {
      register: openRegister,
      open: (id) => {
        setActive("projects");
        navigateTo("projects", projectRowId(id));
      },
    }),
    {
      id: "act-customise",
      label: customising ? "Done customising" : "Customise dashboard",
      group: "action",
      run: toggleCustomise,
    },
    { id: "act-theme", label: "Toggle theme", group: "action", run: toggleTheme },
  ];

  const sectionBodies: Record<DashboardSectionId, ReactNode> = {
    triage: (
      <>
        {repoChoice && (
          <RepositoryPicker
            source={repoChoice}
            repos={repos ?? []}
            onPick={(source, repositoryId) => {
              setRepoChoice(null);
              feed.handlers.createTaskInRepository(source, repositoryId);
            }}
            onCancel={() => setRepoChoice(null)}
          />
        )}
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
          queuedEvaluations={evalQueue.queued}
          engineering={{ tasks: engineeringTasks, details: engineeringDetails }}
        />
      </>
    ),
    running: (
      <>
        <Running
          pipeline={overview?.pipeline ?? []}
          status={claudeStatus}
          runs={claudeRuns}
          now={now}
          upcoming={overview?.upcoming}
          engineeringLock={overview?.engineeringLock}
          claudeActivity={overview?.claudeActivity}
        />
        <ClaudeCodeCard activity={claudeActivity} now={now} />
      </>
    ),
    inbox: (
      <>
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
          codeAnswers={{
            repositories: repos ?? [],
            tick: codeAnswerTick,
            draft: codeDraft,
            onUseAsReply: (v: CodeAnswerView, useAnyway: boolean) =>
              setCodeDraft({ codeAnswerId: v.id, draft: v.answer ?? "", useAnyway }),
            onSend: (id, text, useAnyway) => void sendCodeAnswerDraft(id, text, useAnyway),
            onDiscard: () => {
              if (codeDraft) clearDraft(`code_answer:${codeDraft.codeAnswerId}`);
              setCodeDraft(null);
            },
            onDismissed: (id) => {
              clearDraft(`code_answer:${id}`);
              setCodeDraft((d) => (d?.codeAnswerId === id ? null : d));
            },
          }}
        />
      </>
    ),
    commitments: (
      <>
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
          onProposal={(id: string, accept: boolean) => void act(() => decideProposal(id, accept))}
          onDraftFollowup={(id: string) =>
            void act(async () => {
              const r = await draftFollowup(id);
              if (!r.queued)
                throw new Error("A follow-up draft is already queued for this commitment");
            })
          }
          onGoToReview={() => goTo("triage")}
        />
      </>
    ),
    jira: (
      <>
        <JiraSection
          status={jiraStatus}
          issues={jiraIssues}
          now={now}
          onSync={feed.handlers.syncJira}
          onGoToSetup={() => goTo("triage")}
          onCreateTask={feed.handlers.createTaskFromJira}
        />
      </>
    ),
    projects: (
      <>
        <ProjectsSection
          repos={repos ?? []}
          projects={projectDetails}
          loaded={repos !== null}
          now={now}
          hidden={feed.hidden}
          registerSignal={registerSignal}
          onInspectNow={(id) => void inspectNow(id)}
          onAcceptRemotes={(id) => void act(() => acceptCurrentRemotes(id))}
          onProposal={proposeRepository}
          onRegister={register}
          onAcceptFact={feed.handlers.acceptBrainFact}
          onRejectFact={feed.handlers.rejectBrainFact}
          onAddFact={(projectId, kind, content) =>
            void act(() => addProjectFact(projectId, { kind, content }))
          }
          onSaveMilestone={(projectId, id, d: MilestoneDraft) =>
            void act(() =>
              id === null ? createMilestone(projectId, d) : updateMilestone(projectId, id, d),
            )
          }
          onDeleteMilestone={(projectId, id) => void act(() => deleteMilestone(projectId, id))}
        />
      </>
    ),
    engineering: (
      <>
        <EngineeringSection
          sandboxEnabled={claudeSettings?.["engineering.sandbox.enabled"] ?? null}
          tasks={engineeringTasks}
          details={engineeringDetails}
          repos={repos ?? []}
          lock={overview?.engineeringLock ?? null}
          now={now}
          handlers={{
            create: (input) => engineeringCall(() => createEngineeringTask(input)),
            approveDescription: (id, d) => engineeringCall(() => approveTaskDescription(id, d)),
            approvePlan: (id, v) => engineeringCall(() => approveTaskPlan(id, v)),
            cancel: feed.handlers.cancelEngineeringTask,
          }}
        />
      </>
    ),
    people: (
      <>
        <People
          candidates={candidates}
          people={people}
          self={identity?.selfUserId ?? null}
          onEvaluate={requestEvaluation}
          onNotice={setActionError}
          onPriority={setPriority}
          onOpen={openPerson}
          queued={evalQueue.queued}
          onQueued={evalQueue.markQueued}
        />
      </>
    ),
    system: (
      <>
        <SystemDetails
          jobs={jobs}
          slack={slackStatus}
          runs={claudeRuns}
          onSkip={() => void skipPage()}
          now={now}
        />
        <RuntimePanel
          runtime={runtime}
          backups={backups}
          settings={claudeSettings}
          now={now}
          backupPending={backupPending}
          onBackupNow={() => {
            setBackupPending(true);
            void startBackup()
              .then(() => {
                toast.show("Backup started");
                void refresh();
              })
              .catch((e: unknown) => toast.show(backupStartMessage(e)))
              .finally(() => setBackupPending(false));
          }}
          resetKey={settingsReset}
          onSetting={(key, value) => {
            void putSettings({ [key]: value })
              .then(setClaudeSettings)
              .catch(() => {
                toast.show("Could not save that setting");
                setSettingsReset((n) => n + 1);
                void refresh();
              });
          }}
        />
        <ClaudeSettings
          values={claudeSettings}
          onChange={(key, value) => {
            void putSettings({ [key]: value })
              .then(setClaudeSettings)
              .catch(() => {
                toast.show("Could not save that setting");
                void refresh();
              });
          }}
        />
      </>
    ),
  };

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
        items={navItems}
        active={active}
        onGo={(id) => {
          const section = SECTION_IDS.find((s) => s === id);
          if (!section) return;
          setActive(section);
          navigateTo(section);
        }}
        footer={{ ...FOOTER, lock: lockText(overview?.engineeringLock) }}
      />
      <main className="syn-main">
        <div className="syn-main-inner">
          <section id="overview" className="syn-section">
            <Header
              overview={overview}
              failure={overviewFailure}
              now={now}
              onOpenPalette={() => setPaletteOpen(true)}
              backfillStarted={backfillStarted(slackStatus)}
              onToggleAway={feed.handlers.setAway}
              openHealthSignal={openHealthSignal}
              customising={customising}
              onToggleCustomise={toggleCustomise}
            />
            {overview?.away.on && (
              <AwayBanner
                highPriorityCount={overview.away.highPriorityCount}
                onSetPriority={() => goTo("people")}
              />
            )}
            {loadError && <p className="syn-alert">{loadError}</p>}
            {actionError && (
              <p className="syn-alert">
                {actionError}{" "}
                <button
                  type="button"
                  className="syn-link-btn"
                  onClick={() => setActionErrors(NO_ACTION_ERRORS)}
                >
                  Dismiss
                </button>
              </p>
            )}
          </section>
          {customising && (
            <div className="syn-customise-panel">
              <LayoutPicker
                layouts={layoutList}
                activeId={activeLayoutId ?? ""}
                busy={layoutBusy}
                onSwitch={(id) =>
                  void layoutCall({
                    run: () => activateLayout(id),
                    flushFirst: true,
                    errorText: () => LAYOUT_SWITCH_FAILED,
                  })
                }
                onSaveAs={(name) =>
                  void layoutCall({
                    run: async () => {
                      const made = await createLayout(name, activeLayoutIdRef.current ?? undefined);
                      try {
                        return await activateLayout(made.id);
                      } catch {
                        throw new Error(LAYOUT_SWITCH_FAILED);
                      }
                    },
                    flushFirst: true,
                    errorText: (e) =>
                      e instanceof ApiError ? layoutErrorText(e.code) : LAYOUT_SWITCH_FAILED,
                  })
                }
                onRename={(id, name) =>
                  void layoutCall({
                    run: async () => {
                      await updateLayout(id, { name });
                      return undefined;
                    },
                    flushFirst: false,
                    errorText: opErrorText,
                  })
                }
                onDelete={(id) =>
                  void layoutCall({
                    run: async () => {
                      await deleteLayout(id);
                      return undefined;
                    },
                    flushFirst: false,
                    errorText: opErrorText,
                  })
                }
                onReset={() =>
                  void layoutCall({
                    run: async () => {
                      const id = activeLayoutIdRef.current;
                      if (id !== null) await resetLayout(id);
                      return undefined;
                    },
                    flushFirst: true,
                    errorText: opErrorText,
                  })
                }
              />
              <HiddenTray
                busy={layoutBusy}
                hidden={hiddenSections(layout)}
                onShow={(id) => editLayout((l) => setVisible(l, id, true))}
              />
            </div>
          )}
          {rows.map(renderRow)}
          <ProfileDrawer
            person={person}
            onClose={() => openPerson(null)}
            opener={personOpenerRef.current}
            onEvaluate={(u) => {
              setActionError(null);
              void requestEvaluation(u).then((r) => {
                if (r.queued) {
                  evalQueue.markQueued([u]);
                  toast.show(TOASTS.evaluationQueued);
                } else setActionError(r.notice);
              });
            }}
            onPriority={setPriority}
          />
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
