export type Operation =
  | "slack.read"
  | "jira.read"
  | "repo.read"
  | "analyze"
  | "recommend"
  | "records.update"
  | "slack.send"
  | "jira.write"
  | "code.modify"
  | "git.commit"
  | "git.push"
  | "git.pr"
  | "git.merge"
  | "deploy"
  | "person.priority.set";

export type Policy =
  | "allowed"
  | "approval_required"
  | "explicit_approval_required"
  | "denied"
  | "user_only";

export const DEFAULT_POLICIES: Record<Operation, Policy> = {
  "slack.read": "allowed",
  "jira.read": "allowed",
  "repo.read": "allowed",
  analyze: "allowed",
  recommend: "allowed",
  "records.update": "approval_required",
  "slack.send": "approval_required",
  "jira.write": "approval_required",
  "code.modify": "approval_required",
  "git.commit": "approval_required",
  "git.push": "approval_required",
  "git.pr": "approval_required",
  "git.merge": "approval_required",
  deploy: "explicit_approval_required",
  "person.priority.set": "user_only",
};

const STRICTNESS = ["allowed", "approval_required", "explicit_approval_required", "denied"];

/** The stricter of two policies. `user_only` is never changed by an override. */
export function stricterOf(a: Policy, b: Policy): Policy {
  if (a === "user_only" || b === "user_only") return "user_only";
  return STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b;
}
