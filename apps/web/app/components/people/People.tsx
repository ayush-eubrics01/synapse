"use client";

import type { CandidatesResponse } from "@synapse/contracts";
import { useEffect, useState } from "react";
import type { PersonDto, PersonPriorityDto } from "../../../lib/api";
import { TOASTS } from "../../../lib/needs-you-actions";
import {
  evaluateInOrder,
  evaluationsToast,
  pruneQueued,
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
  /** Resolves true when the run was queued; a refusal is reported by the caller and resolves false. */
  onEvaluate: (slackUserId: string) => Promise<boolean>;
  onPriority: (person: PersonDto, priority: PersonPriorityDto, extraAttention: boolean) => void;
  onOpen: (slackUserId: string) => void;
}

export function People(p: PeopleProps) {
  const toast = useToast();
  // The candidates API has no "queued" flag, so ids requested this session are kept here and
  // dropped once the candidate disappears from the list (after the run, or a refresh).
  const [queued, setQueued] = useState<ReadonlySet<string>>(() => new Set());
  const candidateList = p.candidates?.candidates;
  useEffect(() => {
    if (!candidateList) return;
    setQueued((q) => {
      const next = pruneQueued(q, candidateList);
      return next.size === q.size ? q : next;
    });
  }, [candidateList]);

  const markQueued = (ids: string[]) => setQueued((q) => new Set([...q, ...ids]));
  const evaluateOne = async (id: string) => {
    if (await p.onEvaluate(id)) {
      markQueued([id]);
      toast.show(TOASTS.evaluationQueued);
    }
  };
  const evaluateTop = async () => {
    if (!p.candidates) return;
    const ids = topUnqueued(p.candidates.candidates, queued);
    const done = await evaluateInOrder(ids, p.onEvaluate);
    if (done.length > 0) {
      markQueued(done);
      toast.show(evaluationsToast(done.length));
    }
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
