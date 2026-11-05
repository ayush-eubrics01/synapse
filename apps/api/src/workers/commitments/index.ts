import { registerSpecClarity } from "./check-spec-clarity";
import { createCommitmentContext } from "./context";
import { registerDraftFollowup } from "./draft-followup";
import { registerExtract } from "./extract";
import type { CommitmentJobDeps } from "./shared";
import { registerStallAndReminders } from "./stall";

export type { CommitmentJobDeps } from "./shared";

/** Commitment jobs: extraction (and its sweep), stall and reminders, follow-up drafts, spec clarity. */
export function registerCommitmentJobs(deps: CommitmentJobDeps): void {
  const c = createCommitmentContext(deps);
  registerStallAndReminders(deps);
  registerSpecClarity(deps, c);
  registerDraftFollowup(deps, c);
  registerExtract(deps, c);
}
