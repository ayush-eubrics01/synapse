import type {
  EnvironmentView,
  FactKind,
  MilestoneView,
  ProjectFactView,
  RepositoryDrift,
} from "@synapse/contracts";
import type { PaletteItem } from "./palette";

const DAY_MS = 86_400_000;

/** Display order and labels for the approved-fact groups. */
export const FACT_KINDS: Array<{ kind: FactKind; label: string }> = [
  { kind: "purpose", label: "Purpose" },
  { kind: "stack", label: "Stack" },
  { kind: "module", label: "Module" },
  { kind: "entrypoint", label: "Entrypoint" },
  { kind: "convention", label: "Convention" },
  { kind: "risk", label: "Risk" },
  { kind: "note", label: "Note" },
];

export const factKindLabel = (kind: FactKind): string =>
  FACT_KINDS.find((k) => k.kind === kind)?.label ?? kind;

export interface FactGroup {
  kind: FactKind;
  label: string;
  facts: ProjectFactView[];
}

/** Approved facts only, grouped by kind in the fixed order; empty groups are left out. */
export function groupFacts(facts: ProjectFactView[]): FactGroup[] {
  return FACT_KINDS.map(({ kind, label }) => ({
    kind,
    label,
    facts: facts.filter((f) => f.status === "approved" && f.kind === kind),
  })).filter((g) => g.facts.length > 0);
}

/** "stage → stage · auto-deploys on merge", "prod → prod · protected". */
export function envChipLabel(e: EnvironmentView): string {
  const notes = [
    e.protected ? "protected" : null,
    e.autoDeploysOnMerge ? "auto-deploys on merge" : null,
  ]
    .filter((n): n is string => n !== null)
    .join(" · ");
  return `${e.name} → ${e.branch}${notes ? ` · ${notes}` : ""}`;
}

function localDay(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Overdue" or "In N days" for a planned milestone; the status for any other; the date without a clock. */
export function milestoneLabel(
  m: Pick<MilestoneView, "status" | "overdue" | "targetDate">,
  now: Date | null,
): string {
  if (m.status !== "planned") return capitalise(m.status);
  if (m.overdue) return "Overdue";
  if (now === null) return m.targetDate;
  const due = localDay(m.targetDate);
  if (due === null) return m.targetDate;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((due - today) / DAY_MS);
  if (days < 0) return "Overdue";
  if (days === 0) return "Due today";
  return `In ${days} ${days === 1 ? "day" : "days"}`;
}

/** The drift warning text; null when the repository has no drift. */
export function driftLabel(
  drift: RepositoryDrift | null,
  trackedBranch = "its tracked branch",
): string | null {
  if (drift === null) return null;
  const parts: string[] = [];
  if (drift.offTrackedBranch) parts.push(`Not on ${trackedBranch} (now ${drift.offTrackedBranch})`);
  if (drift.missingEnvironmentBranches?.length)
    parts.push(`Missing branch: ${drift.missingEnvironmentBranches.join(", ")}`);
  if (drift.remotesChanged) parts.push("Remotes changed");
  if (drift.pathMissing) parts.push("Path missing");
  return parts.length > 0 ? parts.join(" · ") : null;
}

const REGISTRY_LABELS: Record<string, string> = {
  not_absolute: "Enter an absolute path",
  not_found: "Path not found",
  not_directory: "Not a directory",
  not_git_root: "Not the top of a git repository",
  unsafe_chars: "Path must use letters, numbers, . _ - and /",
  forbidden_location: "That location can't be registered",
  nested: "Inside or around an already registered repository",
  already_registered: "Already registered",
  duplicate_name: "Name already used by another project",
  invalid_branch: "Branch not found in this repository",
  unknown_tracked_branch: "Branch not found in this repository",
  unknown_environment_branch: "Branch not found in this repository",
  invalid_input: "Some fields are not valid",
  invalid_environment: "An environment is not valid",
  duplicate_environment: "Two environments use the same name",
  path_unavailable: "That path is not available right now",
  git_failed: "Couldn't read this repository",
  invalid_state: "Not possible in the current state",
  repo_has_active_task: "An engineering task for this repository is not finished. Cancel it first",
};

/** The inline text for an API error code from inspecting or registering a repository. */
export function registryErrorLabel(code: string): string {
  return REGISTRY_LABELS[code] ?? `Couldn't register: ${code}`;
}

/** The key a fact (and its deferred reject) uses in the hidden set. */
export const brainFactKey = (factId: string): string => `brain-fact:${factId}`;

export const REGISTER_ANCHOR = "register-repository";
export const projectRowId = (id: string): string => `project-${id}`;

/** "Register a repository" plus one entry per project. */
export function brainPaletteItems(
  projects: Array<{ id: string; name: string }>,
  on: { register: () => void; open: (id: string) => void },
): PaletteItem[] {
  return [
    { id: "act-register-repo", label: "Register a repository", group: "action", run: on.register },
    ...projects.map(
      (p): PaletteItem => ({
        id: `project-${p.id}`,
        label: p.name,
        group: "project",
        run: () => on.open(p.id),
      }),
    ),
  ];
}
