import type { CandidatesResponse } from "@synapse/contracts";
import type { PersonDto } from "./api";

export type Candidate = CandidatesResponse["candidates"][number];

/** How many candidates "Evaluate top 3" requests. */
export const TOP_N = 3;
export const QUEUED_NOTE = "Queued · draft profile will appear in Needs you for approval";

/** Score bar width in percent: scores are 0–100 as returned; never thinner than 2%. */
export function barWidth(score: number): number {
  return Math.min(100, Math.max(score, 2));
}

/** The first `n` candidates the server allows to evaluate that were not requested this session. */
export function topUnqueued(
  candidates: readonly Candidate[],
  queued: ReadonlySet<string>,
  n: number = TOP_N,
): string[] {
  return candidates
    .filter((c) => c.actions.includes("evaluate") && !queued.has(c.slackUserId))
    .slice(0, n)
    .map((c) => c.slackUserId);
}

/**
 * Requests evaluations one after another, in order. `evaluate` resolves true when the server
 * queued the run; a refusal (false) or an error leaves that id out and the loop carries on.
 * Returns the ids that were queued.
 */
export async function evaluateInOrder(
  ids: readonly string[],
  evaluate: (id: string) => Promise<boolean>,
): Promise<string[]> {
  const queued: string[] = [];
  for (const id of ids) {
    try {
      if (await evaluate(id)) queued.push(id);
    } catch {
      // The caller's handler reports its own errors; keep going with the rest.
    }
  }
  return queued;
}

export function evaluationsToast(n: number): string {
  return n === 1
    ? "1 evaluation queued · draft will need your approval"
    : `${n} evaluations queued · drafts will need your approval`;
}

/** The Priority list: the user is left out, the filter matches name or id, at most 50 rows. */
export function priorityRows(
  people: readonly PersonDto[],
  self: string | null,
  query: string,
): PersonDto[] {
  const needle = query.trim().toLowerCase();
  return people
    .filter((p) => p.slackUserId !== self)
    .filter((p) => !needle || `${p.name ?? ""} ${p.slackUserId}`.toLowerCase().includes(needle))
    .slice(0, 50);
}

/** Ids requested this session that are still on the list (the API has no queued flag). */
export function pruneQueued(
  queued: ReadonlySet<string>,
  candidates: readonly Candidate[],
): Set<string> {
  const present = new Set(candidates.map((c) => c.slackUserId));
  return new Set([...queued].filter((id) => present.has(id)));
}
