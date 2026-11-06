import type { EngineeringStepStatus, EngineeringTaskDetail } from "@synapse/contracts";
import { reasonLabel, STEP_ORDER, stepLabel } from "../../../lib/engineering";
import { Chip, type ChipTone } from "../ui/Chip";

const STEP_TONE: Record<EngineeringStepStatus, ChipTone> = {
  pending: "neutral",
  awaiting_approval: "amber",
  running: "blue",
  done: "green",
  failed: "red",
  skipped: "neutral",
};

const STEP_STATUS: Record<EngineeringStepStatus, string> = {
  pending: "pending",
  awaiting_approval: "waiting for you",
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

/** The task's steps in workflow order with their state, then the failure reason if there is one. */
export function TaskTimeline({ task }: { task: EngineeringTaskDetail }) {
  const rows = STEP_ORDER.flatMap((step) => {
    const s = task.steps.find((x) => x.step === step);
    return s ? [s] : [];
  });
  return (
    <div className="syn-eng-timeline">
      {rows.length > 0 && (
        <ol className="syn-eng-steps">
          {rows.map((s) => (
            <li key={s.id} className="syn-eng-step" data-state={s.status}>
              <span className="syn-eng-step-name">{stepLabel(s.step)}</span>
              <Chip tone={STEP_TONE[s.status]}>{STEP_STATUS[s.status]}</Chip>
            </li>
          ))}
        </ol>
      )}
      {task.failure && <p className="syn-eng-reason">{reasonLabel(task.failure)}</p>}
    </div>
  );
}
