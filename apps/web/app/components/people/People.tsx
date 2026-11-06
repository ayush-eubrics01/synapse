"use client";

import type { CandidatesResponse } from "@synapse/contracts";
import type { PersonDto, PersonPriorityDto } from "../../../lib/api";
import { TOASTS } from "../../../lib/needs-you-actions";
import {
  type EvalOutcome,
  evaluateInOrder,
  evaluationsToast,
  topUnqueued,
} from "../../../lib/people-ui";
import { useToast } from "../ui/Toasts";
import { PriorityList } from "./PriorityList";
import { ReadyToEvaluate } from "./ReadyToEvaluate";

export interface PeopleProps {
  candidates: CandidatesResponse | null;
  people: PersonDto[];
  /** The confirmed Slack id of the user, left out of the Priority list. */
  self: string | null;
  /** Requests one evaluation; never rejects. A refusal or error comes back as a notice. */
  onEvaluate: (slackUserId: string) => Promise<EvalOutcome>;
  /** Shows (or, with null, clears) the evaluation notice. */
  onNotice: (notice: string | null) => void;
  onPriority: (person: PersonDto, priority: PersonPriorityDto, extraAttention: boolean) => void;
  onOpen: (slackUserId: string) => void;
  /** Evaluations requested this session (`useQueuedEvaluations`), shared with Needs you. */
  queued: ReadonlySet<string>;
  onQueued: (ids: readonly string[]) => void;
}

export function People(p: PeopleProps) {
  const toast = useToast();
  const { queued, onQueued: markQueued } = p;
  const evaluateOne = async (id: string) => {
    p.onNotice(null);
    const r = await p.onEvaluate(id);
    if (r.queued) {
      markQueued([id]);
      toast.show(TOASTS.evaluationQueued);
    } else p.onNotice(r.notice);
  };
  // Refusals are collected over the whole batch and shown together once it ends.
  const evaluateTop = async () => {
    if (!p.candidates) return;
    p.onNotice(null);
    const ids = topUnqueued(p.candidates.candidates, queued);
    const { queued: done, notice } = await evaluateInOrder(ids, p.onEvaluate);
    if (done.length > 0) {
      markQueued(done);
      toast.show(evaluationsToast(done.length));
    }
    if (notice !== null) p.onNotice(notice);
  };

  return (
    <>
      <div className="syn-sec-head">
        <h2>People</h2>
        <p className="syn-sec-sub">
          Profiles exist only for people you choose. Claude never changes priority.
        </p>
      </div>
      <div className="syn-stack">
        <ReadyToEvaluate
          data={p.candidates}
          queued={queued}
          onEvaluate={(id) => void evaluateOne(id)}
          onEvaluateTop={() => void evaluateTop()}
          onOpen={p.onOpen}
        />
        <PriorityList people={p.people} self={p.self} onChange={p.onPriority} onOpen={p.onOpen} />
      </div>
    </>
  );
}
