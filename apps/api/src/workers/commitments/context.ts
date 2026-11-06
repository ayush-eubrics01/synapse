import { createRunHelpers } from "../intelligence-shared";

import type { CommitmentJobDeps } from "./shared";

/** The run helpers every Claude-backed commitment job shares. */
export function createCommitmentContext(deps: CommitmentJobDeps) {
  return createRunHelpers(deps.db, deps.securityFlags);
}

export type CommitmentContext = ReturnType<typeof createCommitmentContext>;
